import { Hono, type Context } from 'hono';
import { desc, eq, sql } from 'drizzle-orm';
import { createHash, timingSafeEqual } from 'node:crypto';
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

export function apiKeyOk(c: Context, config: Config): boolean {
  const [scheme, value] = (c.req.header('authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !value) return false;
  // Round 7: compare SHA-256 DIGESTS, not raw bytes. The old
  // `a.length === b.length` gate was a length oracle: a wrong-length key
  // short-circuited before timingSafeEqual (faster) while a right-length wrong
  // key ran the full comparison (slower), so an attacker could binary-search
  // the key's length by timing 401s. Digests are always 32 bytes, so
  // timingSafeEqual is always valid (no length gate) and constant-time
  // regardless of the input length — the server-side hash of config.apiKey is
  // constant across requests, so its length is not leaked.
  const a = createHash('sha256').update(value).digest();
  const b = createHash('sha256').update(config.apiKey).digest();
  return timingSafeEqual(a, b);
}

// Thrown inside the chunk transaction when the atomic cap-enforcing UPDATE
// matched 0 rows (a concurrent chunk crossed the 1 GB cap between the fast-path
// check and the write). Caught outside and mapped to the same 413 as the
// fast path so the response is uniform.
class ShareCapExceeded extends Error {}

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

// Round 9 (B-F1): Postgres caps a single statement at 65535 bind parameters.
// Each share_messages row binds 6 (share_id, chunk_seq, seq, role, time, parts —
// nulls count), so a single multi-row INSERT of 10924+ rows is a 500 on a VALID
// payload (the schema allows up to 100_000 messages per session). Batch the
// values into statements of at most 10_000 rows (60_000 params, under the cap).
const INSERT_BATCH_ROWS = 10_000;
type MessageInsert = {
  insert: (table: typeof shareMessages) => {
    values: (rows: typeof shareMessages.$inferInsert[]) => Promise<unknown>;
  };
};
async function insertMessagesBatched(tx: MessageInsert, rows: typeof shareMessages.$inferInsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH_ROWS) {
    await tx.insert(shareMessages).values(rows.slice(i, i + INSERT_BATCH_ROWS));
  }
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
    // otherwise store and serve a fully unredacted share (the core invariant:
    // only redacted content is ever stored or served). Round 9 (F7): the CLI
    // now rejects 'none' client-side (publish.ts) — the old --confirm-raw
    // escape hatch was dead (it passed the client gate, then hit this 400).
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
      await insertMessagesBatched(
        tx,
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
    // Round 7: chunkSeq must be within the share's declared chunk budget. Create
    // seeds chunk 0, so the valid seqs are 1..expectedChunks-1. Without this a
    // single-chunk share (expectedChunks=1) could accept unlimited sequential
    // chunks (each bounded by the 20 MB request cap, total by the 1 GB share
    // cap), breaking the expectedChunks contract and growing the per-chunk
    // "select all chunkSeqs" query without bound.
    if (chunkSeq >= share.expectedChunks) {
      return c.json({ error: { code: 'validation', message: `chunkSeq ${chunkSeq} exceeds expectedChunks ${share.expectedChunks}` } }, 400);
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
    // Round 8: aggregate instead of SELECTing every row. The old query fetched
    // one row per message in the share — O(share-size): a share at the 1 GB cap
    // is hundreds of thousands of rows, re-fetched on EVERY chunk upload, and
    // Math.max(...seqs) would also hit the argument-spread limit past ~100k
    // elements. Two aggregates over the (share_id, chunk_seq) PK prefix are
    // O(1) per chunk.
    const [agg] = await db
      .select({
        maxSeq: sql<number | null>`max(${shareMessages.chunkSeq})`,
        dupCount: sql<number>`count(*) filter (where ${shareMessages.chunkSeq} = ${chunkSeq})::int`,
      })
      .from(shareMessages)
      .where(eq(shareMessages.shareId, share.id));
    if ((agg?.dupCount ?? 0) > 0) {
      return c.json({ error: { code: 'chunk_exists', message: 'chunkSeq already uploaded' } }, 409);
    }
    const maxSeq = agg?.maxSeq ?? -1;
    if (chunkSeq !== maxSeq + 1) {
      return c.json({ error: { code: 'chunk_out_of_order', message: `chunkSeq must be ${maxSeq + 1}` } }, 400);
    }
    // Round 7: the pre-transaction checks above (wouldExceedCap, seqs.has,
    // contiguity) are fast paths only — they read stale state. Two races are
    // closed atomically here:
    //   (a) a concurrent duplicate chunkSeq passes the seqs.has() check and both
    //       INSERTs race the (share_id, chunk_seq, seq) PK -> the loser throws
    //       23505 -> mapped to the same 409 the fast path returns (was: 500);
    //   (b) a concurrent chunk pushes the share over the 1 GB cap between the
    //       wouldExceedCap() read and the bytes increment -> the cap is enforced
    //       in the UPDATE's WHERE clause; 0 rows means the cap was crossed ->
    //       413 and the transaction rolls back the messages (was: the cap could
    //       be overshot by up to one 20 MB request).
    try {
      const updated = await db.transaction(async (tx) => {
        // Round 11 (S-2): re-read the share row under a FOR UPDATE lock so the
        // redactions merge below uses the CURRENT committed value, not the stale
        // snapshot read before the transaction (the `share` const at the top of
        // this handler). A concurrent chunk upload that commits between that
        // pre-tx read and this merge would otherwise have its per-rule counts
        // dropped — the merge would use the stale base and overwrite the
        // concurrent chunk's contribution. The row lock serializes concurrent
        // chunk uploads: each reads the latest committed redactions before
        // merging its own summary.
        const [locked] = await tx
          .select()
          .from(shares)
          .where(eq(shares.id, share.id))
          .for('update');
        await insertMessagesBatched(
          tx,
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
        const [row] = await tx
          .update(shares)
          .set({
            messageCount: agg!.n,
            bytes: sql`"shares"."bytes" + ${prepared.bytes}`,
            // Round 10 (I2): SUM the per-rule counts across chunks (was a shallow
            // `jsonb ||` merge that kept the last chunk's count on key conflict).
            // Round 11 (S-2): merge from the FOR UPDATE-locked current value,
            // not the stale pre-tx snapshot (see the lock at the top of the tx).
            redactions: mergeRedactionSummary((locked?.redactions ?? {}) as Record<string, number>, prepared.summary),
          })
          // Round 7: enforce the cap in the same statement as the increment so a
          // concurrent chunk cannot overshoot it. 0 rows = cap crossed.
          .where(sql`${shares.id} = ${share.id} and "shares"."bytes" + ${prepared.bytes} <= ${MAX_SHARE_BYTES}`)
          .returning();
        if (!row) throw new ShareCapExceeded();
        return row;
      });
      // Round 9 (C-F9): return this chunk's redaction summary so the CLI can
      // aggregate redaction counts across the whole chunked session (the
      // create response only carries chunk 0's summary).
      return c.json({ ok: true, messageCount: updated.messageCount, bytes: updated.bytes, summary: prepared.summary });
    } catch (e) {
      if (e instanceof ShareCapExceeded) {
        return c.json({ error: { code: 'too_large', message: 'Share would exceed the 1 GB per-share cap' } }, 413);
      }
      if (isUniqueViolation(e)) {
        return c.json({ error: { code: 'chunk_exists', message: 'chunkSeq already uploaded' } }, 409);
      }
      throw e;
    }
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
