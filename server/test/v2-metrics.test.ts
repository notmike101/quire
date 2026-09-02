import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { sharesV2, shareBlobsV2 } from '../src/db/schema.js';
import { sql, eq } from 'drizzle-orm';
import { v2Metrics } from '../src/metrics.js';
import { cleanupExpiredV2 } from '../src/db/cleanup.js';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';
const config = { databaseUrl: url, apiKey: 'a'.repeat(64), unlockSecret: 'b'.repeat(64), port: 8787, webDist: '' };
const auth = { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' };

// Test-only material: one random content key for the whole file (never
// persisted or logged by the server). The assertions below additionally prove
// it never reaches the metrics sink, and that the raw synthetic secret in the
// session content stays out of the metric labels/values.
const contentKey = randomBytes(32).toString('base64url');
const RAW_SECRET = 'AKIAABCDEFGHIJKLMNOP';
const TITLE = 'v2 metrics canary share';

let db: Db;
let app: Hono;

/** Response.json() is typed Promise<unknown> under @types/node (no DOM lib); cast to a plain object. */
const json = (r: Response): Promise<Record<string, any>> => r.json() as Promise<Record<string, any>>;

const createBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: 'quire-share-v1',
  uploadRequestId: 'req-metrics',
  preset: 'strict',
  sourceChunkCount: 2,
  contentKey,
  session: {
    sessionId: 'sess_metrics',
    title: TITLE,
    messages: [
      { role: 'user', parts: [{ type: 'text', text: `use ${RAW_SECRET} please` }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
    ],
  },
  ...over,
});

/** Publishes a complete two-chunk v2 share; returns the publicId + uploadToken. */
async function publishV2(): Promise<{ shareId: string; uploadToken: string }> {
  const createRes = await app.request('/api/v2/shares', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(createBody()),
  });
  expect(createRes.status).toBe(201);
  const created = await json(createRes);
  const chunkRes = await app.request(`/api/v2/shares/${created.shareId}/source-chunks/1`, {
    method: 'PUT',
    headers: { ...auth, 'x-upload-token': created.uploadToken },
    body: JSON.stringify({ protocol: 'quire-share-v1', contentKey, messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] }),
  });
  expect(chunkRes.status).toBe(200);
  const finRes = await app.request(`/api/v2/shares/${created.shareId}/finalize`, {
    method: 'POST',
    headers: { ...auth, 'x-upload-token': created.uploadToken },
    body: JSON.stringify({ protocol: 'quire-share-v1', contentKey }),
  });
  expect(finRes.status).toBe(200);
  return { shareId: created.shareId as string, uploadToken: created.uploadToken as string };
}

/** The /metrics snapshot as an array of entries (category/status/count/bytes/latency). */
async function metrics(): Promise<Array<Record<string, any>>> {
  const res = await app.request('/metrics');
  expect(res.status).toBe(200);
  return (await json(res)) as unknown as Array<Record<string, any>>;
}

const entry = (entries: Array<Record<string, any>>, category: string, status: number): Record<string, any> => {
  const found = entries.filter((e) => e.category === category && e.status === status);
  expect(found.length, `${category} ${status}`).toBeGreaterThan(0);
  return found[0]!;
};

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
  v2Metrics.reset();
});

afterAll(async () => {
  await db.execute(sql`delete from share_blobs_v2; delete from share_source_chunks_v2; delete from shares_v2`);
  const withClient = db as unknown as { $client?: { end(): Promise<void> } };
  await withClient.$client?.end();
});

describe('v2 canary metrics', () => {
  it('counters increment for create/chunk/finalize/blob with status, bytes, and latency', async () => {
    // A blob fetch for an unknown share 404s (and is counted).
    const miss = await app.request('/api/v2/public/shares/unknownshare/blobs/manifest/0');
    expect(miss.status).toBe(404);
    const { shareId } = await publishV2();
    const served = await app.request(`/api/v2/public/shares/${shareId}/blobs/manifest/0`);
    expect(served.status).toBe(200);

    const entries = await metrics();
    const create = entry(entries, 'v2_create', 201);
    expect(create.count).toBe(1);
    expect(create.bytes).toBeGreaterThan(0);
    expect(create.avgLatencyMs).not.toBeNull();
    const chunk = entry(entries, 'v2_chunk', 200);
    expect(chunk.count).toBe(1);
    expect(chunk.bytes).toBeGreaterThan(0);
    const finalize = entry(entries, 'v2_finalize', 200);
    expect(finalize.count).toBe(1);
    expect(finalize.bytes).toBeGreaterThan(0);
    const serve = entry(entries, 'v2_blob_serve', 200);
    expect(serve.count).toBe(1);
    expect(serve.bytes).toBeGreaterThan(0);
    expect(serve.maxLatencyMs).not.toBeNull();
    expect(entry(entries, 'v2_blob_serve', 404).count).toBe(1);
  });

  it('metric labels and values contain no content, IDs, keys, or tokens', async () => {
    const { shareId, uploadToken } = await publishV2();
    await app.request(`/api/v2/public/shares/${shareId}/blobs/manifest/0`);
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    const text = await res.text();
    // The full publish + serve happened; the snapshot must be non-empty...
    expect(text).not.toBe('[]');
    // ...yet carry none of the share's identifiers or material.
    expect(text).not.toContain(shareId);
    expect(text).not.toContain(uploadToken);
    expect(text).not.toContain(contentKey);
    expect(text).not.toContain(RAW_SECRET);
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain('sess_metrics');
    // Only the fixed safe categories may appear.
    const categories = new Set((JSON.parse(text) as Array<Record<string, any>>).map((e) => e.category));
    for (const category of categories) {
      expect(['v2_create', 'v2_chunk', 'v2_finalize', 'v2_blob_serve', 'v2_client_decrypt_error', 'v2_stale_cleanup']).toContain(category);
    }
  });

  it('records a client decrypt error when a served blob fails digest verification', async () => {
    const { shareId } = await publishV2();
    const rows = await db.select().from(sharesV2).where(eq(sharesV2.publicId, shareId)).limit(1);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Corrupt the stored digest: the row no longer matches its ciphertext, so
    // the blob can never decrypt — the only decrypt failure the server sees.
    await db.update(shareBlobsV2).set({ digest: '0'.repeat(64) }).where(eq(shareBlobsV2.shareId, row.id));
    const res = await app.request(`/api/v2/public/shares/${shareId}/blobs/manifest/0`);
    expect(res.status).toBe(500);
    const entries = await metrics();
    const err = entry(entries, 'v2_client_decrypt_error', 500);
    expect(err.count).toBe(1);
    expect(entry(entries, 'v2_blob_serve', 500).count).toBe(1);
  });

  it('records the stale cleanup run with the number of expired shares deleted', async () => {
    // One expired share (any state) and one live share.
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);
    await db.insert(sharesV2).values({
      publicId: 'expiredshare',
      uploadRequestId: 'req-metrics-expired',
      uploadTokenHash: 'expiredhash',
      state: 'ready',
      sourceChunkCount: 1,
      expiresAt: past,
    });
    await db.insert(sharesV2).values({
      publicId: 'liveshare',
      uploadRequestId: 'req-metrics-live',
      uploadTokenHash: 'livehash',
      state: 'ready',
      sourceChunkCount: 1,
      expiresAt: future,
    });
    const n = await cleanupExpiredV2(db);
    expect(n).toBe(1);
    const entries = await metrics();
    const cleanup = entry(entries, 'v2_stale_cleanup', 0);
    expect(cleanup.count).toBe(1);
    expect(cleanup.avgLatencyMs).not.toBeNull();
    const left = await db.select({ publicId: sharesV2.publicId }).from(sharesV2);
    expect(left.map((r) => r.publicId)).toEqual(['liveshare']);
  });
});
