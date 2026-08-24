import { Hono, type Context } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { shares, shareMessages } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { generateShareToken } from '../security/token.js';
import { hashPassword } from '../security/password.js';
import { prepareContent } from '../redact/prepare.js';
import { createBodySchema, patchBodySchema, previewBodySchema } from './schema.js';

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
    const [share] = await db
      .insert(shares)
      .values({
        token,
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
    if (!share) throw new Error('insert returned no row');
    await db
      .insert(shareMessages)
      .values(
        prepared.messages.map((m, i) => ({
          shareId: share.id,
          seq: i + 1,
          role: m.role,
          time: m.time ? new Date(m.time) : null,
          parts: m.parts,
        })),
      );
    return c.json({ token, url: `/chats/${token}`, summary: prepared.summary, bytes: prepared.bytes, messageCount: prepared.messageCount }, 201);
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
