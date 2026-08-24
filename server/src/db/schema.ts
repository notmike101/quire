import { pgTable, uuid, text, timestamp, integer, jsonb, primaryKey } from 'drizzle-orm/pg-core';

export const shares = pgTable('shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  token: text('token').notNull().unique(),
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
  bytes: integer('bytes').notNull().default(0),
});

export const shareMessages = pgTable(
  'share_messages',
  {
    shareId: uuid('share_id').notNull().references(() => shares.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').notNull(),
    time: timestamp('time', { withTimezone: true }),
    parts: jsonb('parts').notNull(),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.seq] })],
);
