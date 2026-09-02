import { pgTable, uuid, text, timestamp, integer, jsonb, primaryKey, bigint, index, customType } from 'drizzle-orm/pg-core';

// Chain C: persisted unlock lockouts so a process restart does not clear a
// 15-minute lockout. Keyed by the same (token, IP) key the in-memory limiter
// uses. `count` is the running failure count since the last lock; `lockedUntil`
// is null until the threshold is hit.
export const unlockLockouts = pgTable('unlock_lockouts', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  // Round 4: when the key last recorded a failure. Lets the opportunistic prune
  // drop idle sub-threshold counters (a key-cycling attack leaves rows that are
  // never re-touched and never lock) without a scheduled cleanup job.
  lastSeen: timestamp('last_seen', { withTimezone: true }),
}, (t) => [
  // Round 7: the opportunistic prune in PostgresLockoutStore.recordFailure
  // deletes by locked_until (expired lockouts) OR last_seen (idle sub-threshold
  // counters). Without indexes that is a full table scan on every unlock
  // failure — under a key-cycling attack the table is large, so the scan is the
  // hot path. One index per OR branch lets Postgres bitmap-OR two index range
  // scans instead of scanning the whole table.
  index('unlock_lockouts_locked_until_idx').on(t.lockedUntil),
  index('unlock_lockouts_last_seen_idx').on(t.lastSeen),
]);

// drizzle-orm's pg-core has no built-in bytea column builder; this is the
// standard customType pattern from the drizzle docs. postgres.js returns
// bytea as a Buffer, so driverData is Buffer and app code sees Uint8Array.
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  fromDriver: (value) => new Uint8Array(value),
  toDriver: (value) => Buffer.from(value),
});

// v2 sealed shares (OMP-inspired sharing migration). Task 16b: v2 is the
// only owner format now; the v1 shares/share_messages tables were dropped
// in migration 0008 and their definitions removed from this file. `id` is
// the internal uuid PK (blob storage key); `publicId` is the 128-bit
// base64url public identifier used in the public path, the AAD, and the
// protocol's `shareId`.
export const sharesV2 = pgTable('shares_v2', {
  id: uuid('id').primaryKey().defaultRandom(),
  publicId: text('public_id').notNull().unique(),
  uploadRequestId: text('upload_request_id').notNull().unique(),
  uploadTokenHash: text('upload_token_hash').notNull(),
  state: text('state').notNull().default('uploading'), // 'uploading' | 'ready'
  preset: text('preset').notNull().default('strict'),
  passwordHash: text('password_hash'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  sourceChunkCount: integer('source_chunk_count').notNull(),
  receivedChunkCount: integer('received_chunk_count').notNull().default(0),
  pageCount: integer('page_count').notNull().default(0),
  messageCount: integer('message_count').notNull().default(0),
  bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
  redactions: jsonb('redactions').notNull().default({}),
  title: text('title'),
  model: text('model'),
  provider: text('provider'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('shares_v2_created_at_idx').on(t.createdAt)]);

export const shareSourceChunksV2 = pgTable('share_source_chunks_v2', {
  shareId: uuid('share_id').notNull().references(() => sharesV2.id, { onDelete: 'cascade' }),
  sourceSeq: integer('source_seq').notNull(),
  requestDigest: text('request_digest').notNull(),
}, (t) => [primaryKey({ columns: [t.shareId, t.sourceSeq] })]);

export const shareBlobsV2 = pgTable('share_blobs_v2', {
  shareId: uuid('share_id').notNull().references(() => sharesV2.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // 'manifest' | 'index' | 'page'
  seq: integer('seq').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  ciphertextBytes: integer('ciphertext_bytes').notNull(),
  digest: text('digest').notNull(), // SHA-256 hex of the stored envelope bytes
}, (t) => [primaryKey({ columns: [t.shareId, t.kind, t.seq] })]);
