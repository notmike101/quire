import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { shares, shareMessages, unlockLockouts } from '../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { hashPassword } from '../src/security/password.js';
import { generateUploadId } from '../src/security/token.js';
import { RateLimiter, IpWindow } from '../src/security/rate-limit.js';
import { clientIp } from '../src/api/public.js';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';
const config = {
  databaseUrl: url,
  apiKey: 'a'.repeat(64),
  unlockSecret: 'b'.repeat(64),
  port: 8787,
  webDist: '',
};

let db: Db;
let app: ReturnType<typeof createApp>;

/** Response.json() is typed Promise<unknown> under @types/node (no DOM lib); cast to a plain object. */
const json = (r: Response): Promise<Record<string, any>> => r.json() as Promise<Record<string, any>>;

async function seedShare(token: string, opts: { password?: string; expiresAt?: Date; revoked?: boolean; messages?: number } = {}) {
  const n = opts.messages ?? 120;
  const [share] = await db.insert(shares).values({
    token,
    uploadId: generateUploadId(),
    sessionId: `sess_${token}`,
    title: `Share ${token}`,
    expiresAt: opts.expiresAt,
    passwordHash: opts.password ? await hashPassword(opts.password) : null,
    revokedAt: opts.revoked ? new Date() : null,
    messageCount: n,
  }).returning();
  if (!share) throw new Error('seed insert returned no row');
  const rows = Array.from({ length: n }, (_, i) => ({
    shareId: share.id,
    seq: i + 1,
    role: i % 2 === 0 ? 'user' : ('assistant' as const),
    parts: [{ type: 'text', text: `message ${i + 1}` }],
  }));
  await db.insert(shareMessages).values(rows);
  return share;
}

async function seedTwoChunkShare(token: string, perChunk: number) {
  const [share] = await db.insert(shares).values({
    token, uploadId: 'b'.repeat(32), sessionId: `sess_${token}`, title: `Share ${token}`,
    messageCount: perChunk * 2,
  }).returning();
  if (!share) throw new Error('seed insert returned no row');
  const rows: Array<{ shareId: string; chunkSeq: number; seq: number; role: 'user' | 'assistant'; parts: unknown[] }> = [];
  for (const chunkSeq of [0, 1]) {
    for (let i = 0; i < perChunk; i++) {
      rows.push({
        shareId: share.id, chunkSeq, seq: i + 1,
        role: i % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `c${chunkSeq}m${i + 1}` }],
      });
    }
  }
  await db.insert(shareMessages).values(rows);
  return share;
}

beforeAll(async () => {
  db = makeDb(url);
  // postgres.js console.logs NOTICE lines by default; migrateDb against the
  // already-migrated test container emits two ("schema/relation already
  // exists, skipping"). Silence them so this file's output stays clean.
  const origLog = console.log;
  console.log = () => {};
  try {
    await migrateDb(db);
  } finally {
    console.log = origLog;
  }
  await db.execute(sql`delete from shares`);
  app = createApp({ db, config, ipWindow: new IpWindow(1000, 60_000) });
});

afterAll(async () => {
  await db.execute(sql`delete from shares`);
  await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
});

describe('public content endpoint', () => {
  it('404 not_found for an unknown token', async () => {
    const res = await app.request('/api/public/chats/doesnotexist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('404 not_found for a revoked token, byte-identical to unknown', async () => {
    await seedShare('revoked1', { revoked: true });
    const a = await app.request('/api/public/chats/revoked1');
    const b = await app.request('/api/public/chats/neverexisted');
    expect(a.status).toBe(404);
    expect(await a.text()).toBe(await b.text());
  });

  it('410 expired', async () => {
    await seedShare('expired1', { expiresAt: new Date(Date.now() - 1000) });
    const res = await app.request('/api/public/chats/expired1');
    expect(res.status).toBe(410);
    expect((await json(res)).error.code).toBe('expired');
  });

  it('paginates 120 messages at default limit 50', async () => {
    await seedShare('page1', { messages: 120 });
    const p1 = await json(await app.request('/api/public/chats/page1'));
    expect(p1.messages).toHaveLength(50);
    expect(p1.messages[0].seq).toBe(1);
    expect(p1.nextCursor).toBe('0:50');
    const p2 = await json(await app.request('/api/public/chats/page1?limit=50&cursor=0:50'));
    expect(p2.messages[0].seq).toBe(51);
    expect(p2.nextCursor).toBe('0:100');
    const p3 = await json(await app.request('/api/public/chats/page1?limit=50&cursor=0:100'));
    expect(p3.messages).toHaveLength(20);
    expect(p3.nextCursor).toBeNull();
    expect(p1.meta.title).toBe('Share page1');
    expect(p1.meta.messageCount).toBe(120);
    // The first page returns the full-share user index (60 user messages, odd
    // seqs 1..119); continuation pages omit it.
    expect(p1.userIndex).toHaveLength(60);
    expect(p1.userIndex[0]).toEqual({ chunkSeq: 0, seq: 1, preview: 'message 1' });
    expect(p2.userIndex).toBeUndefined();
  });

  it('limit is clamped to 200 and invalid cursors restart at 0', async () => {
    await seedShare('page2', { messages: 300 });
    const res = await json(await app.request('/api/public/chats/page2?limit=9999&cursor=notanumber'));
    expect(res.messages).toHaveLength(200);
    expect(res.messages[0].seq).toBe(1);
  });

  it('clamps an oversized cursor to int32 instead of 500 (Round 9 B-F3)', async () => {
    // Number.parseInt('99999999999999999999') is 1e20 and Number.isInteger(1e20)
    // is TRUE, so the old check passed it through to SQL, where the int4 cast
    // overflowed and the request 500'd. Clamping to int32 makes it a valid
    // (empty) page.
    await seedShare('cur1', { messages: 10 });
    const res = await app.request('/api/public/chats/cur1?cursor=99999999999999999999:99999999999999999999');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.messages).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it('caps the first-page userIndex at MAX_RAIL_USER_ENTRIES (Round 6)', async () => {
    // A share with more user messages than the rail cap must return only the
    // first MAX_RAIL_USER_ENTRIES index entries (bounds the query + the DOM).
    const n = 2005;
    const [share] = await db.insert(shares).values({
      token: 'railcap', uploadId: 'd'.repeat(32), sessionId: 'sess_railcap', title: 'Rail cap', messageCount: n,
    }).returning();
    if (!share) throw new Error('seed insert returned no row');
    const rows = Array.from({ length: n }, (_, i) => ({
      shareId: share.id, chunkSeq: 0, seq: i + 1, role: 'user' as const, parts: [{ type: 'text', text: `u${i + 1}` }],
    }));
    await db.insert(shareMessages).values(rows);
    const res = await json(await app.request('/api/public/chats/railcap'));
    expect(res.userIndex).toHaveLength(2000);
    expect(res.userIndex[0]).toEqual({ chunkSeq: 0, seq: 1, preview: 'u1' });
    expect(res.userIndex[1999]).toEqual({ chunkSeq: 0, seq: 2000, preview: 'u2000' });
    await db.execute(sql`delete from shares where token = 'railcap'`);
  });

  it('429 when the per-IP window is exhausted', async () => {
    const tiny = createApp({ db, config, ipWindow: new IpWindow(3, 60_000) });
    await seedShare('ratelimited');
    for (let i = 0; i < 3; i++) expect((await tiny.request('/api/public/chats/ratelimited')).status).toBe(200);
    const res = await tiny.request('/api/public/chats/ratelimited');
    expect(res.status).toBe(429);
    expect((await json(res)).error.code).toBe('rate_limited');
  });
});

describe('unlock endpoint', () => {
  it('full password flow: 401 -> bad_password -> unlock -> cookie grants access', async () => {
    await seedShare('pw1', { password: 's3cret!' });
    expect((await app.request('/api/public/chats/pw1')).status).toBe(401);

    const bad = await app.request('/api/public/chats/pw1/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }),
    });
    expect(bad.status).toBe(401);
    expect((await json(bad)).error.code).toBe('bad_password');

    const good = await app.request('/api/public/chats/pw1/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 's3cret!' }),
    });
    expect(good.status).toBe(200);
    const setCookie = good.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('quire_unlock_pw1=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    const value = setCookie.split(';')[0]!;

    const withCookie = await app.request('/api/public/chats/pw1', { headers: { cookie: value } });
    expect(withCookie.status).toBe(200);
  });

  it('a cookie for one token does not unlock another', async () => {
    await seedShare('pw2a', { password: 'same' });
    await seedShare('pw2b', { password: 'same' });
    const good = await app.request('/api/public/chats/pw2a/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'same' }),
    });
    const value = (good.headers.get('set-cookie') ?? '').split(';')[0]!;
    const res = await app.request('/api/public/chats/pw2b', { headers: { cookie: value } });
    expect(res.status).toBe(401);
  });

  it('429 after 5 failed unlocks, keyed per (token, IP)', async () => {
    const rl = new RateLimiter();
    const locked = createApp({ db, config, unlockLimiter: rl, ipWindow: new IpWindow(1000, 60_000) });
    await seedShare('pw3', { password: 'right' });
    for (let i = 0; i < 5; i++) {
      const res = await locked.request('/api/public/chats/pw3/unlock', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }),
      });
      expect(res.status).toBe(401);
    }
    // even the right password is refused while locked
    const res = await locked.request('/api/public/chats/pw3/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'right' }),
    });
    expect(res.status).toBe(429);
  });

  it('429 after the per-TOKEN failure threshold even when the per-IP threshold is not hit (IP-rotation defense)', async () => {
    // Round 6: the per-IP limiter is set to never lock (1000) and the per-token
    // limiter locks after 5 total failures. Every request comes from the same
    // test IP ('unknown' in the Hono harness), so the per-IP counter never
    // reaches 1000; the per-token counter accumulates across "IPs" and locks the
    // token. This is the defense against an IP-rotating brute-forer.
    const perIp = new RateLimiter(1000, 15 * 60 * 1000);
    const perToken = new RateLimiter(5, 15 * 60 * 1000);
    const locked = createApp({ db, config, unlockLimiter: perIp, tokenLimiter: perToken, ipWindow: new IpWindow(1000, 60_000) });
    await seedShare('pw4', { password: 'right' });
    for (let i = 0; i < 5; i++) {
      const res = await locked.request('/api/public/chats/pw4/unlock', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }),
      });
      expect(res.status).toBe(401);
    }
    // Per-IP counter is at 5 (< 1000, not locked); per-token counter hit 5 ->
    // the token is locked. Even the right password is refused.
    const res = await locked.request('/api/public/chats/pw4/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'right' }),
    });
    expect(res.status).toBe(429);
  });

  it('production wiring: per-token lockout trips at 25 total failures, not the store default of 5', async () => {
    // Round 6 regression: when a Postgres store is wired into the limiter, the
    // limiter delegates isLocked/recordFailure/reset entirely to the store, so
    // the STORE's maxFails is the source of truth — the threshold passed to the
    // RateLimiter constructor alone is silently ignored. app.ts must therefore
    // pass the threshold to the store. This test exercises the REAL production
    // wiring (no injected limiters) with XFF-simulated distinct IPs. Under the
    // old bug (store default 5), failures 6-20 would return 429 and the 401
    // assertions below fail; under the fix, 25 total failures are required.
    // Round 7: lockout keys are namespaced (tok: / ip:) so the per-token row
    // is 'tok:pw5' and the per-IP rows are 'ip:pw5:<ip>'.
    await db.execute(sql`delete from unlock_lockouts where key = 'tok:pw5' or key like 'ip:pw5:%'`);
    const wired = createApp({ db, config: { ...config, trustProxy: true } });
    await seedShare('pw5', { password: 'right' });
    const post = (ip: string, password: string) =>
      wired.request('/api/public/chats/pw5/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ password }),
      });
    // 4 IPs x 5 failures: each per-IP key locks at 5 (intended), but the
    // per-token key must accumulate all 20 without locking.
    for (let ip = 1; ip <= 4; ip++) {
      for (let f = 0; f < 5; f++) {
        const res = await post(`10.0.0.${ip}`, 'wrong');
        expect(res.status).toBe(401);
      }
    }
    const [mid] = await db.select().from(unlockLockouts).where(eq(unlockLockouts.key, 'tok:pw5')).limit(1);
    expect(mid?.count).toBe(20);
    expect(mid?.lockedUntil).toBeNull();
    // The 5th IP pushes the token counter to 25 -> the token locks.
    for (let f = 0; f < 5; f++) {
      const res = await post('10.0.0.5', 'wrong');
      expect(res.status).toBe(401);
    }
    // Even the right password is refused while the token is locked.
    const res = await post('10.0.0.6', 'right');
    expect(res.status).toBe(429);
    await db.execute(sql`delete from shares where token = 'pw5'`);
    await db.execute(sql`delete from unlock_lockouts where key = 'tok:pw5' or key like 'ip:pw5:%'`);
  }, 30_000);

  it('404 (no liveness oracle) when the share has no password', async () => {
    // A live share without a password must not reveal its liveness: the unlock
    // endpoint returns the same 404 as an unknown token (no_password would let
    // an attacker separate live from dead tokens).
    await seedShare('nopw');
    const res = await app.request('/api/public/chats/nopw/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }),
    });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('not_found');
  });

  it('429 when the per-IP window is exhausted on the unlock endpoint (Round 11 S-1)', async () => {
    // The unlock endpoint's 400/404/410 paths (malformed body, unknown token,
    // expired) previously had NO volume limiter — only the 401 wrong-password
    // path was failure-limited. An attacker could fire unbounded malformed-body
    // or unknown-token unlock requests (each a full share DB lookup + a full
    // JSON parse of up to a 20 MB body) for CPU/DB DoS and unlimited token
    // probing. The ipWindow gate (shared with the content endpoint) now bounds
    // total per-IP volume on unlock too, so these paths 429 once the window is
    // exhausted.
    const tiny = createApp({ db, config, ipWindow: new IpWindow(3, 60_000) });
    // 404 path: unknown tokens. Three pass, the fourth is volume-limited.
    for (let i = 0; i < 3; i++) {
      const res = await tiny.request('/api/public/chats/nope/unlock', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }),
      });
      expect(res.status).toBe(404);
    }
    const res = await tiny.request('/api/public/chats/nope/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }),
    });
    expect(res.status).toBe(429);
    expect((await json(res)).error.code).toBe('rate_limited');
  });
});

describe('completion gate (Chain E)', () => {
  it('returns 404 while a chunked share is incomplete, 200 once complete', async () => {
    // Create a share expecting 2 chunks but only send chunk 0.
    const first = await app.request('/api/chats', {
      method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        session: { sessionId: 's_e', title: 'E', messages: [{ role: 'user', parts: [{ type: 'text', text: 'c0' }] }] },
        expectedChunks: 2,
      }),
    });
    const f = await json(first);
    expect(first.status).toBe(201);
    // Incomplete: only chunk 0 has arrived, 2 expected -> byte-identical 404.
    const incomplete = await app.request(`/api/public/chats/${f.token}`);
    expect(incomplete.status).toBe(404);
    const unknown = await app.request('/api/public/chats/neverexisted');
    expect(await incomplete.text()).toBe(await unknown.text());
    // Complete it.
    const second = await app.request(`/api/chats/${f.token}/chunks`, {
      method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: f.uploadId, chunkSeq: 1, messages: [{ role: 'user', parts: [{ type: 'text', text: 'c1' }] }] }),
    });
    expect(second.status).toBe(200);
    const complete = await app.request(`/api/public/chats/${f.token}`);
    expect(complete.status).toBe(200);
    await db.execute(sql`delete from shares where token = ${f.token}`);
  });

  it('completes a 3-chunk share only when the last expected chunk exists (Round 11 S-3)', async () => {
    // Regression guard for the point-lookup completion check (replacing
    // count(distinct chunk_seq)): completeness is "chunk (expectedChunks - 1)
    // exists" because chunks arrive contiguously (chunkSeq = maxSeq + 1) and
    // are written atomically. With 2 of 3 chunks present, chunk 2 is absent ->
    // 404; after chunk 2 arrives, it exists -> 200.
    const first = await app.request('/api/chats', {
      method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        session: { sessionId: 's_e3', title: 'E3', messages: [{ role: 'user', parts: [{ type: 'text', text: 'c0' }] }] },
        expectedChunks: 3,
      }),
    });
    expect(first.status).toBe(201);
    const f = await json(first);
    const postChunk = (chunkSeq: number) => app.request(`/api/chats/${f.token}/chunks`, {
      method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: f.uploadId, chunkSeq, messages: [{ role: 'user', parts: [{ type: 'text', text: `c${chunkSeq}` }] }] }),
    });
    expect((await postChunk(1)).status).toBe(200);
    // 2 of 3 present (last expected chunk 2 absent) -> still hidden.
    expect((await app.request(`/api/public/chats/${f.token}`)).status).toBe(404);
    expect((await postChunk(2)).status).toBe(200);
    // 3 of 3 present (last expected chunk 2 exists) -> served.
    expect((await app.request(`/api/public/chats/${f.token}`)).status).toBe(200);
    await db.execute(sql`delete from shares where token = ${f.token}`);
  });

  it('serves a single-request share immediately (expectedChunks defaults to 1)', async () => {
    const first = await app.request('/api/chats', {
      method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session: { sessionId: 's_e1', title: 'E1', messages: [{ role: 'user', parts: [{ type: 'text', text: 'only' }] }] } }),
    });
    expect(first.status).toBe(201);
    const f = await json(first);
    const res = await app.request(`/api/public/chats/${f.token}`);
    expect(res.status).toBe(200);
    await db.execute(sql`delete from shares where token = ${f.token}`);
  });
});

describe('rail preview (Chain B)', () => {
  it('computes the first-page userIndex preview server-side (collapses whitespace, caps at 80, first text part)', async () => {
    // A user message whose first text part has internal whitespace and a long
    // tail, plus a non-text part before the text part (must be skipped).
    const longText = 'x'.repeat(120);
    const wsText = '  hello   world  \n  again  ';
    const [share] = await db.insert(shares).values({
      token: 'railprev', uploadId: 'c'.repeat(32), sessionId: 'sess_railprev', title: 'Rail preview',
      messageCount: 3,
    }).returning();
    if (!share) throw new Error('seed insert returned no row');
    await db.insert(shareMessages).values([
      { shareId: share.id, chunkSeq: 0, seq: 1, role: 'user', parts: [{ type: 'tool', tool: 'Read' }, { type: 'text', text: wsText }] },
      { shareId: share.id, chunkSeq: 0, seq: 2, role: 'assistant', parts: [{ type: 'text', text: 'a' }] },
      { shareId: share.id, chunkSeq: 0, seq: 3, role: 'user', parts: [{ type: 'text', text: longText }] },
    ]);
    const res = await json(await app.request('/api/public/chats/railprev'));
    // Only the two user messages appear in the index, in order.
    expect(res.userIndex).toHaveLength(2);
    // Whitespace collapsed to single spaces and trimmed; capped at 80.
    expect(res.userIndex[0]).toEqual({ chunkSeq: 0, seq: 1, preview: 'hello world again' });
    expect(res.userIndex[1]).toEqual({ chunkSeq: 0, seq: 3, preview: 'x'.repeat(80) });
    await db.execute(sql`delete from shares where token = 'railprev'`);
  });
});

describe('clientIp (Chain C + Round 9 B-F2)', () => {
  // getConnInfo reads c.env.incoming.socket.remoteAddress; stub that shape so
  // the socket fallback is exercised without a real socket.
  function fakeCtx(headers: Record<string, string>, socketAddr = '203.0.113.7') {
    return {
      req: { header: (n: string) => headers[n.toLowerCase()] },
      env: { incoming: { socket: { remoteAddress: socketAddr, remotePort: 1234, remoteFamily: 'IPv4' } } },
    } as any;
  }
  it('uses the RIGHTMOST XFF hop when trustProxy — the entry the immediate proxy wrote, which the client cannot control', () => {
    // Append-style proxy (Cloudflare): the client may prepend spoofed entries,
    // but the rightmost one is what the trusted proxy appended.
    const c = fakeCtx({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7' }, '127.0.0.1');
    expect(clientIp(c, true)).toBe('7.7.7.7');
  });
  it('a single-entry XFF (overwrite-style proxy) is used as-is', () => {
    const c = fakeCtx({ 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1');
    expect(clientIp(c, true)).toBe('203.0.113.9');
  });
  it('falls back to the socket address when the rightmost XFF hop is malformed', () => {
    const c = fakeCtx({ 'x-forwarded-for': '10.0.0.1, not-an-ip' }, '198.51.100.4');
    expect(clientIp(c, true)).toBe('198.51.100.4');
  });
  it('falls back to x-real-ip when XFF is absent but x-real-ip is well-formed', () => {
    const c = fakeCtx({ 'x-real-ip': '198.51.100.9' }, '127.0.0.1');
    expect(clientIp(c, true)).toBe('198.51.100.9');
  });
  it('ignores XFF and x-real-ip entirely when trustProxy is false', () => {
    const c = fakeCtx({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.8' }, '198.51.100.4');
    expect(clientIp(c, false)).toBe('198.51.100.4');
  });
});

describe('chunked pagination', () => {
  it('pages across a chunk boundary in (chunk_seq, seq) order', async () => {
    await seedTwoChunkShare('chunks1', 25); // chunk0: seq1..25, chunk1: seq1..25
    // limit 20 -> first page is chunk0 seq1..20, cursor "0:20"
    const p1 = await json(await app.request('/api/public/chats/chunks1?limit=20'));
    expect(p1.messages).toHaveLength(20);
    expect(p1.messages[0]).toMatchObject({ chunkSeq: 0, seq: 1 });
    expect(p1.messages[19]).toMatchObject({ chunkSeq: 0, seq: 20 });
    expect(p1.userIndex).toContainEqual({ chunkSeq: 0, seq: 1, preview: 'c0m1' });
    expect(p1.userIndex).toContainEqual({ chunkSeq: 1, seq: 1, preview: 'c1m1' });
    expect(p1.nextCursor).toBe('0:20');
    // next page: chunk0 seq21..25 (5 rows) + chunk1 seq1..15 (15 rows) = 20
    const p2 = await json(await app.request('/api/public/chats/chunks1?limit=20&cursor=0:20'));
    expect(p2.messages).toHaveLength(20);
    expect(p2.messages[0]).toMatchObject({ chunkSeq: 0, seq: 21 });
    expect(p2.messages[4]).toMatchObject({ chunkSeq: 0, seq: 25 });
    expect(p2.messages[5]).toMatchObject({ chunkSeq: 1, seq: 1 });
    expect(p2.nextCursor).toBe('1:15');
    // final page: chunk1 seq16..25 = 10 rows (short), no next cursor
    const p3 = await json(await app.request('/api/public/chats/chunks1?limit=20&cursor=1:15'));
    expect(p3.messages).toHaveLength(10);
    expect(p3.messages[0]).toMatchObject({ chunkSeq: 1, seq: 16 });
    expect(p3.nextCursor).toBeNull();
  });
});
