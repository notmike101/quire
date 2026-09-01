import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { shares, shareMessages, sharesV2, shareBlobsV2 } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';
import { generateUploadId } from '../src/security/token.js';
import { deriveUploadToken } from '../src/share-v2/store.js';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';
// The base config omits BOTH gate fields: the interface defaults apply
// (v2 writes OFF, v1 reads ON) — exactly the deployment default this file
// is about. Each gate test spreads it with the one field it flips.
const baseConfig = { databaseUrl: url, apiKey: 'a'.repeat(64), unlockSecret: 'b'.repeat(64), port: 8787, webDist: '' };
const auth = { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' };

// Test-only material: one random content key for the whole file (never
// persisted or logged by the server).
const contentKey = randomBytes(32).toString('base64url');
const sha256Hex = (v: Uint8Array): string => createHash('sha256').update(v).digest('hex');
const enc = new TextEncoder();

let db: Db;

/** Response.json() is typed Promise<unknown> under @types/node (no DOM lib); cast to a plain object. */
const json = (r: Response): Promise<Record<string, any>> => r.json() as Promise<Record<string, any>>;

const NOT_FOUND = { error: { code: 'not_found', message: 'Not found' } };

const createBody = (uploadRequestId: string) => ({
  protocol: 'quire-share-v1',
  uploadRequestId,
  preset: 'strict',
  sourceChunkCount: 1,
  contentKey,
  session: {
    sessionId: 'sess_gate',
    title: 'gate share',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'world' }] },
    ],
  },
});

async function seedV1Share(token: string) {
  const [share] = await db.insert(shares).values({
    token,
    uploadId: generateUploadId(),
    sessionId: `sess_${token}`,
    title: `Share ${token}`,
    messageCount: 2,
  }).returning();
  if (!share) throw new Error('seed insert returned no row');
  await db.insert(shareMessages).values([
    { shareId: share.id, seq: 1, role: 'user', parts: [{ type: 'text', text: 'one' }] },
    { shareId: share.id, seq: 2, role: 'assistant', parts: [{ type: 'text', text: 'two' }] },
  ]);
  return share;
}

/** Seeds a ready v2 share whose upload token the caller can derive (valid-token gate tests). */
async function seedV2Share(publicId: string) {
  const uploadRequestId = `req_${publicId}`;
  const uploadToken = deriveUploadToken(baseConfig, publicId, uploadRequestId);
  const [share] = await db.insert(sharesV2).values({
    publicId,
    uploadRequestId,
    uploadTokenHash: sha256Hex(enc.encode(uploadToken)),
    state: 'ready',
    sourceChunkCount: 1,
    receivedChunkCount: 1,
    pageCount: 1,
    messageCount: 2,
    title: `title ${publicId}`,
  }).returning();
  if (!share) throw new Error('seed insert returned no row');
  const manifest = enc.encode(`QSHR-manifest-${publicId}`);
  const index = enc.encode(`QSHR-index-${publicId}`);
  const page = enc.encode(`QSHR-page-${publicId}`);
  await db.insert(shareBlobsV2).values([
    { shareId: share.id, kind: 'manifest', seq: 0, ciphertext: manifest, ciphertextBytes: manifest.byteLength, digest: sha256Hex(manifest) },
    { shareId: share.id, kind: 'index', seq: 0, ciphertext: index, ciphertextBytes: index.byteLength, digest: sha256Hex(index) },
    { shareId: share.id, kind: 'page', seq: 0, ciphertext: page, ciphertextBytes: page.byteLength, digest: sha256Hex(page) },
  ]);
  return { share, uploadToken };
}

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
});

beforeEach(async () => {
  await db.execute(sql`delete from share_blobs_v2; delete from share_source_chunks_v2; delete from shares_v2; delete from share_messages; delete from shares`);
});

afterAll(async () => {
  await db.execute(sql`delete from share_blobs_v2; delete from share_source_chunks_v2; delete from shares_v2; delete from share_messages; delete from shares`);
  const withClient = db as unknown as { $client?: { end(): Promise<void> } };
  await withClient.$client?.end();
});

describe('QUIRE_V2_WRITE_ENABLED gate', () => {
  it('404s a v2 create with the uniform body when the gate is off (the default)', async () => {
    const app = createApp({ db, config: baseConfig });
    const res = await app.request('/api/v2/shares', { method: 'POST', headers: auth, body: JSON.stringify(createBody('req-off-1')) });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual(NOT_FOUND);
  });

  it('the gated 404 is byte-identical to an unknown v2 path (no existence oracle)', async () => {
    const app = createApp({ db, config: baseConfig });
    const gated = await app.request('/api/v2/shares', { method: 'POST', headers: auth, body: JSON.stringify(createBody('req-off-2')) });
    const unknown = await app.request('/api/v2/nope', { method: 'POST' });
    expect(await gated.text()).toBe(await unknown.text());
  });

  it('404s chunk and finalize when the gate is off, even with a valid upload token', async () => {
    const app = createApp({ db, config: baseConfig });
    const { uploadToken } = await seedV2Share('v2chunkgate');
    const chunk = await app.request('/api/v2/shares/v2chunkgate/source-chunks/0', {
      method: 'PUT',
      headers: { ...auth, 'x-upload-token': uploadToken },
      body: JSON.stringify({ protocol: 'quire-share-v1', contentKey, messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] }),
    });
    expect(chunk.status).toBe(404);
    expect(await json(chunk)).toEqual(NOT_FOUND);
    const fin = await app.request('/api/v2/shares/v2chunkgate/finalize', {
      method: 'POST',
      headers: { ...auth, 'x-upload-token': uploadToken },
      body: JSON.stringify({ protocol: 'quire-share-v1', contentKey }),
    });
    expect(fin.status).toBe(404);
    expect(await json(fin)).toEqual(NOT_FOUND);
  });

  it('v2 public reads still work while the write gate is off', async () => {
    const app = createApp({ db, config: baseConfig });
    await seedV2Share('v2readgateoff');
    const res = await app.request('/api/v2/public/shares/v2readgateoff/bootstrap');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.state).toBe('ready');
  });

  it('v2 create works when the gate is on', async () => {
    const app = createApp({ db, config: { ...baseConfig, v2WriteEnabled: true } });
    const res = await app.request('/api/v2/shares', { method: 'POST', headers: auth, body: JSON.stringify(createBody('req-on-1')) });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(typeof body.shareId).toBe('string');
    expect(body.acceptedSourceChunk).toBe(0);
  });
});

describe('QUIRE_V1_READS_ENABLED gate', () => {
  it('v1 public reads work by default (gate on)', async () => {
    const app = createApp({ db, config: baseConfig });
    await seedV1Share('v1gateon');
    const res = await app.request('/api/public/chats/v1gateon');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.meta.title).toBe('Share v1gateon');
  });

  it('404s a v1 public read with the uniform body when v1 reads are retired', async () => {
    const app = createApp({ db, config: { ...baseConfig, v1ReadsEnabled: false } });
    await seedV1Share('v1gateoff');
    const res = await app.request('/api/public/chats/v1gateoff');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual(NOT_FOUND);
  });

  it('404s a v1 unlock too when retired (no liveness oracle)', async () => {
    const app = createApp({ db, config: { ...baseConfig, v1ReadsEnabled: false } });
    await seedV1Share('v1unlockoff');
    const res = await app.request('/api/public/chats/v1unlockoff/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'x' }),
    });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual(NOT_FOUND);
  });

  it('a v1 owner read still works when v1 reads are retired', async () => {
    const app = createApp({ db, config: { ...baseConfig, v1ReadsEnabled: false } });
    await seedV1Share('v1owneroff');
    const res = await app.request('/api/chats/v1owneroff', { headers: { authorization: `Bearer ${'a'.repeat(64)}` } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.token).toBe('v1owneroff');
    expect(body.format).toBe('v1');
  });
});
