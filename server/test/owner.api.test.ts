import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { sharesV2, shareSourceChunksV2, shareBlobsV2 } from '../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { cleanupStaleV2Uploads } from '../src/db/cleanup.js';

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
  uploadRequestId: 'req-owner-api',
  preset: 'strict',
  sourceChunkCount: 1,
  contentKey,
  session: {
    sessionId: 'sess_owner_api',
    title: 'Owner share',
    model: 'test-model',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'use AKIAABCDEFGHIJKLMNOP please' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
    ],
  },
  ...over,
});

const chunkBody = (messages: unknown[]) => JSON.stringify({ protocol: 'quire-share-v1', contentKey, messages });

/** Runs the full v2 lifecycle (create -> every chunk -> finalize) and returns the share id. */
async function createFinalizedShare(over: Record<string, unknown> = {}): Promise<string> {
  const res = await app.request('/api/v2/shares', { method: 'POST', headers: auth, body: JSON.stringify(createBody(over)) });
  expect(res.status).toBe(201);
  const created = await json(res);
  const count = (over.sourceChunkCount as number | undefined) ?? 1;
  for (let i = 1; i < count; i++) {
    const chunk = await app.request(`/api/v2/shares/${created.shareId}/source-chunks/${i}`, {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': created.uploadToken },
      body: chunkBody([{ role: 'user', parts: [{ type: 'text', text: `chunk ${i}` }] }]),
    });
    expect(chunk.status).toBe(200);
  }
  const fin = await app.request(`/api/v2/shares/${created.shareId}/finalize`, {
    method: 'POST',
    headers: { ...auth, 'x-upload-token': created.uploadToken },
    body: JSON.stringify({ protocol: 'quire-share-v1', contentKey }),
  });
  expect(fin.status).toBe(200);
  return created.shareId as string;
}

beforeAll(async () => {
  db = makeDb(url);
  // postgres.js console.logs NOTICE lines by default; migrateDb against the
  // already-migrated test container emits "already exists, skipping". Silence
  // them so this file's output stays clean.
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
  it('401 for a wrong-LENGTH API key (no length oracle)', async () => {
    const res = await app.request('/api/chats', { headers: { authorization: `Bearer ${'a'.repeat(63)}` } });
    expect(res.status).toBe(401);
  });
  it('401 on the v2 ingestion route without an API key', async () => {
    const res = await app.request('/api/v2/shares', { method: 'POST', body: JSON.stringify(createBody()) });
    expect(res.status).toBe(401);
  });
});

describe('create', () => {
  it('creates a share and persists only redacted content', async () => {
    const res = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ password: 'pw12345', expiresAt: new Date(Date.now() + 3600_000).toISOString() })),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.acceptedSourceChunk).toBe(0);
    expect(body.redactions['aws-access-key']).toBe(1);
    expect(body.messageCount).toBe(2);
    expect(body.bytes).toBeGreaterThan(0);
    // The stored share row carries only redacted meta.
    const share = (await db.select().from(sharesV2).where(eq(sharesV2.publicId, body.shareId)))[0]!;
    expect(share.title).toBe('Owner share');
    expect(share.title).not.toContain('AKIA');
    expect(share.passwordHash).not.toBeNull();
    expect(share.expiresAt).not.toBeNull();
    expect(share.state).toBe('uploading');
  });

  it('strips NUL bytes from tool output without a 500', async () => {
    const res = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(
        createBody({
          session: {
            sessionId: 'sess_nul',
            title: 'Nul share',
            messages: [
              { role: 'user', parts: [{ type: 'text', text: 'run it' }] },
              { role: 'assistant', parts: [{ type: 'tool', tool: 'bash', output: 'line1\u0000line2' }] },
            ],
          },
        }),
      ),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.messageCount).toBe(2);
  });

  it('rejects an invalid body with 400', async () => {
    const res = await app.request('/api/v2/shares', { method: 'POST', headers: auth, body: JSON.stringify({ session: { title: '' } }) });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
  });

  it('rejects a zero-message session with 400', async () => {
    const res = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ session: { sessionId: 'sess_empty', title: 'Empty', messages: [] } })),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
    const rows = await db.select().from(sharesV2).where(eq(sharesV2.uploadRequestId, 'req-owner-api'));
    expect(rows).toHaveLength(0);
  });

  it('rejects preset "none" with the uniform error', async () => {
    const res = await app.request('/api/v2/shares', { method: 'POST', headers: auth, body: JSON.stringify(createBody({ preset: 'none' })) });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: { code: 'validation', message: 'preset "none" (no redaction) is not accepted by the API' } });
  });
});

describe('chunk', () => {
  async function createTwoChunkShare(): Promise<{ shareId: string; uploadToken: string }> {
    const res = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ uploadRequestId: 'req-chunk', sourceChunkCount: 2 })),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    return { shareId: body.shareId as string, uploadToken: body.uploadToken as string };
  }

  it('accepts an in-order chunk 1: messageCount/bytes accumulate, redactions merge', async () => {
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
  async function completeUpload(): Promise<{ shareId: string; uploadToken: string }> {
    const res = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ uploadRequestId: 'req-fin', sourceChunkCount: 2 })),
    });
    expect(res.status).toBe(201);
    const created = await json(res);
    const chunk = await app.request(`/api/v2/shares/${created.shareId}/source-chunks/1`, {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': created.uploadToken },
      body: chunkBody([{ role: 'user', parts: [{ type: 'text', text: 'sk-abcdefghijklmnopqrstuv' }] }]),
    });
    expect(chunk.status).toBe(200);
    return { shareId: created.shareId as string, uploadToken: created.uploadToken as string };
  }

  it('finalizes a complete upload and returns a key-free summary', async () => {
    const { shareId, uploadToken } = await completeUpload();
    const res = await app.request(`/api/v2/shares/${shareId}/finalize`, {
      method: 'POST',
      headers: { ...auth, 'x-upload-token': uploadToken },
      body: JSON.stringify({ protocol: 'quire-share-v1', contentKey }),
    });
    expect(res.status).toBe(200);
    const raw = await res.clone().text();
    const body = JSON.parse(raw) as Record<string, any>;
    expect(body.shareId).toBe(shareId);
    expect(body.publicPath).toBe(`/chats/${shareId}`);
    expect(body.messageCount).toBe(3);
    expect(body.pageCount).toBeGreaterThanOrEqual(1);
    expect(body.bytes).toBeGreaterThan(0);
    expect(raw).not.toContain(uploadToken);
    expect(raw).not.toContain(contentKey);
  });

  it('is idempotent on a second finalize', async () => {
    const { shareId, uploadToken } = await completeUpload();
    const body = JSON.stringify({ protocol: 'quire-share-v1', contentKey });
    const first = await app.request(`/api/v2/shares/${shareId}/finalize`, {
      method: 'POST',
      headers: { ...auth, 'x-upload-token': uploadToken },
      body,
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/v2/shares/${shareId}/finalize`, {
      method: 'POST',
      headers: { ...auth, 'x-upload-token': uploadToken },
      body,
    });
    expect(second.status).toBe(200);
    expect(await json(second)).toEqual(await json(first));
  });

  it('400s an incomplete upload', async () => {
    const res = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ uploadRequestId: 'req-incomplete', sourceChunkCount: 2 })),
    });
    expect(res.status).toBe(201);
    const created = await json(res);
    const fin = await app.request(`/api/v2/shares/${created.shareId}/finalize`, {
      method: 'POST',
      headers: { ...auth, 'x-upload-token': created.uploadToken },
      body: JSON.stringify({ protocol: 'quire-share-v1', contentKey }),
    });
    expect(fin.status).toBe(400);
    expect((await json(fin)).error.code).toBe('incomplete');
  });

  it('404s a wrong X-Upload-Token', async () => {
    const { shareId } = await completeUpload();
    const res = await app.request(`/api/v2/shares/${shareId}/finalize`, {
      method: 'POST',
      headers: { ...auth, 'x-upload-token': 'wrong-token' },
      body: JSON.stringify({ protocol: 'quire-share-v1', contentKey }),
    });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('not_found');
  });
});

describe('list', () => {
  it('lists v2 shares in the owner shape, newest first', async () => {
    const older = await createFinalizedShare({ uploadRequestId: 'req-list-old', session: { sessionId: 'sess_old', title: 'older', messages: [{ role: 'user', parts: [{ type: 'text', text: 'old' }] }] } });
    await db.execute(sql`update shares_v2 set created_at = now() - interval '1 hour' where public_id = ${older}`);
    const newer = await createFinalizedShare({ uploadRequestId: 'req-list-new', session: { sessionId: 'sess_new', title: 'newer', messages: [{ role: 'user', parts: [{ type: 'text', text: 'new' }] }] } });
    const res = await app.request('/api/chats', { headers: auth });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.shares).toHaveLength(2);
    expect(body.shares[0].publicId).toBe(newer);
    expect(body.shares[1].publicId).toBe(older);
    for (const s of body.shares) {
      expect(s.format).toBe('v2');
      expect(s.state).toBe('ready');
    }
  });
  it('401 without an API key', async () => {
    const res = await app.request('/api/chats');
    expect(res.status).toBe(401);
  });
});

describe('get', () => {
  it('returns the v2 owner share shape', async () => {
    const shareId = await createFinalizedShare({ uploadRequestId: 'req-get' });
    const res = await app.request(`/api/chats/${shareId}`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.format).toBe('v2');
    expect(body.publicId).toBe(shareId);
    expect(body.title).toBe('Owner share');
    expect(body.state).toBe('ready');
    expect(body.messageCount).toBe(2);
    expect(body.redactions['aws-access-key']).toBe(1);
  });
  it('404s an unknown id', async () => {
    const res = await app.request('/api/chats/no-such-share', { headers: auth });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });
});

describe('patch', () => {
  it('updates title and expiresAt', async () => {
    const shareId = await createFinalizedShare({ uploadRequestId: 'req-patch' });
    const res = await app.request(`/api/chats/${shareId}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ title: 'renamed', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
    });
    expect(res.status).toBe(200);
    const row = (await db.select().from(sharesV2).where(eq(sharesV2.publicId, shareId)))[0]!;
    expect(row.title).toBe('renamed');
    expect(row.expiresAt).not.toBeNull();
  });
  it('clears expiresAt with null', async () => {
    const shareId = await createFinalizedShare({
      uploadRequestId: 'req-patch-null',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const row = (await db.select().from(sharesV2).where(eq(sharesV2.publicId, shareId)))[0]!;
    expect(row.expiresAt).not.toBeNull();
    const res = await app.request(`/api/chats/${shareId}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ expiresAt: null }),
    });
    expect(res.status).toBe(200);
    const after = (await db.select().from(sharesV2).where(eq(sharesV2.publicId, shareId)))[0]!;
    expect(after.expiresAt).toBeNull();
  });
  it('404s an unknown id', async () => {
    const res = await app.request('/api/chats/no-such-share', { method: 'PATCH', headers: auth, body: JSON.stringify({ title: 'x' }) });
    expect(res.status).toBe(404);
  });
  it('400s a body with v1-only fields (strict schema)', async () => {
    const shareId = await createFinalizedShare({ uploadRequestId: 'req-patch-revoke' });
    const res = await app.request(`/api/chats/${shareId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ revoke: true }) });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
  });
  it('400s an empty body', async () => {
    const shareId = await createFinalizedShare({ uploadRequestId: 'req-patch-empty' });
    const res = await app.request(`/api/chats/${shareId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
  });
});

describe('delete', () => {
  it('hard-deletes the share, its source chunks, and its blobs', async () => {
    const shareId = await createFinalizedShare({ uploadRequestId: 'req-delete' });
    const blobs = await db.select().from(shareBlobsV2);
    expect(blobs.length).toBeGreaterThan(0);
    const res = await app.request(`/api/chats/${shareId}`, { method: 'DELETE', headers: auth });
    expect(res.status).toBe(200);
    const shareRows = await db.select().from(sharesV2).where(eq(sharesV2.publicId, shareId));
    expect(shareRows).toHaveLength(0);
    const chunkRows = await db.select().from(shareSourceChunksV2);
    expect(chunkRows).toHaveLength(0);
    const blobRows = await db.select().from(shareBlobsV2);
    expect(blobRows).toHaveLength(0);
    const get = await app.request(`/api/chats/${shareId}`, { headers: auth });
    expect(get.status).toBe(404);
  });
  it('404s an unknown id', async () => {
    const res = await app.request('/api/chats/no-such-share', { method: 'DELETE', headers: auth });
    expect(res.status).toBe(404);
  });
});

describe('stale incomplete-upload cleanup', () => {
  it('hard-deletes stale uploading shares; keeps fresh uploads and complete shares', async () => {
    // incomplete + old -> deleted (its source chunk marker goes via FK cascade)
    const staleRes = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ uploadRequestId: 'req-stale', sourceChunkCount: 2 })),
    });
    expect(staleRes.status).toBe(201);
    const stale = await json(staleRes);
    await db.execute(sql`update shares_v2 set created_at = now() - interval '25 hours' where public_id = ${stale.shareId}`);
    // incomplete + fresh -> kept (the upload may still be in flight)
    const freshRes = await app.request('/api/v2/shares', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(createBody({ uploadRequestId: 'req-fresh', sourceChunkCount: 2 })),
    });
    expect(freshRes.status).toBe(201);
    const fresh = await json(freshRes);
    // complete + old -> kept (a finished share is never reclaimed by this job)
    const done = await createFinalizedShare({ uploadRequestId: 'req-done' });
    await db.execute(sql`update shares_v2 set created_at = now() - interval '25 hours' where public_id = ${done}`);

    const n = await cleanupStaleV2Uploads(db);
    expect(n).toBe(1);
    const remaining = await db.select().from(sharesV2);
    expect(remaining.map((r) => r.publicId).sort()).toEqual([done, fresh.shareId].sort());
    const chunkRows = await db.select().from(shareSourceChunksV2);
    expect(chunkRows).toHaveLength(2); // fresh + done keep their chunk 0 markers
  });
});
