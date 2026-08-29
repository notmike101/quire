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
import { MAX_SHARE_BYTES, wouldExceedCap } from './headers.js';

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
    // Round 3: 'none' is rejected at the API boundary — a direct API call could
    // otherwise store and serve a fully unredacted share (the CLI's --confirm-raw
    // gate is client-side only). The CLI never sends 'none' (it throws first).
    if (parsed.data.preset === 'none') {
      return c.json({ error: { code: 'validation', message: 'preset "none" (no redaction) is not accepted by the API' } }, 400);
    }
    const prepared = prepareContent(parsed.data.session, parsed.data.preset);
    return c.json({ messages: prepared.messages, summary: prepared.summary, bytes: prepared.bytes, messageCount: prepared.messageCount });
  });

  app.post('/api/chats', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'validation', message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
    }
    // Round 3: 'none' is rejected at the API boundary (see preview) — a direct
    // API call could otherwise store and serve a fully unredacted share.
    if (parsed.data.preset === 'none') {
      return c.json({ error: { code: 'validation', message: 'preset "none" (no redaction) is not accepted by the API' } }, 400);
    }
    const { session, preset, password, expiresAt, expectedChunks } = parsed.data;
    const prepared = prepareContent(session, preset);
    // Chain B: enforce the cumulative per-share cap at create.
    if (wouldExceedCap(0, prepared.bytes)) {
      return c.json({ error: { code: 'too_large', message: 'Share exceeds the 1 GB per-share cap' } }, 413);
    }
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
          // Round 3: store the REDACTED title/model/provider (prepareContent
          // redacts them — a title like "Debugging AWS key AKIA…" is a leak).
          title: prepared.title,
          model: prepared.model ?? null,
          provider: prepared.provider ?? null,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          passwordHash: password ? await hashPassword(password) : null,
          preset,
          messageCount: prepared.messageCount,
          expectedChunks,
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
    // Chunks carry only messages (the session meta was set at create), so wrap
    // them in a minimal session for the shared prepareContent signature.
    const prepared = prepareContent({ sessionId: '', title: '', messages }, share.preset as 'strict' | 'normal' | 'none');
    // Chain B: enforce the cumulative per-share cap on every chunk.
    if (wouldExceedCap(share.bytes, prepared.bytes)) {
      return c.json({ error: { code: 'too_large', message: 'Share would exceed the 1 GB per-share cap' } }, 413);
    }
    // Chain B: chunks must be contiguous. The create call seeds chunk 0, so the
    // next valid chunkSeq is (max existing chunkSeq) + 1. A duplicate is 409, a
    // gap or out-of-order seq is 400.
    const existing = await db
      .select({ chunkSeq: shareMessages.chunkSeq })
      .from(shareMessages)
      .where(eq(shareMessages.shareId, share.id));
    const seqs = new Set(existing.map((r) => r.chunkSeq));
    if (seqs.has(chunkSeq)) {
      return c.json({ error: { code: 'chunk_exists', message: 'chunkSeq already uploaded' } }, 409);
    }
    const maxSeq = seqs.size === 0 ? -1 : Math.max(...seqs);
    if (chunkSeq !== maxSeq + 1) {
      return c.json({ error: { code: 'chunk_out_of_order', message: `chunkSeq must be ${maxSeq + 1}` } }, 400);
    }
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
      // Chain B: recompute messageCount from the rows (count(*)) rather than a
      // blind +N; bytes is the exact running total (each chunk's bytes are known
      // at ingest). bytes is bigint now, so the arithmetic stays in SQL.
      const [agg] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(shareMessages)
        .where(eq(shareMessages.shareId, share.id));
      const [updated] = await tx
        .update(shares)
        .set({
          messageCount: agg!.n,
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
