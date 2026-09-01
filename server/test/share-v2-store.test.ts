import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { eq, sql } from 'drizzle-orm';
import { sharesV2, shareSourceChunksV2, shareBlobsV2 } from '../src/db/schema.js';
import {
  acceptV2SourceChunk,
  createV2Upload,
  deleteExpiredV2,
  deriveUploadToken,
  finalizeV2Upload,
  getV2Blob,
  getV2PublicShareState,
  revokeV2,
  updateV2,
} from '../src/share-v2/store.js';
import { openBlob } from '../src/share-v2/crypto.js';
import { prepareContent, type ShapedMessage, type ShapedSession } from '../src/redact/prepare.js';
import { MAX_RAIL_USER_ENTRIES, MAX_SHARE_BYTES, parseShareIndexSegment, parseShareManifest } from '@quire/protocol';
import type { Config } from '../src/config.js';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';
const config: Config = { databaseUrl: url, apiKey: 'a'.repeat(64), unlockSecret: 'b'.repeat(64), port: 8787, webDist: '' };

let db: Db;

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
  await db.execute(sql`delete from share_blobs_v2; delete from share_source_chunks_v2; delete from shares_v2`);
});

afterAll(async () => {
  await db.execute(sql`delete from share_blobs_v2; delete from share_source_chunks_v2; delete from shares_v2`);
  // drizzle hides the postgres.js client; named const keeps the one-off cast out of the call.
  const withClient = db as unknown as { $client?: { end(): Promise<void> } };
  await withClient.$client?.end();
});

// The content key is test-only material (random per test, never persisted or
// logged). Helpers build small clean sessions; the strict preset is used
// everywhere so redaction counts are deterministic.
const newKey = (): Uint8Array => randomBytes(32);

function textMsg(role: 'user' | 'assistant', text: string): ShapedMessage {
  return { role, parts: [{ type: 'text', text }] };
}

function sessionOf(messages: ShapedMessage[], title = 'v2 share'): ShapedSession {
  return { sessionId: 'sess_v2', title, messages };
}

async function makeShare(
  uploadRequestId: string,
  opts: { sourceChunkCount?: number; expiresAt?: string | null; contentKey?: Uint8Array; messages?: ShapedMessage[] } = {},
) {
  const contentKey = opts.contentKey ?? newKey();
  const messages = opts.messages ?? [textMsg('user', 'hello')];
  const created = await createV2Upload(db, config, {
    uploadRequestId,
    contentKey,
    session: sessionOf(messages),
    preset: 'strict',
    passwordHash: null,
    expiresAt: opts.expiresAt ?? null,
    sourceChunkCount: opts.sourceChunkCount ?? 1,
    requestDigest: 'digest-0',
  });
  return { created, contentKey };
}

describe('deriveUploadToken', () => {
  it('is deterministic and bound to (publicId, uploadRequestId)', () => {
    const t1 = deriveUploadToken(config, 'pub', 'req');
    expect(t1).toBe(deriveUploadToken(config, 'pub', 'req'));
    expect(t1).not.toBe(deriveUploadToken(config, 'pub2', 'req'));
    expect(t1).not.toBe(deriveUploadToken(config, 'pub', 'req2'));
    expect(t1).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('create → chunk → finalize', () => {
  it('produces the expected row state and blob count (including the index blob)', async () => {
    const contentKey = newKey();
    const chunk0 = [textMsg('user', 'hello'), textMsg('assistant', 'hi there')];
    const chunk1 = [textMsg('user', 'use AKIAABCDEFGHIJKLMNOP please'), textMsg('assistant', 'second answer')];
    const p0 = prepareContent(sessionOf(chunk0), 'strict');
    const p1 = prepareContent(sessionOf(chunk1), 'strict');

    const created = await createV2Upload(db, config, {
      uploadRequestId: 'req-happy',
      contentKey,
      session: sessionOf(chunk0),
      preset: 'strict',
      passwordHash: null,
      expiresAt: null,
      sourceChunkCount: 2,
      requestDigest: 'digest-0',
    });

    // publicId is a 128-bit base64url token; the token is derived, not random.
    expect(created.publicId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.uploadToken).toBe(deriveUploadToken(config, created.publicId, 'req-happy'));
    expect(created.messageCount).toBe(p0.messageCount);
    expect(created.bytes).toBe(p0.bytes);
    expect(created.redactions).toEqual(p0.summary);

    const row = (await db.select().from(sharesV2).where(eq(sharesV2.id, created.id)))[0]!;
    expect(row.publicId).toBe(created.publicId);
    expect(row.state).toBe('uploading');
    expect(row.sourceChunkCount).toBe(2);
    expect(row.receivedChunkCount).toBe(1);
    expect(row.pageCount).toBe(1);
    expect(row.messageCount).toBe(2);
    expect(row.bytes).toBe(p0.bytes);
    expect(row.redactions).toEqual(p0.summary);
    expect(row.title).toBe('v2 share');
    expect(row.uploadTokenHash).toBe(createHash('sha256').update(created.uploadToken).digest('hex'));

    const chunkRows = await db.select().from(shareSourceChunksV2).where(eq(shareSourceChunksV2.shareId, created.id));
    expect(chunkRows).toHaveLength(1);
    expect(chunkRows[0]!.sourceSeq).toBe(0);
    expect(chunkRows[0]!.requestDigest).toBe('digest-0');

    const blobRows = await db.select().from(shareBlobsV2).where(eq(shareBlobsV2.shareId, created.id));
    expect(blobRows).toHaveLength(1);
    expect(blobRows[0]!.kind).toBe('page');
    expect(blobRows[0]!.seq).toBe(0);
    expect(blobRows[0]!.ciphertextBytes).toBe(blobRows[0]!.ciphertext.byteLength);
    expect(blobRows[0]!.digest).toBe(createHash('sha256').update(blobRows[0]!.ciphertext).digest('hex'));

    const acc = await acceptV2SourceChunk(db, config, {
      id: created.id,
      publicId: created.publicId,
      contentKey,
      chunkSeq: 1,
      prepared: p1,
      requestDigest: 'digest-1',
    });
    expect(acc).toEqual({ ok: true });

    const row2 = (await db.select().from(sharesV2).where(eq(sharesV2.id, created.id)))[0]!;
    expect(row2.receivedChunkCount).toBe(2);
    expect(row2.messageCount).toBe(4);
    expect(row2.bytes).toBe(p0.bytes + p1.bytes);
    expect(row2.pageCount).toBe(2);
    expect(row2.redactions).toEqual({ 'aws-access-key': 1 });

    const fin = await finalizeV2Upload(db, config, { id: created.id, publicId: created.publicId, contentKey });
    expect('ok' in fin).toBe(false);
    if ('ok' in fin) throw new Error(`finalize failed: ${fin.code}`);
    expect(fin.shareId).toBe(created.publicId);
    expect(fin.publicPath).toBe(`/chats/${created.publicId}`);
    expect(fin.messageCount).toBe(4);
    expect(fin.pageCount).toBe(2);
    expect(fin.bytes).toBe(p0.bytes + p1.bytes);
    expect(fin.redactions).toEqual({ 'aws-access-key': 1 });

    const row3 = (await db.select().from(sharesV2).where(eq(sharesV2.id, created.id)))[0]!;
    expect(row3.state).toBe('ready');

    const blobs = await db.select().from(shareBlobsV2).where(eq(shareBlobsV2.shareId, created.id));
    expect(blobs.map((b) => `${b.kind}:${b.seq}`).sort()).toEqual(['index:0', 'manifest:0', 'page:0', 'page:1']);

    // The manifest decrypts to the stored redacted meta (key-free summary source).
    const manifestBlob = blobs.find((b) => b.kind === 'manifest')!;
    const manifest = parseShareManifest(await openBlob(contentKey, manifestBlob.ciphertext, created.publicId, 'manifest', 0));
    expect(manifest.shareId).toBe(created.publicId);
    expect(manifest.title).toBe('v2 share');
    expect(manifest.messageCount).toBe(4);
    expect(manifest.pageCount).toBe(2);
    expect(manifest.redactions).toEqual({ 'aws-access-key': 1 });
    expect(manifest.expiresAt).toBeNull();
    expect(manifest.createdAt).toBe(row3.createdAt.toISOString());

    // Re-finalizing is idempotent and returns the same key-free summary.
    const fin2 = await finalizeV2Upload(db, config, { id: created.id, publicId: created.publicId, contentKey });
    if ('ok' in fin2) throw new Error(`finalize failed: ${fin2.code}`);
    expect(fin2).toEqual(fin);
  });

  it('a repeated create (same uploadRequestId + digest) is idempotent', async () => {
    const contentKey = newKey();
    const input = {
      uploadRequestId: 'req-idem',
      contentKey,
      session: sessionOf([textMsg('user', 'hello')]),
      preset: 'strict' as const,
      passwordHash: null,
      expiresAt: null,
      sourceChunkCount: 1,
      requestDigest: 'digest-0',
    };
    const first = await createV2Upload(db, config, input);
    const second = await createV2Upload(db, config, input);
    expect(second).toEqual(first);
    const rows = await db.select().from(sharesV2).where(eq(sharesV2.uploadRequestId, 'req-idem'));
    expect(rows).toHaveLength(1);
    const blobs = await db.select().from(shareBlobsV2).where(eq(shareBlobsV2.shareId, first.id));
    expect(blobs).toHaveLength(1);
  });

  it('a conflicting create (same uploadRequestId, different digest) is 409', async () => {
    const { created } = await makeShare('req-conflict', {});
    await expect(
      createV2Upload(db, config, {
        uploadRequestId: 'req-conflict',
        contentKey: newKey(),
        session: sessionOf([textMsg('user', 'other content')]),
        preset: 'strict',
        passwordHash: null,
        expiresAt: null,
        sourceChunkCount: 1,
        requestDigest: 'digest-OTHER',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'upload_conflict' });
    const rows = await db.select().from(sharesV2).where(eq(sharesV2.uploadRequestId, 'req-conflict'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(created.id);
  });
});

describe('acceptV2SourceChunk', () => {
  it('an out-of-order chunk is 400 chunk_seq and is not persisted', async () => {
    const { created, contentKey } = await makeShare('req-ooo', { sourceChunkCount: 3 });
    const p2 = prepareContent(sessionOf([textMsg('user', 'q2')]), 'strict');
    const res = await acceptV2SourceChunk(db, config, {
      id: created.id,
      publicId: created.publicId,
      contentKey,
      chunkSeq: 2,
      prepared: p2,
      requestDigest: 'digest-2',
    });
    expect(res).toEqual({ ok: false, status: 400, code: 'chunk_seq' });
    const chunks = await db.select().from(shareSourceChunksV2).where(eq(shareSourceChunksV2.shareId, created.id));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.sourceSeq).toBe(0);
  });

  it('a duplicate chunk (same digest) is idempotent', async () => {
    const { created, contentKey } = await makeShare('req-dup', { sourceChunkCount: 2 });
    const p1 = prepareContent(sessionOf([textMsg('user', 'q1')]), 'strict');
    const first = await acceptV2SourceChunk(db, config, {
      id: created.id,
      publicId: created.publicId,
      contentKey,
      chunkSeq: 1,
      prepared: p1,
      requestDigest: 'digest-1',
    });
    expect(first).toEqual({ ok: true });
    const second = await acceptV2SourceChunk(db, config, {
      id: created.id,
      publicId: created.publicId,
      contentKey,
      chunkSeq: 1,
      prepared: p1,
      requestDigest: 'digest-1',
    });
    expect(second).toEqual({ ok: true });
    const row = (await db.select().from(sharesV2).where(eq(sharesV2.id, created.id)))[0]!;
    expect(row.receivedChunkCount).toBe(2);
    const blobs = await db.select().from(shareBlobsV2).where(eq(shareBlobsV2.shareId, created.id));
    expect(blobs).toHaveLength(2); // chunk 0 page + chunk 1 page, no duplicates
  });

  it('a conflicting chunk (different digest) is 409 chunk_conflict', async () => {
    const { created, contentKey } = await makeShare('req-chunk-conflict', { sourceChunkCount: 2 });
    const p1 = prepareContent(sessionOf([textMsg('user', 'q1')]), 'strict');
    const ok = await acceptV2SourceChunk(db, config, {
      id: created.id,
      publicId: created.publicId,
      contentKey,
      chunkSeq: 1,
      prepared: p1,
      requestDigest: 'digest-1',
    });
    expect(ok).toEqual({ ok: true });
    const res = await acceptV2SourceChunk(db, config, {
      id: created.id,
      publicId: created.publicId,
      contentKey,
      chunkSeq: 1,
      prepared: prepareContent(sessionOf([textMsg('user', 'q1-CHANGED')]), 'strict'),
      requestDigest: 'digest-1-CHANGED',
    });
    expect(res).toEqual({ ok: false, status: 409, code: 'chunk_conflict' });
  });

  it('a chunk that would push bytes over 1 GiB is 400 share_too_large and is not persisted', async () => {
    const { created, contentKey } = await makeShare('req-cap', { sourceChunkCount: 2 });
    // Push the row's running total to the cap edge without uploading 1 GiB.
    await db.update(sharesV2).set({ bytes: MAX_SHARE_BYTES - 100 }).where(eq(sharesV2.id, created.id));
    // A plain-phrase repeat (a 500-char single-char run would trip the
    // long-token redaction rule and shrink below the cap margin).
    const p1 = prepareContent(sessionOf([textMsg('user', 'hello world '.repeat(20))]), 'strict');
    expect(p1.bytes).toBeGreaterThan(100);
    const res = await acceptV2SourceChunk(db, config, {
      id: created.id,
      publicId: created.publicId,
      contentKey,
      chunkSeq: 1,
      prepared: p1,
      requestDigest: 'digest-1',
    });
    expect(res).toEqual({ ok: false, status: 400, code: 'share_too_large' });
    const chunks = await db.select().from(shareSourceChunksV2).where(eq(shareSourceChunksV2.shareId, created.id));
    expect(chunks).toHaveLength(1); // chunk 1 not persisted
    const row = (await db.select().from(sharesV2).where(eq(sharesV2.id, created.id)))[0]!;
    expect(row.bytes).toBe(MAX_SHARE_BYTES - 100);
    expect(row.receivedChunkCount).toBe(1);
  });

  it('a chunk after finalize is 400 share_ready', async () => {
    const { created, contentKey } = await makeShare('req-ready', { sourceChunkCount: 1 });
    const fin = await finalizeV2Upload(db, config, { id: created.id, publicId: created.publicId, contentKey });
    if ('ok' in fin) throw new Error(`finalize failed: ${fin.code}`);
    const res = await acceptV2SourceChunk(db, config, {
      id: created.id,
      publicId: created.publicId,
      contentKey,
      chunkSeq: 1,
      prepared: prepareContent(sessionOf([textMsg('user', 'late')]), 'strict'),
      requestDigest: 'digest-1',
    });
    expect(res).toEqual({ ok: false, status: 400, code: 'share_ready' });
  });
});

describe('finalizeV2Upload', () => {
  it('finalize before all chunks is 400 incomplete', async () => {
    const { created, contentKey } = await makeShare('req-incomplete', { sourceChunkCount: 2 });
    const fin = await finalizeV2Upload(db, config, { id: created.id, publicId: created.publicId, contentKey });
    expect(fin).toEqual({ ok: false, status: 400, code: 'incomplete' });
    const row = (await db.select().from(sharesV2).where(eq(sharesV2.id, created.id)))[0]!;
    expect(row.state).toBe('uploading');
  });

  it('the finalized index blob decrypts to the correct user-message rail (capped at 2000)', async () => {
    const contentKey = newKey();
    const messages: ShapedMessage[] = [];
    for (let i = 0; i < MAX_RAIL_USER_ENTRIES + 1; i++) {
      messages.push(textMsg('user', `user question ${i}`));
      messages.push(textMsg('assistant', `assistant answer ${i}`));
    }
    const created = await createV2Upload(db, config, {
      uploadRequestId: 'req-rail',
      contentKey,
      session: sessionOf(messages),
      preset: 'strict',
      passwordHash: null,
      expiresAt: null,
      sourceChunkCount: 1,
      requestDigest: 'digest-0',
    });
    const fin = await finalizeV2Upload(db, config, { id: created.id, publicId: created.publicId, contentKey });
    if ('ok' in fin) throw new Error(`finalize failed: ${fin.code}`);
    expect(fin.messageCount).toBe(2 * (MAX_RAIL_USER_ENTRIES + 1));

    const blob = await getV2Blob(db, created.id, 'index', 0);
    expect(blob).not.toBeNull();
    const segment = parseShareIndexSegment(await openBlob(contentKey, blob!, created.publicId, 'index', 0));
    expect(segment.shareId).toBe(created.publicId);
    expect(segment.seq).toBe(0);
    expect(segment.entries).toHaveLength(MAX_RAIL_USER_ENTRIES);
    // Only user messages, in order, with the v1 preview projection.
    expect(segment.entries[0]).toEqual({ chunkSeq: 0, seq: 0, preview: 'user question 0' });
    expect(segment.entries[1]).toEqual({ chunkSeq: 0, seq: 2, preview: 'user question 1' });
    expect(segment.entries[segment.entries.length - 1]).toEqual({
      chunkSeq: 0,
      seq: 2 * (MAX_RAIL_USER_ENTRIES - 1),
      preview: `user question ${MAX_RAIL_USER_ENTRIES - 1}`,
    });
  });
});

describe('public reads', () => {
  it('getV2PublicShareState returns the key-free state or null', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const { created } = await makeShare('req-state', {
      expiresAt: future,
      messages: [textMsg('user', 'hi')],
    });
    // The share row was created with the default title; patch the meta via a
    // dedicated create so we can assert title/model/provider round-trip.
    const contentKey = newKey();
    const meta = await createV2Upload(db, config, {
      uploadRequestId: 'req-state-2',
      contentKey,
      session: {
        sessionId: 'sess_meta',
        title: 'Weekly notes',
        model: 'test-model-1',
        provider: 'test-provider',
        messages: [textMsg('user', 'hi')],
      },
      preset: 'strict',
      passwordHash: 'ph',
      expiresAt: future,
      sourceChunkCount: 1,
      requestDigest: 'digest-0',
    });
    expect(await getV2PublicShareState(db, 'does-not-exist')).toBeNull();
    const state = await getV2PublicShareState(db, meta.publicId);
    expect(state).not.toBeNull();
    expect(state!.state).toBe('uploading');
    expect(state!.title).toBe('Weekly notes');
    expect(state!.model).toBe('test-model-1');
    expect(state!.provider).toBe('test-provider');
    expect(state!.passwordHash).toBe('ph');
    expect(state!.expiresAt).toBe(future);
    expect(state!.createdAt).toBeTypeOf('string');
    expect(state!.messageCount).toBe(1);
    expect(state!.pageCount).toBe(1);
    expect(state!.redactions).toEqual({});
    // The first share (default title) also resolves.
    const first = await getV2PublicShareState(db, created.publicId);
    expect(first?.title).toBe('v2 share');
  });

  it('getV2Blob returns the stored ciphertext or null', async () => {
    const { created } = await makeShare('req-blob', {});
    expect(await getV2Blob(db, created.id, 'page', 99)).toBeNull();
    expect(await getV2Blob(db, created.id, 'manifest', 0)).toBeNull();
    const blob = await getV2Blob(db, created.id, 'page', 0);
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(blob!.byteLength).toBeGreaterThan(0);
  });
});

describe('lifecycle', () => {
  it('revokeV2 deletes the row and cascades', async () => {
    const { created } = await makeShare('req-revoke', {});
    expect(await revokeV2(db, created.publicId)).toBe(true);
    expect(await db.select().from(sharesV2).where(eq(sharesV2.id, created.id))).toHaveLength(0);
    expect(await db.select().from(shareSourceChunksV2).where(eq(shareSourceChunksV2.shareId, created.id))).toHaveLength(0);
    expect(await db.select().from(shareBlobsV2).where(eq(shareBlobsV2.shareId, created.id))).toHaveLength(0);
    expect(await revokeV2(db, created.publicId)).toBe(false);
  });

  it('updateV2 patches title/expiresAt/preset and reports whether a row changed', async () => {
    const { created } = await makeShare('req-update', {});
    const future = new Date(Date.now() + 7200_000).toISOString();
    expect(await updateV2(db, created.publicId, { title: 'Renamed', expiresAt: future, preset: 'normal' })).toBe(true);
    const row = (await db.select().from(sharesV2).where(eq(sharesV2.id, created.id)))[0]!;
    expect(row.title).toBe('Renamed');
    expect(row.expiresAt?.toISOString()).toBe(future);
    expect(row.preset).toBe('normal');
    expect(await updateV2(db, 'does-not-exist', { title: 'x' })).toBe(false);
  });

  it('deleteExpiredV2 deletes only expired rows', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const expired = await makeShare('req-exp-1', { expiresAt: past });
    const live = await makeShare('req-exp-2', { expiresAt: future });
    const noExpiry = await makeShare('req-exp-3', { expiresAt: null });
    const n = await deleteExpiredV2(db);
    expect(n).toBe(1);
    const left = await db.select({ publicId: sharesV2.publicId }).from(sharesV2);
    expect(left.map((r) => r.publicId).sort()).toEqual([live.created.publicId, noExpiry.created.publicId].sort());
    // The expired share's children are gone too (cascade).
    expect(await db.select().from(shareBlobsV2).where(eq(shareBlobsV2.shareId, expired.created.id))).toHaveLength(0);
  });
});
