import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { shares, shareMessages } from '../src/db/schema.js';
import { eq, inArray, sql } from 'drizzle-orm';
import { MAX_SHARE_BYTES, wouldExceedCap } from '../src/api/headers.js';
import { cleanupStaleUploads } from '../src/db/cleanup.js';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';
const config = { databaseUrl: url, apiKey: 'a'.repeat(64), unlockSecret: 'b'.repeat(64), port: 8787, webDist: '' };
const auth = { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' };

const session = {
  sessionId: 'sess_owner',
  title: 'Owner share',
  model: 'test-model',
  messages: [
    { role: 'user', parts: [{ type: 'text', text: 'use AKIAABCDEFGHIJKLMNOP please' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
  ],
};

let db: Db;
let app: ReturnType<typeof createApp>;
let token: string;

/** Response.json() is typed Promise<unknown> under @types/node (no DOM lib); cast to a plain object. */
const json = (r: Response): Promise<Record<string, any>> => r.json() as Promise<Record<string, any>>;

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
  app = createApp({ db, config });
});

afterAll(async () => {
  await db.execute(sql`delete from shares`);
  await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
});

describe('owner auth', () => {
  it('401 without an API key', async () => {
    const res = await app.request('/api/chats');
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe('unauthorized');
  });
  it('401 with a wrong API key', async () => {
    const res = await app.request('/api/chats', { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });
  it('401 for a wrong-LENGTH API key (no length oracle — L8)', async () => {
    // The old `a.length === b.length` gate short-circuited before timingSafeEqual
    // for a wrong-length key (faster) — a timing oracle an attacker could use to
    // binary-search the key's length. The digest compare always runs the full
    // 32-byte comparison, so a wrong-length key is just another 401.
    const res = await app.request('/api/chats', { headers: { authorization: `Bearer ${'a'.repeat(63)}` } });
    expect(res.status).toBe(401);
  });
});

describe('preview', () => {
  it('redacts and reports without persisting', async () => {
    const before = await db.select().from(shares);
    const res = await app.request('/api/chats/preview', { method: 'POST', headers: auth, body: JSON.stringify({ session, preset: 'strict' }) });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(JSON.stringify(body.messages)).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(body.summary['aws-access-key']).toBe(1);
    expect(body.messageCount).toBe(2);
    const after = await db.select().from(shares);
    expect(after).toHaveLength(before.length);
  });
});

describe('create', () => {
  it('creates a share and persists only redacted content', async () => {
    const res = await app.request('/api/chats', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ session, preset: 'strict', password: 'pw12345', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    token = body.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.url).toBe(`/chats/${token}`);
    const msgs = await db.select().from(shareMessages).where(eq(shareMessages.shareId, (await db.select().from(shares).where(eq(shares.token, token)))[0]!.id));
    expect(JSON.stringify(msgs)).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(JSON.stringify(msgs)).toContain('[REDACTED:aws-access-key]');
  });

  it('rejects an invalid body with 400', async () => {
    const res = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session: { title: '' } }) });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
  });

  it('rejects a zero-message session with 400 (Round 10 I1)', async () => {
    // A share with no messages is useless: chunk 0 has 0 rows, so the public
    // endpoint's count(distinct chunk_seq) < expectedChunks check 404s it FOREVER.
    // .min(1) on shapedSessionSchema.messages (matching chunkBodySchema) makes
    // this a 400 at the API boundary instead of a 404-forever share.
    const res = await app.request('/api/chats', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ session: { sessionId: 'sess_empty', title: 'Empty', messages: [] }, preset: 'strict' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
    // And nothing was persisted.
    const rows = await db.select().from(shares).where(eq(shares.sessionId, 'sess_empty'));
    expect(rows).toHaveLength(0);
  });

  it('stores a session whose tool output contains NUL/control chars (no 500, messages persisted)', async () => {
    // Regression: Postgres rejects NUL in jsonb; real ZCode tool output carries them.
    const nulSession = {
      sessionId: 'sess_nul',
      title: 'NUL session',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'run it' }] },
        { role: 'assistant', parts: [{ type: 'tool', callID: 'c1', tool: 'Bash', status: 'completed', input: { cmd: 'x\u0000y' }, output: 'bin\u0000\u001Bary' }] },
      ],
    };
    const res = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session: nulSession, preset: 'strict' }) });
    expect(res.status).toBe(201);
    const body = await json(res);
    const nulToken = body.token as string;
    expect(body.messageCount).toBe(2);
    const share = (await db.select().from(shares).where(eq(shares.token, nulToken)))[0]!;
    const msgs = await db.select().from(shareMessages).where(eq(shareMessages.shareId, share.id));
    expect(msgs).toHaveLength(2);
    // NUL/control chars stripped, surrounding content intact. `parts` is a jsonb array.
    const tool = (msgs.find((m) => m.seq === 2)!.parts as Array<{ input: { cmd: string }; output: string }>)[0]!;
    expect(tool.input.cmd).toBe('xy');
    expect(tool.output).toBe('binary');
    // Clean up this extra share so the list/delete tests below see only `token`.
    await db.execute(sql`delete from shares where token = ${nulToken}`);
  });

  it('creates a share with 11000 messages without hitting the 65535 bind-param limit (Round 9 B-F1)', async () => {
    // A single multi-row INSERT binds 6 params per row; 10924+ rows exceeds
    // Postgres's 65535-parameter cap and 500'd a VALID payload (the schema
    // allows up to 100_000 messages). The insert must be batched.
    const n = 11_000;
    const bigSession = {
      sessionId: 'sess_big',
      title: 'Big share',
      messages: Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        parts: [{ type: 'text', text: `m${i}` }],
      })),
    };
    const res = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session: bigSession, preset: 'strict' }) });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.messageCount).toBe(n);
    const share = (await db.select().from(shares).where(eq(shares.token, body.token)))[0]!;
    const [cnt] = await db.select({ n: sql<number>`count(*)::int` }).from(shareMessages).where(eq(shareMessages.shareId, share.id));
    expect(cnt?.n).toBe(n);
    await db.execute(sql`delete from shares where token = ${body.token}`);
  }, 60_000);
});

describe('list / get / patch / delete', () => {
  it('lists shares without content', async () => {
    const res = await app.request('/api/chats', { headers: auth });
    const body = await json(res);
    const mine = body.shares.find((s: { token: string }) => s.token === token);
    expect(mine).toBeDefined();
    expect(mine.hasPassword).toBe(true);
    expect(mine.revoked).toBe(false);
  });

  it('gets share meta', async () => {
    const res = await app.request(`/api/chats/${token}`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.title).toBe('Owner share');
    expect(body.hasPassword).toBe(true);
  });

  it('patch: change password, clear expiry, then revoke', async () => {
    let res = await app.request(`/api/chats/${token}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ password: 'newpass', expiresAt: null }) });
    expect(res.status).toBe(200);
    let share = (await db.select().from(shares).where(eq(shares.token, token)))[0]!;
    expect(share.expiresAt).toBeNull();
    expect(share.passwordHash).not.toBeNull();

    res = await app.request(`/api/chats/${token}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ revoke: true }) });
    expect(res.status).toBe(200);
    share = (await db.select().from(shares).where(eq(shares.token, token)))[0]!;
    expect(share.revokedAt).not.toBeNull();
  });

  it('delete soft-revokes; unknown token is 404', async () => {
    let res = await app.request('/api/chats/neverexisted', { method: 'DELETE', headers: auth });
    expect(res.status).toBe(404);
    res = await app.request(`/api/chats/${token}`, { method: 'DELETE', headers: auth });
    expect(res.status).toBe(200);
    // revoked share is invisible to the public API
    const pub = await app.request(`/api/public/chats/${token}`);
    expect(pub.status).toBe(404);
  });
});

describe('chunked upload', () => {
  it('create returns uploadId + chunkCount: 1', async () => {
    const res = await app.request('/api/chats', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ session, preset: 'strict' }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.uploadId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.chunkCount).toBe(1);
    await db.execute(sql`delete from shares where token = ${body.token}`);
  });

  it('appends a second chunk: messageCount/bytes accumulate, chunk_seq=1, redactions merge', async () => {
    // self-contained: create a fresh share, then append chunk 1 to it.
    // Round 7: declare expectedChunks=2 — chunk 1 is only valid within the
    // declared chunk budget (the server now enforces chunkSeq < expectedChunks).
    const createRes = await app.request('/api/chats', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ session, preset: 'strict', expectedChunks: 2 }),
    });
    const created = await json(createRes);
    const tok = created.token as string;
    const uploadId = created.uploadId as string;

    const chunk2 = {
      uploadId,
      chunkSeq: 1,
      // Two distinct AWS keys in chunk 1, so the cross-chunk total is unambiguous:
      // chunk 0 (the `session` fixture) has 1 aws-access-key, chunk 1 has 2.
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'second chunk AKIAABCDEFGHIJKLMNOP and AKIAQRSTUVWXYZ012345' }] },
      ],
    };
    const res = await app.request(`/api/chats/${tok}/chunks`, {
      method: 'POST', headers: auth, body: JSON.stringify(chunk2),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.messageCount).toBe(3); // 2 from create + 1 from chunk
    const share = (await db.select().from(shares).where(eq(shares.token, tok)))[0]!;
    const msgs = await db.select().from(shareMessages).where(eq(shareMessages.shareId, share.id));
    const inChunk1 = msgs.filter((m) => m.chunkSeq === 1);
    expect(inChunk1).toHaveLength(1);
    expect(JSON.stringify(msgs)).toContain('[REDACTED:aws-access-key]');
    expect(JSON.stringify(msgs)).not.toContain('AKIAABCDEFGHIJKLMNOP');
    // Round 10 (I2): the stored redactions must be the SUM across chunks
    // (1 from chunk 0 + 2 from chunk 1 = 3), NOT the last chunk's count (2).
    // The old `jsonb ||` shallow-merge kept the right operand on key conflict,
    // so this read 2 — an undercount the owner saw in their list/get.
    expect((share.redactions as Record<string, number>)['aws-access-key']).toBe(3);
    await db.execute(sql`delete from shares where token = ${tok}`);
  });

  it('re-reads redactions under FOR UPDATE so a concurrent chunk commit is not dropped (Round 11 S-2)', async () => {
    // The chunk handler reads the share row (incl. redactions) BEFORE its
    // transaction, then merges its chunk summary into that snapshot. If a
    // concurrent chunk commits between the read and the merge, the stale base
    // drops the concurrent chunk's counts. The fix re-reads the row under a
    // FOR UPDATE lock inside the tx, so the merge uses the current value.
    //
    // Deterministic interleaving: hold a FOR UPDATE lock on the share row on a
    // SEPARATE connection, fire the chunk upload (its tx blocks on the lock),
    // then raise redactions and commit. The fixed handler reads the raised value
    // (5) and merges 5 + 1 = 6; the stale-base bug would merge 1 + 1 = 2.
    const first = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session, expectedChunks: 2 }) });
    expect(first.status).toBe(201);
    const f = await json(first);
    const share = (await db.select().from(shares).where(eq(shares.token, f.token)))[0]!;
    // Chunk 0 (the `session` fixture) has exactly 1 aws-access-key.
    expect((share.redactions as Record<string, number>)['aws-access-key']).toBe(1);

    const hold = postgres(url, { max: 1 });
    let res: Response | undefined;
    try {
      await hold.unsafe('begin');
      await hold.unsafe('select * from shares where id = $1 for update', [share.id]);
      // Fire the chunk 1 upload (1 aws-access-key). It reads the stale
      // redactions pre-tx, then blocks on our lock inside its transaction.
      const chunk1 = app.request(`/api/chats/${f.token}/chunks`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ uploadId: f.uploadId, chunkSeq: 1, messages: [{ role: 'user', parts: [{ type: 'text', text: 'AKIAABCDEFGHIJKLMNOP' }] }] }),
      });
      // Settle: give the handler time to pass its pre-tx read and reach the
      // blocking lock. The lock — not this delay — guarantees the interleaving.
      await new Promise((r) => setTimeout(r, 200));
      // Simulate a concurrent chunk commit that raised the count to 5, then
      // release the lock. The handler must read THIS value, not its stale 1.
      await hold.unsafe("update shares set redactions = $1::jsonb where id = $2", ['{"aws-access-key": 5}', share.id]);
      await hold.unsafe('commit');
      res = await chunk1;
    } finally {
      await hold.end();
    }
    expect(res?.status).toBe(200);
    const after = (await db.select().from(shares).where(eq(shares.token, f.token)))[0]!;
    // Fix: 5 (locked current) + 1 (this chunk) = 6. Bug: 1 (stale) + 1 = 2.
    expect((after.redactions as Record<string, number>)['aws-access-key']).toBe(6);
    await db.execute(sql`delete from shares where token = ${f.token}`);
  });

  it('returns the chunk redaction summary in the chunk response (Round 9 C-F9)', async () => {
    // The CLI aggregates per-chunk summaries into the final Redactions line;
    // the chunk endpoint must return its own summary for that to work.
    const createRes = await app.request('/api/chats', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ session, preset: 'strict', expectedChunks: 2 }),
    });
    const created = await json(createRes);
    const tok = created.token as string;
    const res = await app.request(`/api/chats/${tok}/chunks`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        uploadId: created.uploadId,
        chunkSeq: 1,
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'AKIAABCDEFGHIJKLMNOP and AKIAQRSTUVWXYZ012345' }] }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.summary).toEqual({ 'aws-access-key': 2 });
    await db.execute(sql`delete from shares where token = ${tok}`);
  });

  it('rejects an append with a wrong uploadId (400)', async () => {
    const createRes = await app.request('/api/chats', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ session, preset: 'strict' }),
    });
    const created = await json(createRes);
    const tok = created.token as string;
    const res = await app.request(`/api/chats/${tok}/chunks`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ uploadId: 'f'.repeat(32), chunkSeq: 1, messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('upload_id_mismatch');
    await db.execute(sql`delete from shares where token = ${tok}`);
  });

  it('404 for an append to an unknown token', async () => {
    const res = await app.request(`/api/chats/neverexisted/chunks`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ uploadId: 'a'.repeat(32), chunkSeq: 1, messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects an empty chunk with 400 (Round 9 B-F7)', async () => {
    // An empty chunk is a no-op that used to be accepted, and a duplicate
    // empty chunk was NOT a 409 (the dup check counts rows, and 0 rows look
    // like "not uploaded"). .min(1) on the schema makes both a 400.
    const first = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session, expectedChunks: 2 }) });
    const f = await json(first);
    expect(first.status).toBe(201);
    const res = await app.request(`/api/chats/${f.token}/chunks`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ uploadId: f.uploadId, chunkSeq: 1, messages: [] }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
    await db.execute(sql`delete from shares where token = ${f.token}`);
  });
});

describe('per-share cap + contiguous chunks (Chain B)', () => {
  it('wouldExceedCap compares against the 1 GB cap', () => {
    expect(MAX_SHARE_BYTES).toBe(1_073_741_824);
    expect(wouldExceedCap(0, MAX_SHARE_BYTES)).toBe(false); // exactly at cap
    expect(wouldExceedCap(0, MAX_SHARE_BYTES + 1)).toBe(true); // one byte over
    expect(wouldExceedCap(MAX_SHARE_BYTES - 10, 11)).toBe(true);
    expect(wouldExceedCap(1_000_000, 2_000_000)).toBe(false);
  });

  it('rejects a duplicate chunkSeq with 409', async () => {
    const first = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session }) });
    const f = await json(first);
    expect(first.status).toBe(201);
    // chunk 0 already exists (seeded by create) -> duplicate
    const dup = await app.request(`/api/chats/${f.token}/chunks`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ uploadId: f.uploadId, chunkSeq: 0, messages: [{ role: 'user', parts: [{ type: 'text', text: 'dup' }] }] }),
    });
    expect(dup.status).toBe(409);
    expect((await json(dup)).error.code).toBe('chunk_exists');
    await db.execute(sql`delete from shares where token = ${f.token}`);
  });

  it('rejects a non-contiguous chunkSeq with 400', async () => {
    // Round 7: declare expectedChunks=3 so chunkSeq=2 is within the declared
    // budget (the bound check chunkSeq < expectedChunks passes) and the
    // contiguity check (maxSeq 0 expects 1) is what fires.
    const first = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session, expectedChunks: 3 }) });
    const f = await json(first);
    expect(first.status).toBe(201);
    // chunk 0 exists, so the next valid seq is 1; skipping to 2 is out-of-order
    const skip = await app.request(`/api/chats/${f.token}/chunks`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ uploadId: f.uploadId, chunkSeq: 2, messages: [{ role: 'user', parts: [{ type: 'text', text: 'skip' }] }] }),
    });
    expect(skip.status).toBe(400);
    expect((await json(skip)).error.code).toBe('chunk_out_of_order');
    await db.execute(sql`delete from shares where token = ${f.token}`);
  });

  it('recomputes messageCount from the rows after a chunk', async () => {
    // Round 7: declare expectedChunks=2 so chunkSeq=1 is within the budget.
    const first = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session, expectedChunks: 2 }) });
    const f = await json(first);
    expect(first.status).toBe(201);
    const before = f.messageCount as number;
    const chunk = await app.request(`/api/chats/${f.token}/chunks`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ uploadId: f.uploadId, chunkSeq: 1, messages: [{ role: 'user', parts: [{ type: 'text', text: 'extra' }] }] }),
    });
    expect(chunk.status).toBe(200);
    const c = await json(chunk);
    expect(c.messageCount).toBe(before + 1);
    await db.execute(sql`delete from shares where token = ${f.token}`);
  });

  it('rejects chunkSeq >= expectedChunks with 400 (Round 7 bound)', async () => {
    // Default expectedChunks=1: only chunk 0 (seeded by create) is valid, so
    // chunkSeq=1 is out of the declared budget and must be rejected by the bound
    // check (not the contiguity check) — error code 'validation'.
    const first = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session }) });
    const f = await json(first);
    expect(first.status).toBe(201);
    const over = await app.request(`/api/chats/${f.token}/chunks`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ uploadId: f.uploadId, chunkSeq: 1, messages: [{ role: 'user', parts: [{ type: 'text', text: 'over' }] }] }),
    });
    expect(over.status).toBe(400);
    expect((await json(over)).error.code).toBe('validation');
    await db.execute(sql`delete from shares where token = ${f.token}`);
  });

  it('concurrent duplicate chunkSeq -> one 200, one 409 (not 500) (Round 7)', async () => {
    // Two identical chunk uploads race: whichever loses the (share_id, chunk_seq,
    // seq) PK race used to surface as an unhandled 500; now it is mapped to the
    // same 409 the fast path returns. Either the fast path (the loser sees the
    // winner's committed seq) or the 23505 handler (both INSERTs race) can be the
    // one that rejects — the contract is exactly one 200 and one 409.
    const first = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session, expectedChunks: 2 }) });
    const f = await json(first);
    expect(first.status).toBe(201);
    const body = JSON.stringify({ uploadId: f.uploadId, chunkSeq: 1, messages: [{ role: 'user', parts: [{ type: 'text', text: 'race' }] }] });
    const [a, b] = await Promise.all([
      app.request(`/api/chats/${f.token}/chunks`, { method: 'POST', headers: auth, body }),
      app.request(`/api/chats/${f.token}/chunks`, { method: 'POST', headers: auth, body }),
    ]);
    const codes = [a.status, b.status].sort((x, y) => x - y);
    expect(codes).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect((await json(loser)).error.code).toBe('chunk_exists');
    await db.execute(sql`delete from shares where token = ${f.token}`);
  });

  it('enforces the per-share cap on a chunk (413 when it would cross 1 GB) (Round 7)', async () => {
    // Simulate a share already near the 1 GB cap, then a chunk that would cross
    // it. The fast-path wouldExceedCap() rejects it with 413 (the atomic SQL cap
    // in the UPDATE's WHERE clause is the concurrent-overshoot backstop, covered
    // by the same 413 contract).
    const first = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session, expectedChunks: 2 }) });
    const f = await json(first);
    expect(first.status).toBe(201);
    await db.execute(sql`update shares set bytes = ${MAX_SHARE_BYTES - 5} where token = ${f.token}`);
    const chunk = await app.request(`/api/chats/${f.token}/chunks`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ uploadId: f.uploadId, chunkSeq: 1, messages: [{ role: 'user', parts: [{ type: 'text', text: 'cross' }] }] }),
    });
    expect(chunk.status).toBe(413);
    expect((await json(chunk)).error.code).toBe('too_large');
    await db.execute(sql`delete from shares where token = ${f.token}`);
  });
});

describe('stale incomplete-upload cleanup (Round 9 B-F6)', () => {
  it('hard-deletes incomplete uploads older than 24h; keeps fresh, complete, and revoked shares', async () => {
    // incomplete + old -> deleted (with its partial messages via FK cascade)
    const staleRes = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session, preset: 'strict', expectedChunks: 2 }) });
    const stale = await json(staleRes);
    expect(staleRes.status).toBe(201);
    const staleShare = (await db.select().from(shares).where(eq(shares.token, stale.token)))[0]!;
    await db.execute(sql`update shares set created_at = now() - interval '25 hours' where token = ${stale.token}`);
    // incomplete + fresh -> kept (the upload may still be in flight)
    const freshRes = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session, preset: 'strict', expectedChunks: 2 }) });
    const fresh = await json(freshRes);
    // complete + old -> kept (a finished share is never reclaimed by this job)
    const doneRes = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session, preset: 'strict' }) });
    const done = await json(doneRes);
    await db.execute(sql`update shares set created_at = now() - interval '25 hours' where token = ${done.token}`);
    // revoked + old -> kept (owner-visible; revocation is the owner's delete)
    const revRes = await app.request('/api/chats', { method: 'POST', headers: auth, body: JSON.stringify({ session, preset: 'strict' }) });
    const rev = await json(revRes);
    await app.request(`/api/chats/${rev.token}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ revoke: true }) });
    await db.execute(sql`update shares set created_at = now() - interval '25 hours' where token = ${rev.token}`);

    const n = await cleanupStaleUploads(db);
    expect(n).toBe(1);
    const rows = await db.select().from(shares).where(eq(shares.token, stale.token));
    expect(rows).toHaveLength(0);
    const leftover = await db.select().from(shareMessages).where(eq(shareMessages.shareId, staleShare.id));
    expect(leftover).toHaveLength(0);
    const kept = await db.select().from(shares).where(inArray(shares.token, [stale.token, fresh.token, done.token, rev.token]));
    expect(kept.map((s) => s.token).sort()).toEqual([done.token, fresh.token, rev.token].sort());
    await db.execute(sql`delete from shares where token in (${done.token}, ${fresh.token}, ${rev.token})`);
  });
});
