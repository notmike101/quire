import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { sharesV2, shareSourceChunksV2, shareBlobsV2 } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';
const config = { databaseUrl: url, apiKey: 'a'.repeat(64), unlockSecret: 'b'.repeat(64), port: 8787, webDist: '' };
const auth = { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' };

// Test-only material: one random content key for the whole file (never
// persisted or logged by the server; asserted absent from stored rows below).
const contentKey = randomBytes(32).toString('base64url');

let db: Db;
let app: Hono;

/** Response.json() is typed Promise<unknown> under @types/node (no DOM lib); cast to a plain object. */
const json = (r: Response): Promise<Record<string, any>> => r.json() as Promise<Record<string, any>>;

const createBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: 'quire-share-v1',
  uploadRequestId: 'req-1',
  preset: 'strict',
  sourceChunkCount: 1,
  contentKey,
  session: {
    sessionId: 'sess_v2',
    title: 'v2 owner share',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'use AKIAABCDEFGHIJKLMNOP please' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
    ],
  },
  ...over,
});

beforeAll(async () => {
  db = makeDb(url);
  // postgres.js console.logs NOTICE lines; migrateDb against an already-migrated
  // container emits "already exists, skipping". Silence so output stays clean.
  const origLog = console.log;
  console.log = () => {};
  try {
    await migrateDb(db);
  } finally {
    console.log = origLog;
  }
  await db.execute(sql`delete from share_blobs_v2; delete from share_source_chunks_v2; delete from shares_v2`);
  app = createApp({ db, config });
});

beforeEach(async () => {
  await db.execute(sql`delete from share_blobs_v2; delete from share_source_chunks_v2; delete from shares_v2`);
});

afterAll(async () => {
  await db.execute(sql`delete from share_blobs_v2; delete from share_source_chunks_v2; delete from shares_v2`);
  const withClient = db as unknown as { $client?: { end(): Promise<void> } };
  await withClient.$client?.end();
});

describe('owner-v2 auth', () => {
  it('401 without an API key', async () => {
    const res = await app.request('/api/v2/shares', { method: 'POST', body: JSON.stringify(createBody()) });
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe('unauthorized');
  });
  it('401 with a wrong API key', async () => {
    const res = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    });
    expect(res.status).toBe(401);
  });
});

describe('create', () => {
  it('creates a share from chunk 0', async () => {
    const res = await app.request('/api/v2/shares', { method: 'POST', headers: auth, body: JSON.stringify(createBody()) });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(typeof body.shareId).toBe('string');
    expect(body.shareId.length).toBeGreaterThan(0);
    expect(typeof body.uploadToken).toBe('string');
    expect(body.acceptedSourceChunk).toBe(0);
    expect(body.redactions['aws-access-key']).toBe(1);
    expect(body.messageCount).toBe(2);
    expect(body.bytes).toBeGreaterThan(0);
  });

  it('rejects preset "none" with the same uniform error as v1', async () => {
    const res = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ preset: 'none' })),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: { code: 'validation', message: 'preset "none" (no redaction) is not accepted by the API' } });
  });

  it('rejects a wrong protocol', async () => {
    const res = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ protocol: 'quire-share-v2' })),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
  });

  it('rejects a malformed contentKey', async () => {
    const res = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ contentKey: 'abc' })),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
  });

  it('rejects sourceChunkCount 0', async () => {
    const res = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ sourceChunkCount: 0 })),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
  });

  it('is idempotent on a byte-identical replay (same digest)', async () => {
    const body = JSON.stringify(createBody({ uploadRequestId: 'req-idem' }));
    const first = await app.request('/api/v2/shares', { method: 'POST', headers: auth, body });
    expect(first.status).toBe(201);
    const f = await json(first);
    const second = await app.request('/api/v2/shares', { method: 'POST', headers: auth, body });
    expect(second.status).toBe(201);
    const s = await json(second);
    expect(s.shareId).toBe(f.shareId);
    expect(s.uploadToken).toBe(f.uploadToken);
    const rows = await db.select().from(sharesV2);
    expect(rows).toHaveLength(1);
  });

  it('409s the same uploadRequestId with a different body (different digest)', async () => {
    const first = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ uploadRequestId: 'req-conflict' })),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ uploadRequestId: 'req-conflict', session: { sessionId: 'sess_v2', title: 'other', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] } })),
    });
    expect(second.status).toBe(409);
    expect((await json(second)).error.code).toBe('upload_conflict');
  });
});

describe('chunk', () => {
  async function createTwoChunkShare() {
    const res = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ uploadRequestId: 'req-chunk', sourceChunkCount: 2 })),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    return { shareId: body.shareId as string, uploadToken: body.uploadToken as string };
  }

  const chunkBody = (messages: unknown[]) => JSON.stringify({ protocol: 'quire-share-v1', contentKey, messages });

  it('accepts an in-order chunk 1', async () => {
    const { shareId, uploadToken } = await createTwoChunkShare();
    const res = await app.request(`/api/v2/shares/${shareId}/source-chunks/1`, {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': uploadToken },
      body: chunkBody([{ role: 'user', parts: [{ type: 'text', text: 'sk-abcdefghijklmnopqrstuv' }] }]),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.acceptedSourceChunk).toBe(1);
    expect(body.messageCount).toBe(3);
    expect(body.redactions['aws-access-key']).toBe(1);
    expect(body.redactions['openai-key']).toBe(1);
    expect(body.bytes).toBeGreaterThan(0);
  });

  it('404s a wrong X-Upload-Token with the byte-identical body of an unknown share', async () => {
    const { shareId } = await createTwoChunkShare();
    const wrong = await app.request(`/api/v2/shares/${shareId}/source-chunks/1`, {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': 'wrong-token' },
      body: chunkBody([{ role: 'user', parts: [{ type: 'text', text: 'x' }] }]),
    });
    expect(wrong.status).toBe(404);
    const unknown = await app.request('/api/v2/shares/no-such-share/source-chunks/1', {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': 'wrong-token' },
      body: chunkBody([{ role: 'user', parts: [{ type: 'text', text: 'x' }] }]),
    });
    expect(unknown.status).toBe(404);
    expect(await wrong.text()).toBe(await unknown.text());
  });

  it('404s a missing X-Upload-Token', async () => {
    const { shareId } = await createTwoChunkShare();
    const res = await app.request(`/api/v2/shares/${shareId}/source-chunks/1`, {
      method: 'PUT',
      headers: auth,
      body: chunkBody([{ role: 'user', parts: [{ type: 'text', text: 'x' }] }]),
    });
    expect(res.status).toBe(404);
  });

  it('400s an out-of-order chunk', async () => {
    const { shareId, uploadToken } = await createTwoChunkShare();
    const res = await app.request(`/api/v2/shares/${shareId}/source-chunks/2`, {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': uploadToken },
      body: chunkBody([{ role: 'user', parts: [{ type: 'text', text: 'x' }] }]),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('chunk_seq');
  });

  it('400s a non-integer seq', async () => {
    const { shareId, uploadToken } = await createTwoChunkShare();
    const res = await app.request(`/api/v2/shares/${shareId}/source-chunks/abc`, {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': uploadToken },
      body: chunkBody([{ role: 'user', parts: [{ type: 'text', text: 'x' }] }]),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
  });

  it('is idempotent on a byte-identical chunk replay', async () => {
    const { shareId, uploadToken } = await createTwoChunkShare();
    const body = chunkBody([{ role: 'user', parts: [{ type: 'text', text: 'sk-abcdefghijklmnopqrstuv' }] }]);
    const first = await app.request(`/api/v2/shares/${shareId}/source-chunks/1`, {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': uploadToken },
      body,
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/v2/shares/${shareId}/source-chunks/1`, {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': uploadToken },
      body,
    });
    expect(second.status).toBe(200);
    expect(await json(second)).toEqual(await json(first));
  });

  it('409s a duplicate chunk with a different body (different digest)', async () => {
    const { shareId, uploadToken } = await createTwoChunkShare();
    const first = await app.request(`/api/v2/shares/${shareId}/source-chunks/1`, {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': uploadToken },
      body: chunkBody([{ role: 'user', parts: [{ type: 'text', text: 'x' }] }]),
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/v2/shares/${shareId}/source-chunks/1`, {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': uploadToken },
      body: chunkBody([{ role: 'user', parts: [{ type: 'text', text: 'y' }] }]),
    });
    expect(second.status).toBe(409);
    expect((await json(second)).error.code).toBe('chunk_conflict');
  });
});

describe('finalize', () => {
  async function completeUpload(uploadRequestId: string) {
    const createRes = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ uploadRequestId, sourceChunkCount: 2 })),
    });
    expect(createRes.status).toBe(201);
    const created = await json(createRes);
    const chunkRes = await app.request(`/api/v2/shares/${created.shareId}/source-chunks/1`, {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': created.uploadToken },
      body: JSON.stringify({ protocol: 'quire-share-v1', contentKey, messages: [{ role: 'user', parts: [{ type: 'text', text: 'sk-abcdefghijklmnopqrstuv' }] }] }),
    });
    expect(chunkRes.status).toBe(200);
    return created;
  }

  it('finalizes a complete upload and returns a key-free summary', async () => {
    const created = await completeUpload('req-fin');
    const res = await app.request(`/api/v2/shares/${created.shareId}/finalize`, {
      method: 'POST',
      headers: { ...auth, 'x-upload-token': created.uploadToken },
      body: JSON.stringify({ protocol: 'quire-share-v1', contentKey }),
    });
    expect(res.status).toBe(200);
    const raw = await res.clone().text();
    const body = JSON.parse(raw) as Record<string, any>;
    expect(body.shareId).toBe(created.shareId);
    expect(body.publicPath).toBe(`/chats/${created.shareId}`);
    expect(body.messageCount).toBe(3);
    expect(body.pageCount).toBeGreaterThanOrEqual(1);
    expect(body.bytes).toBeGreaterThan(0);
    expect(body.redactions).toMatchObject({ 'aws-access-key': 1, 'openai-key': 1 });
    expect(raw).not.toContain(created.uploadToken);
    expect(raw).not.toContain(contentKey);
  });

  it('is idempotent on a second finalize', async () => {
    const created = await completeUpload('req-fin-idem');
    const body = JSON.stringify({ protocol: 'quire-share-v1', contentKey });
    const first = await app.request(`/api/v2/shares/${created.shareId}/finalize`, {
      method: 'POST',
      headers: { ...auth, 'x-upload-token': created.uploadToken },
      body,
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/v2/shares/${created.shareId}/finalize`, {
      method: 'POST',
      headers: { ...auth, 'x-upload-token': created.uploadToken },
      body,
    });
    expect(second.status).toBe(200);
    expect(await json(second)).toEqual(await json(first));
  });

  it('400s an incomplete upload', async () => {
    const createRes = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ uploadRequestId: 'req-incomplete', sourceChunkCount: 2 })),
    });
    expect(createRes.status).toBe(201);
    const created = await json(createRes);
    const res = await app.request(`/api/v2/shares/${created.shareId}/finalize`, {
      method: 'POST',
      headers: { ...auth, 'x-upload-token': created.uploadToken },
      body: JSON.stringify({ protocol: 'quire-share-v1', contentKey }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('incomplete');
  });

  it('404s a wrong X-Upload-Token', async () => {
    const created = await completeUpload('req-fin-wrongtok');
    const res = await app.request(`/api/v2/shares/${created.shareId}/finalize`, {
      method: 'POST',
      headers: { ...auth, 'x-upload-token': 'wrong-token' },
      body: JSON.stringify({ protocol: 'quire-share-v1', contentKey }),
    });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('not_found');
  });
});

describe('sealing', () => {
  it('never persists the contentKey or raw transcript content', async () => {
    const createRes = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ uploadRequestId: 'req-seal', sourceChunkCount: 2 })),
    });
    expect(createRes.status).toBe(201);
    const created = await json(createRes);
    const chunkRes = await app.request(`/api/v2/shares/${created.shareId}/source-chunks/1`, {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': created.uploadToken },
      body: JSON.stringify({ protocol: 'quire-share-v1', contentKey, messages: [{ role: 'user', parts: [{ type: 'text', text: 'sk-abcdefghijklmnopqrstuv' }] }] }),
    });
    expect(chunkRes.status).toBe(200);
    const finRes = await app.request(`/api/v2/shares/${created.shareId}/finalize`, {
      method: 'POST',
      headers: { ...auth, 'x-upload-token': created.uploadToken },
      body: JSON.stringify({ protocol: 'quire-share-v1', contentKey }),
    });
    expect(finRes.status).toBe(200);

    // Every stored row (share, chunk markers, sealed blobs) must be free of the
    // content key and the raw (pre-redaction) secrets.
    const shares = await db.select().from(sharesV2);
    const chunks = await db.select().from(shareSourceChunksV2);
    const blobs = await db.select().from(shareBlobsV2);
    const stored = [
      ...shares.map((r) => JSON.stringify(r)),
      ...chunks.map((r) => JSON.stringify(r)),
      ...blobs.map((r) => JSON.stringify({ ...r, ciphertext: Buffer.from(r.ciphertext).toString('latin1') })),
    ].join('\n');
    expect(stored).not.toContain(contentKey);
    expect(stored).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(stored).not.toContain('sk-abcdefghijklmnopqrstuv');
    // The share row itself stores only REDACTED meta.
    expect(shares).toHaveLength(1);
    const share = shares[0]!;
    expect(share.title).not.toContain('AKIA');
    expect(JSON.stringify(share.redactions)).not.toContain('AKIA');
  });
});

describe('public path (Task 8 not yet mounted)', () => {
  it('does not serve the v2 public path yet', async () => {
    const createRes = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ uploadRequestId: 'req-public' })),
    });
    expect(createRes.status).toBe(201);
    const created = await json(createRes);
    const res = await app.request(`/chats/${created.shareId}`);
    expect(res.status).toBe(404);
  });
});
