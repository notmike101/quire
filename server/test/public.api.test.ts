import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { shares, shareMessages } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { hashPassword } from '../src/security/password.js';
import { RateLimiter, IpWindow } from '../src/security/rate-limit.js';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';
const config = {
  databaseUrl: url,
  apiKey: 'a'.repeat(64),
  unlockSecret: 'b'.repeat(64),
  port: 8787,
};

let db: Db;
let app: ReturnType<typeof createApp>;

/** Response.json() is typed Promise<unknown> under @types/node (no DOM lib); cast to a plain object. */
const json = (r: Response): Promise<Record<string, any>> => r.json() as Promise<Record<string, any>>;

async function seedShare(token: string, opts: { password?: string; expiresAt?: Date; revoked?: boolean; messages?: number } = {}) {
  const n = opts.messages ?? 120;
  const [share] = await db.insert(shares).values({
    token,
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
    expect(p1.nextCursor).toBe(50);
    const p2 = await json(await app.request('/api/public/chats/page1?limit=50&cursor=50'));
    expect(p2.messages[0].seq).toBe(51);
    expect(p2.nextCursor).toBe(100);
    const p3 = await json(await app.request('/api/public/chats/page1?limit=50&cursor=100'));
    expect(p3.messages).toHaveLength(20);
    expect(p3.nextCursor).toBeNull();
    expect(p1.meta.title).toBe('Share page1');
    expect(p1.meta.messageCount).toBe(120);
  });

  it('limit is clamped to 200 and invalid cursors restart at 0', async () => {
    await seedShare('page2', { messages: 300 });
    const res = await json(await app.request('/api/public/chats/page2?limit=9999&cursor=notanumber'));
    expect(res.messages).toHaveLength(200);
    expect(res.messages[0].seq).toBe(1);
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

  it('400 no_password when the share has no password', async () => {
    await seedShare('nopw');
    const res = await app.request('/api/public/chats/nopw/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('no_password');
  });
});
