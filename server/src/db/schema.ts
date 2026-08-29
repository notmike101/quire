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
});
