import { createHash, createHmac } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  MAX_RAIL_USER_ENTRIES,
  SHARE_PROTOCOL,
  parseSharePage,
  type BlobKind,
  type ShareIndexSegmentV1,
  type ShareManifestV1,
  type SharePageV1,
} from '@quire/protocol';
import { sharesV2, shareSourceChunksV2, shareBlobsV2 } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { prepareContent, type PreparedContent, type ShapedSession } from '../redact/prepare.js';
import type { Preset } from '../redact/rules.js';
import { generateShareToken } from '../security/token.js';
import { wouldExceedCap } from '../api/headers.js';
import { openBlob, sealBlob } from './crypto.js';
import { buildRailEntries, buildViewerPages } from './pages.js';

/**
 * Store-level failure carrying the HTTP status + code the v2 routes map onto
 * the response. createV2Upload THROWS it (its return type is the success
 * shape only); acceptV2SourceChunk / finalizeV2Upload resolve their
 * `{ ok: false, status, code }` union member instead. A missing share row
 * (deleted between the route's existence check and the store's lock) rejects
 * with `ShareV2Error(404, 'not_found')` in all three.
 */
export class ShareV2Error extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${code} (${status})`);
  }
}

/** base64url(HMAC-SHA256(UNLOCK_SECRET, 'quire-upload-token\0' + publicId + '\0' + uploadRequestId)). */
export function deriveUploadToken(config: Config, publicId: string, uploadRequestId: string): string {
  return createHmac('sha256', config.unlockSecret)
    .update(`quire-upload-token\0${publicId}\0${uploadRequestId}`)
    .digest('base64url');
}

const sha256Hex = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

/** True when `e` is a Postgres unique-violation (SQLSTATE 23505). */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}

// Round 10 (I2): sum per-rule redaction counts across chunks. The old chunk
// UPDATE used `jsonb ||`, a SHALLOW merge where the right operand wins on a key
// conflict — so a multi-chunk share's `redactions` showed the LAST chunk's count
// per rule, not the sum (e.g. aws:1 in chunk 0 + aws:2 in chunk 1 → 2, not 3).
// `share.redactions` (read before the transaction) is the stable accumulated
// state to add this chunk to: chunks are contiguous (chunkSeq = maxSeq+1), so at
// most one chunk is in flight at a time and no other request can commit a
// redactions update in the window between the read and this write.
export function mergeRedactionSummary(
  prev: Record<string, number> | null | undefined,
  next: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(next)) out[k] = (out[k] ?? 0) + v;
  return out;
}

export interface CreateV2UploadInput {
  uploadRequestId: string;
  /** AES-256-GCM content key. Held in memory only — NEVER persisted or logged. */
  contentKey: Uint8Array;
  session: ShapedSession;
  preset: Preset;
  passwordHash: string | null;
  /** ISO timestamp, or null for no expiry. */
  expiresAt: string | null;
  sourceChunkCount: number;
  requestDigest: string;
}

export interface CreateV2UploadResult {
  id: string;
  publicId: string;
  uploadToken: string;
  redactions: Record<string, number>;
  messageCount: number;
  bytes: number;
}

/**
 * Idempotency lookup for createV2Upload, keyed on (uploadRequestId,
 * requestDigest). The digest lives on the chunk 0 source-chunk row (inserted
 * atomically with the share row). Returns the stored result on a digest
 * match (the uploadToken is re-derived, never stored); throws
 * ShareV2Error(409, 'upload_conflict') when the same uploadRequestId was
 * already used with a different digest.
 */
async function storedUpload(
  db: Db,
  config: Config,
  uploadRequestId: string,
  requestDigest: string,
): Promise<CreateV2UploadResult | null> {
  const [row] = await db.select().from(sharesV2).where(eq(sharesV2.uploadRequestId, uploadRequestId)).limit(1);
  if (!row) return null;
  const [chunk0] = await db
    .select()
    .from(shareSourceChunksV2)
    .where(and(eq(shareSourceChunksV2.shareId, row.id), eq(shareSourceChunksV2.sourceSeq, 0)));
  if (chunk0?.requestDigest !== requestDigest) throw new ShareV2Error(409, 'upload_conflict');
  return {
    id: row.id,
    publicId: row.publicId,
    uploadToken: deriveUploadToken(config, row.publicId, uploadRequestId),
    redactions: row.redactions as Record<string, number>,
    messageCount: row.messageCount,
    bytes: row.bytes,
  };
}

/**
 * Creates a v2 share from chunk 0 (the full session). Redacts via the
 * authoritative prepareContent pass, seals chunk 0's pages, and inserts the
 * share row + chunk 0 marker + page blobs in one transaction.
 *
 * Idempotent by (uploadRequestId, requestDigest): a replay with the same
 * digest returns the stored result; a different digest is 409
 * `upload_conflict`. The 1 GiB cap is enforced on chunk 0's serialized
 * redacted bytes BEFORE inserting (400 `share_too_large`, share not created).
 */
export async function createV2Upload(db: Db, config: Config, input: CreateV2UploadInput): Promise<CreateV2UploadResult> {
  const prepared = prepareContent(input.session, input.preset);
  if (wouldExceedCap(0, prepared.bytes)) throw new ShareV2Error(400, 'share_too_large');

  const existing = await storedUpload(db, config, input.uploadRequestId, input.requestDigest);
  if (existing) return existing;

  const publicId = generateShareToken();
  const uploadToken = deriveUploadToken(config, publicId, input.uploadRequestId);
  const { pages } = buildViewerPages({ shareId: publicId, chunkSeq: 0, prepared, startPageSeq: 0, startMsgSeq: 0 });
  const sealed = await Promise.all(pages.map((page) => sealBlob(input.contentKey, publicId, 'page', page.seq, page)));

  try {
    const row = await db.transaction(async (tx) => {
      const [ins] = await tx
        .insert(sharesV2)
        .values({
          publicId,
          uploadRequestId: input.uploadRequestId,
          uploadTokenHash: sha256Hex(uploadToken),
          state: 'uploading',
          preset: input.preset,
          passwordHash: input.passwordHash,
          expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
          sourceChunkCount: input.sourceChunkCount,
          receivedChunkCount: 1,
          pageCount: pages.length,
          messageCount: prepared.messageCount,
          bytes: prepared.bytes,
          redactions: prepared.summary,
          title: prepared.title,
          model: prepared.model ?? null,
          provider: prepared.provider ?? null,
        })
        .returning();
      if (!ins) throw new Error('sharesV2 insert returned no row');
      await tx.insert(shareSourceChunksV2).values({ shareId: ins.id, sourceSeq: 0, requestDigest: input.requestDigest });
      await tx.insert(shareBlobsV2).values(
        sealed.map((ciphertext, i) => ({
          shareId: ins.id,
          kind: 'page',
          seq: pages[i]!.seq,
          ciphertext,
          ciphertextBytes: ciphertext.byteLength,
          digest: sha256Hex(ciphertext),
        })),
      );
      return ins;
    });
    return {
      id: row.id,
      publicId: row.publicId,
      uploadToken,
      redactions: prepared.summary,
      messageCount: prepared.messageCount,
      bytes: prepared.bytes,
    };
  } catch (e) {
    if (isUniqueViolation(e)) {
      // A concurrent create raced the unique uploadRequestId constraint; the
      // winner committed first. Re-run the idempotency check against the
      // committed row (throws 409 on a digest mismatch).
      const winner = await storedUpload(db, config, input.uploadRequestId, input.requestDigest);
      if (!winner) throw new Error('unique violation but no stored uploadRequestId row');
      return winner;
    }
    throw e;
  }
}

export interface AcceptV2SourceChunkInput {
  id: string;
  publicId: string;
  /** AES-256-GCM content key. Held in memory only — NEVER persisted or logged. */
  contentKey: Uint8Array;
  chunkSeq: number;
  /** ALREADY-REDACTED content (prepareContent's job — the store never redacts). */
  prepared: PreparedContent;
  requestDigest: string;
}

export type AcceptV2SourceChunkResult = { ok: true } | { ok: false; status: 409 | 400; code: string };

/**
 * Accepts one in-order source chunk. Under a FOR UPDATE lock on the share
 * row: a non-uploading share is 400 `share_ready`; a chunkSeq that was
 * already accepted is idempotent on a requestDigest match (409
 * `chunk_conflict` on mismatch) — checked before the in-order gate so a
 * re-send of an older chunk is not mistaken for out-of-order; a chunkSeq
 * other than receivedChunkCount is 400 `chunk_seq`; a chunk that would push
 * the share over the 1 GiB cap is 400 `share_too_large` and is not
 * persisted. Otherwise the chunk's pages are built (continuing the global
 * page/message seqs), sealed, and inserted with the chunk marker + share
 * counter update in the same transaction.
 */
export async function acceptV2SourceChunk(
  db: Db,
  config: Config,
  input: AcceptV2SourceChunkInput,
): Promise<AcceptV2SourceChunkResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(sharesV2).where(eq(sharesV2.id, input.id)).for('update');
    if (!row) throw new ShareV2Error(404, 'not_found');
    if (row.state !== 'uploading') return { ok: false, status: 400, code: 'share_ready' };
    const [existing] = await tx
      .select()
      .from(shareSourceChunksV2)
      .where(and(eq(shareSourceChunksV2.shareId, row.id), eq(shareSourceChunksV2.sourceSeq, input.chunkSeq)));
    if (existing) {
      if (existing.requestDigest === input.requestDigest) return { ok: true };
      return { ok: false, status: 409, code: 'chunk_conflict' };
    }
    if (input.chunkSeq !== row.receivedChunkCount) return { ok: false, status: 400, code: 'chunk_seq' };
    if (wouldExceedCap(row.bytes, input.prepared.bytes)) return { ok: false, status: 400, code: 'share_too_large' };
    const { pages, nextPageSeq } = buildViewerPages({
      shareId: input.publicId,
      chunkSeq: input.chunkSeq,
      prepared: input.prepared,
      startPageSeq: row.pageCount,
      startMsgSeq: row.messageCount,
    });
    const sealed = await Promise.all(pages.map((page) => sealBlob(input.contentKey, input.publicId, 'page', page.seq, page)));
    await tx.insert(shareSourceChunksV2).values({ shareId: row.id, sourceSeq: input.chunkSeq, requestDigest: input.requestDigest });
    await tx.insert(shareBlobsV2).values(
      sealed.map((ciphertext, i) => ({
        shareId: row.id,
        kind: 'page',
        seq: pages[i]!.seq,
        ciphertext,
        ciphertextBytes: ciphertext.byteLength,
        digest: sha256Hex(ciphertext),
      })),
    );
    await tx
      .update(sharesV2)
      .set({
        receivedChunkCount: input.chunkSeq + 1,
        pageCount: nextPageSeq,
        messageCount: row.messageCount + input.prepared.messageCount,
        bytes: sql`${sharesV2.bytes} + ${input.prepared.bytes}`,
        redactions: mergeRedactionSummary(row.redactions as Record<string, number>, input.prepared.summary),
      })
      .where(eq(sharesV2.id, row.id));
    return { ok: true };
  });
}

export interface FinalizeV2UploadInput {
  id: string;
  publicId: string;
  /** AES-256-GCM content key. Held in memory only — NEVER persisted or logged. */
  contentKey: Uint8Array;
}

export type FinalizeV2UploadResult =
  | { shareId: string; publicPath: string; messageCount: number; pageCount: number; bytes: number; redactions: Record<string, number> }
  | { ok: false; status: number; code: string };

/**
 * Finalizes a complete upload: decrypts every stored page (the contentKey
 * still lives in the caller's memory — it is never persisted), seals the
 * manifest + user-message index blobs, and flips the share to `ready` — all
 * under one FOR UPDATE lock/transaction. The decrypted pages and rail
 * plaintext are discarded after sealing. Idempotent: a `ready` share returns
 * its stored summary; an incomplete one is 400 `incomplete`.
 */
export async function finalizeV2Upload(db: Db, config: Config, input: FinalizeV2UploadInput): Promise<FinalizeV2UploadResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(sharesV2).where(eq(sharesV2.id, input.id)).for('update');
    if (!row) throw new ShareV2Error(404, 'not_found');
    if (row.receivedChunkCount < row.sourceChunkCount) return { ok: false, status: 400, code: 'incomplete' };
    const summary = {
      shareId: row.publicId,
      publicPath: `/chats/${row.publicId}`,
      messageCount: row.messageCount,
      pageCount: row.pageCount,
      bytes: row.bytes,
      redactions: row.redactions as Record<string, number>,
    };
    if (row.state === 'ready') return summary;
    const blobRows = await tx
      .select()
      .from(shareBlobsV2)
      .where(and(eq(shareBlobsV2.shareId, row.id), eq(shareBlobsV2.kind, 'page')))
      .orderBy(asc(shareBlobsV2.seq));
    const pages: SharePageV1[] = [];
    for (const blob of blobRows) {
      // validate the decrypted JSON at the trust boundary (corrupt/tampered
      // blob -> ProtocolError instead of a crash inside buildRailEntries)
      pages.push(parseSharePage(await openBlob(input.contentKey, blob.ciphertext, input.publicId, 'page', blob.seq)));
    }
    const entries = buildRailEntries(pages, MAX_RAIL_USER_ENTRIES);
    const indexSegment: ShareIndexSegmentV1 = { protocol: SHARE_PROTOCOL, shareId: input.publicId, seq: 0, entries };
    const manifest: ShareManifestV1 = {
      protocol: SHARE_PROTOCOL,
      shareId: input.publicId,
      title: row.title ?? '',
      model: row.model ?? undefined,
      provider: row.provider ?? undefined,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
      messageCount: row.messageCount,
      redactions: row.redactions as Record<string, number>,
      pageCount: row.pageCount,
    };
    const manifestBlob = await sealBlob(input.contentKey, input.publicId, 'manifest', 0, manifest);
    const indexBlob = await sealBlob(input.contentKey, input.publicId, 'index', 0, indexSegment);
    await tx.insert(shareBlobsV2).values([
      { shareId: row.id, kind: 'manifest', seq: 0, ciphertext: manifestBlob, ciphertextBytes: manifestBlob.byteLength, digest: sha256Hex(manifestBlob) },
      { shareId: row.id, kind: 'index', seq: 0, ciphertext: indexBlob, ciphertextBytes: indexBlob.byteLength, digest: sha256Hex(indexBlob) },
    ]);
    await tx.update(sharesV2).set({ state: 'ready' }).where(eq(sharesV2.id, row.id));
    return summary;
  });
}

export interface V2PublicShareState {
  state: string;
  expiresAt: string | null;
  passwordHash: string | null;
  title: string | null;
  model: string | null;
  provider: string | null;
  createdAt: string;
  messageCount: number;
  pageCount: number;
  redactions: Record<string, number>;
}

/** Key-free public state for a v2 share (no content key, no upload token). Null when unknown. */
export async function getV2PublicShareState(db: Db, publicId: string): Promise<V2PublicShareState | null> {
  const [row] = await db.select().from(sharesV2).where(eq(sharesV2.publicId, publicId)).limit(1);
  if (!row) return null;
  return {
    state: row.state,
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    passwordHash: row.passwordHash,
    title: row.title,
    model: row.model,
    provider: row.provider,
    createdAt: row.createdAt.toISOString(),
    messageCount: row.messageCount,
    pageCount: row.pageCount,
    redactions: row.redactions as Record<string, number>,
  };
}

/** Owner-facing shape for a v2 share (no content key, no upload token). */
export interface V2OwnerShare {
  id: string;
  publicId: string;
  title: string | null;
  preset: string;
  expiresAt: string | null;
  messageCount: number;
  bytes: number;
  redactions: Record<string, number>;
  createdAt: string;
  state: string;
  format: 'v2';
}

function toV2OwnerShare(row: typeof sharesV2.$inferSelect): V2OwnerShare {
  return {
    id: row.id,
    publicId: row.publicId,
    title: row.title,
    preset: row.preset,
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    messageCount: row.messageCount,
    bytes: row.bytes,
    redactions: row.redactions as Record<string, number>,
    createdAt: row.createdAt.toISOString(),
    state: row.state,
    format: 'v2',
  };
}

/** All v2 shares (any state) in the owner-facing shape, newest first. */
export async function listV2(db: Db): Promise<V2OwnerShare[]> {
  const rows = await db.select().from(sharesV2).orderBy(desc(sharesV2.createdAt)).limit(200);
  return rows.map(toV2OwnerShare);
}

/** Owner-facing shape for one v2 share by publicId; null when unknown. */
export async function getV2OwnerShare(db: Db, publicId: string): Promise<V2OwnerShare | null> {
  const [row] = await db.select().from(sharesV2).where(eq(sharesV2.publicId, publicId)).limit(1);
  return row ? toV2OwnerShare(row) : null;
}

/** The stored ciphertext for one blob, or null when absent. */
export async function getV2Blob(db: Db, id: string, kind: BlobKind, seq: number): Promise<Uint8Array | null> {
  const [row] = await db
    .select({ ciphertext: shareBlobsV2.ciphertext })
    .from(shareBlobsV2)
    .where(and(eq(shareBlobsV2.shareId, id), eq(shareBlobsV2.kind, kind), eq(shareBlobsV2.seq, seq)));
  return row?.ciphertext ?? null;
}

/** Hard-deletes a share by publicId; FK cascade removes its chunks + blobs. */
export async function revokeV2(db: Db, publicId: string): Promise<boolean> {
  const rows = await db.delete(sharesV2).where(eq(sharesV2.publicId, publicId)).returning({ id: sharesV2.id });
  return rows.length > 0;
}

/** Patches the mutable share fields; returns whether a row was updated. */
export async function updateV2(
  db: Db,
  publicId: string,
  patch: { title?: string; expiresAt?: string | null; preset?: Preset },
): Promise<boolean> {
  const set: Partial<typeof sharesV2.$inferInsert> = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt === null ? null : new Date(patch.expiresAt);
  if (patch.preset !== undefined) set.preset = patch.preset;
  const rows = await db.update(sharesV2).set(set).where(eq(sharesV2.publicId, publicId)).returning({ id: sharesV2.id });
  return rows.length > 0;
}

/** Deletes all shares whose expiresAt is in the past (any state). Returns the count. */
export async function deleteExpiredV2(db: Db): Promise<number> {
  const rows = await db.delete(sharesV2).where(sql`${sharesV2.expiresAt} < now()`).returning({ id: sharesV2.id });
  return rows.length;
}
