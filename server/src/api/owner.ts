import { Hono, type Context } from 'hono';
import { desc, eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { shares, shareMessages } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { generateShareToken, generateUploadId } from '../security/token.js';
import { hashPassword } from '../security/password.js';
import { prepareContent } from '../redact/prepare.js';
import { chunkBodySchema, createBodySchema, patchBodySchema, previewBodySchema } from './schema.js';

export interface OwnerDeps {
  db: Db;
  config: Config;
}

function apiKeyOk(c: Context, config: Config): boolean {
  const [scheme, value] = (c.req.header('authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(config.apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function ownerRoutes({ db, config }: OwnerDeps): Hono {
  const app = new Hono();

  app.use('/api/chats/*', async (c, next) => {
    if (!apiKeyOk(c, config)) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid API key' } }, 401);
    }
    await next();
  });

  app.post('/api/chats/preview', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = previewBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'validation', message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
    }
    const prepared = prepareContent(parsed.data.session.messages, parsed.data.preset);
    return c.json({ messages: prepared.messages, summary: prepared.summary, bytes: prepared.bytes, messageCount: prepared.messageCount });
  });

  app.post('/api/chats', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'validation', message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
    }
    const { session, preset, password, expiresAt } = parsed.data;
    const prepared = prepareContent(session.messages, preset);
    const token = generateShareToken();
    const uploadId = generateUploadId();
    // Both inserts are atomic: if the messages batch fails (e.g. an unexpected
    // payload shape), the shares row rolls back too — no orphan share with a
    // messageCount but no messages.
    const share = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(shares)
        .values({
          token,
          uploadId,
          sessionId: session.sessionId,
          title: session.title,
          model: session.model ?? null,
          provider: session.provider ?? null,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          passwordHash: password ? await hashPassword(password) : null,
          preset,
          messageCount: prepared.messageCount,
          redactions: prepared.summary,
          bytes: prepared.bytes,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      await tx
        .insert(shareMessages)
        .values(
          prepared.messages.map((m, i) => ({
            shareId: row.id,
            chunkSeq: 0,
            seq: i + 1,
            role: m.role,
            time: m.time ? new Date(m.time) : null,
            parts: m.parts,
          })),
        );
      return row;
    });
    return c.json({ token, url: `/chats/${token}`, uploadId, chunkCount: 1, summary: prepared.summary, bytes: prepared.bytes, messageCount: prepared.messageCount }, 201);
  });

  app.post('/api/chats/:token/chunks', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = chunkBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'validation', message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
    }
    const { uploadId, chunkSeq, messages } = parsed.data;
    const rows = await db.select().from(shares).where(eq(shares.token, c.req.param('token') ?? '')).limit(1);
    const share = rows[0];
    if (!share) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    if (share.uploadId !== uploadId) {
      return c.json({ error: { code: 'upload_id_mismatch', message: 'uploadId does not match this share' } }, 400);
    }
    const prepared = prepareContent(messages, share.preset as 'strict' | 'normal' | 'none');
    const result = await db.transaction(async (tx) => {
      await tx
        .insert(shareMessages)
        .values(
          prepared.messages.map((m, i) => ({
            shareId: share.id,
            chunkSeq,
            seq: i + 1,
            role: m.role,
            time: m.time ? new Date(m.time) : null,
            parts: m.parts,
          })),
        );
      const [updated] = await tx
        .update(shares)
        .set({
          messageCount: sql`"shares"."message_count" + ${prepared.messageCount}`,
          bytes: sql`"shares"."bytes" + ${prepared.bytes}`,
          redactions: sql`(${shares.redactions}) || ${JSON.stringify(prepared.summary)}::jsonb`,
        })
        .where(eq(shares.id, share.id))
        .returning();
      return updated;
    });
    return c.json({ ok: true, messageCount: result!.messageCount, bytes: result!.bytes });
  });

  app.get('/api/chats', async (c) => {
    const rows = await db.select().from(shares).orderBy(desc(shares.createdAt)).limit(200);
    return c.json({
      shares: rows.map((s) => ({
        token: s.token,
        title: s.title,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        hasPassword: s.passwordHash !== null,
        revoked: s.revokedAt !== null,
        messageCount: s.messageCount,
        preset: s.preset,
      })),
    });
  });

  app.get('/api/chats/:token', async (c) => {
    const rows = await db.select().from(shares).where(eq(shares.token, c.req.param('token') ?? '')).limit(1);
    const s = rows[0];
    if (!s) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    return c.json({
      token: s.token,
      title: s.title,
      model: s.model,
      provider: s.provider,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      hasPassword: s.passwordHash !== null,
      revokedAt: s.revokedAt,
      preset: s.preset,
      messageCount: s.messageCount,
      redactions: s.redactions,
      bytes: s.bytes,
    });
  });

  app.patch('/api/chats/:token', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = patchBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'validation', message: 'invalid body' } }, 400);
    }
    const { password, expiresAt, revoke } = parsed.data;
    const set: Partial<typeof shares.$inferInsert> = {};
    if (password !== undefined) set.passwordHash = password === null ? null : await hashPassword(password);
    if (expiresAt !== undefined) set.expiresAt = expiresAt === null ? null : new Date(expiresAt);
    if (revoke === true) set.revokedAt = new Date();
    if (Object.keys(set).length === 0) return c.json({ error: { code: 'validation', message: 'invalid body' } }, 400);
    const rows = await db.update(shares).set(set).where(eq(shares.token, c.req.param('token') ?? '')).returning();
    if (rows.length === 0) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    return c.json({ ok: true });
  });

  app.delete('/api/chats/:token', async (c) => {
    const rows = await db.update(shares).set({ revokedAt: new Date() }).where(eq(shares.token, c.req.param('token') ?? '')).returning();
    if (rows.length === 0) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    return c.json({ ok: true });
  });

  return app;
}
