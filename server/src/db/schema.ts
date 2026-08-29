import { pgTable, uuid, text, timestamp, integer, jsonb, primaryKey, bigint } from 'drizzle-orm/pg-core';

export const shares = pgTable('shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  token: text('token').notNull().unique(),
  uploadId: text('upload_id').notNull().unique(),
  sessionId: text('session_id').notNull(),
  title: text('title').notNull(),
  model: text('model'),
  provider: text('provider'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  passwordHash: text('password_hash'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  preset: text('preset').notNull().default('strict'),
  messageCount: integer('message_count').notNull().default(0),
  // Chain E: total chunks the publisher will send. The public endpoint returns
  // 404 until count(distinct chunk_seq) reaches this, so a killed upload never
  // serves a partial share. Default 1 (a single-request share is complete at once).
  expectedChunks: integer('expected_chunks').notNull().default(1),
  redactions: jsonb('redactions').notNull().default({}),
  // Chain B: bigint (number mode) — a share can grow past int32 (2 GB) up to
  // the 1 GB per-share cap, and int32 would overflow on large multi-chunk shares.
  bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
});

export const shareMessages = pgTable(
  'share_messages',
  {
    shareId: uuid('share_id').notNull().references(() => shares.id, { onDelete: 'cascade' }),
    chunkSeq: integer('chunk_seq').notNull().default(0),
    seq: integer('seq').notNull(),
    role: text('role').notNull(),
    time: timestamp('time', { withTimezone: true }),
    parts: jsonb('parts').notNull(),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.chunkSeq, t.seq] })],
);

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
});
