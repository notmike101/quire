import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { shares, shareMessages } from '../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { MAX_SHARE_BYTES, wouldExceedCap } from '../src/api/headers.js';

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
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'second chunk AKIAABCDEFGHIJKLMNOP' }] },
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
    expect((share.redactions as Record<string, number>)['aws-access-key']).toBeGreaterThanOrEqual(1);
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
      body: JSON.stringify({ uploadId: 'f'.repeat(32), chunkSeq: 1, messages: [] }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('upload_id_mismatch');
    await db.execute(sql`delete from shares where token = ${tok}`);
  });

  it('404 for an append to an unknown token', async () => {
    const res = await app.request(`/api/chats/neverexisted/chunks`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ uploadId: 'a'.repeat(32), chunkSeq: 1, messages: [] }),
    });
    expect(res.status).toBe(404);
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
