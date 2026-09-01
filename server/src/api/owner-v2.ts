import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createHash, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { SHARE_PROTOCOL } from '@quire/protocol';
import { sharesV2 } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { hashPassword } from '../security/password.js';
import { prepareContent } from '../redact/prepare.js';
import type { Preset } from '../redact/rules.js';
import { apiKeyOk } from './owner.js';
import { messageSchema, shapedSessionSchema } from './schema.js';
import { acceptV2SourceChunk, createV2Upload, finalizeV2Upload, ShareV2Error } from '../share-v2/store.js';
import { v2Metrics } from '../metrics.js';

export interface OwnerV2Deps {
  db: Db;
  config: Config;
}

// base64url of exactly 32 bytes (the AES-256-GCM content key): 43 chars, no
// padding. The key is held in memory only — never persisted or logged.
const CONTENT_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

// 'none' stays in the enum so its rejection is v1's uniform explicit 400, not
// a zod message (a direct API call must not be able to store unredacted
// content — same boundary as v1).
const presetSchema = z.enum(['strict', 'normal', 'none']);

const createShareV2BodySchema = z
  .object({
    protocol: z.literal(SHARE_PROTOCOL),
    uploadRequestId: z.string().min(1).max(64),
    preset: presetSchema.default('strict'),
    password: z.string().min(1).max(200).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    sourceChunkCount: z.number().int().positive().max(10_000),
    contentKey: z.string().regex(CONTENT_KEY_RE),
    session: shapedSessionSchema,
  })
  .strict();

const chunkV2BodySchema = z
  .object({
    protocol: z.literal(SHARE_PROTOCOL),
    contentKey: z.string().regex(CONTENT_KEY_RE),
    messages: z.array(messageSchema).min(1),
  })
  .strict();

const finalizeV2BodySchema = z
  .object({
    protocol: z.literal(SHARE_PROTOCOL),
    contentKey: z.string().regex(CONTENT_KEY_RE),
  })
  .strict();

// The uniform 404. Unknown share, revoked share, and wrong/missing
// X-Upload-Token all return this exact body — no existence oracle.
const notFound = (c: Context) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);

// Uniform error body for store failures. A store-level 404 (the row was
// revoked between the route's existence check and the store's lock) must be
// byte-identical to the route-level 404 — no existence oracle. The store
// carries plain numbers; Hono's json() wants a status-literal type, hence
// the cast.
const fail = (c: Context, status: number, code: string) =>
  status === 404
    ? notFound(c)
    : c.json({ error: { code, message: code } }, status as ContentfulStatusCode);

// Read the body exactly once: the raw bytes are both the SHA-256 digest input
// (byte-exact idempotency) and the JSON parse source. The body stream is
// consumed by arrayBuffer(), so c.req.json() could not re-read it anyway.
async function rawBody(c: Context): Promise<{ body: unknown; digest: string }> {
  const raw = new Uint8Array(await c.req.raw.arrayBuffer());
  const digest = createHash('sha256').update(raw).digest('hex');
  let body: unknown = null;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    body = null;
  }
  return { body, digest };
}

function decodeContentKey(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

// SHA-256(header) vs the stored hex digest, constant-time. Both sides are 32
// bytes (the stored hash is always a 64-char hex digest), so timingSafeEqual
// is valid with no length gate — same no-oracle shape as the API-key compare
// in owner.ts. The length check only guards a corrupt row from a throw.
async function uploadTokenOk(uploadTokenHash: string, c: Context): Promise<boolean> {
  const header = c.req.header('x-upload-token');
  if (!header) return false;
  const a = createHash('sha256').update(header).digest();
  const b = Buffer.from(uploadTokenHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function ownerV2Routes({ db, config }: OwnerV2Deps): Hono {
  const app = new Hono();

  app.use('/shares/*', async (c, next) => {
    if (!apiKeyOk(c, config)) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid API key' } }, 401);
    }
    await next();
  });

  app.post('/shares', async (c) => {
    const t0 = Date.now();
    const note = (status: number, bytes?: number) => v2Metrics.record('v2_create', status, { bytes, latencyMs: Date.now() - t0 });
    const { body, digest } = await rawBody(c);
    const parsed = createShareV2BodySchema.safeParse(body);
    if (!parsed.success) {
      note(400);
      return c.json({ error: { code: 'validation', message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
    }
    // Same uniform rejection as v1 (see owner.ts create): 'none' would store
    // unredacted content.
    if (parsed.data.preset === 'none') {
      note(400);
      return c.json({ error: { code: 'validation', message: 'preset "none" (no redaction) is not accepted by the API' } }, 400);
    }
    const { uploadRequestId, preset, password, expiresAt, sourceChunkCount, contentKey, session } = parsed.data;
    try {
      // Redaction happens inside createV2Upload (the authoritative
      // prepareContent pass); the route only validates and forwards.
      const created = await createV2Upload(db, config, {
        uploadRequestId,
        contentKey: decodeContentKey(contentKey),
        session,
        preset,
        passwordHash: password ? await hashPassword(password) : null,
        expiresAt: expiresAt ?? null,
        sourceChunkCount,
        requestDigest: digest,
      });
      note(201, created.bytes);
      return c.json(
        {
          shareId: created.publicId,
          uploadToken: created.uploadToken,
          acceptedSourceChunk: 0,
          redactions: created.redactions,
          messageCount: created.messageCount,
          bytes: created.bytes,
        },
        201,
      );
    } catch (e) {
      if (e instanceof ShareV2Error) {
        note(e.status);
        return fail(c, e.status, e.code);
      }
      note(500);
      throw e;
    }
  });

  app.put('/shares/:shareId/source-chunks/:seq', async (c) => {
    const t0 = Date.now();
    const note = (status: number, bytes?: number) => v2Metrics.record('v2_chunk', status, { bytes, latencyMs: Date.now() - t0 });
    const seq = Number(c.req.param('seq'));
    if (!Number.isInteger(seq) || seq < 0) {
      note(400);
      return c.json({ error: { code: 'validation', message: 'invalid chunk seq' } }, 400);
    }
    const { body, digest } = await rawBody(c);
    const parsed = chunkV2BodySchema.safeParse(body);
    if (!parsed.success) {
      note(400);
      return c.json({ error: { code: 'validation', message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
    }
    const [row] = await db.select().from(sharesV2).where(eq(sharesV2.publicId, c.req.param('shareId') ?? '')).limit(1);
    if (!row) {
      note(404);
      return notFound(c);
    }
    if (!(await uploadTokenOk(row.uploadTokenHash, c))) {
      note(404);
      return notFound(c);
    }
    // Chunks carry only messages. Wrap them in a synthetic session carrying the
    // STORED (already-redacted) meta fields so prepareContent's meta pass is an
    // idempotent no-op on the counts — the store never redacts; this is the
    // authoritative pass for this chunk.
    const prepared = prepareContent(
      {
        sessionId: '',
        title: row.title ?? '',
        model: row.model ?? undefined,
        provider: row.provider ?? undefined,
        messages: parsed.data.messages,
      },
      row.preset as Preset,
    );
    let result;
    try {
      result = await acceptV2SourceChunk(db, config, {
        id: row.id,
        publicId: row.publicId,
        contentKey: decodeContentKey(parsed.data.contentKey),
        chunkSeq: seq,
        prepared,
        requestDigest: digest,
      });
    } catch (e) {
      // The row can be deleted (revoke) between the existence check above and
      // the store's FOR UPDATE lock: same uniform 404, no oracle.
      if (e instanceof ShareV2Error) {
        note(e.status);
        return fail(c, e.status, e.code);
      }
      note(500);
      throw e;
    }
    if (result.ok === false) {
      note(result.status);
      return fail(c, result.status, result.code);
    }
    // Re-read after the store's transaction commits so the response carries
    // the accumulated (not stale) counters.
    const [after] = await db.select().from(sharesV2).where(eq(sharesV2.id, row.id)).limit(1);
    if (!after) {
      note(404);
      return notFound(c);
    }
    note(200, after.bytes);
    return c.json({
      acceptedSourceChunk: seq,
      redactions: after.redactions,
      messageCount: after.messageCount,
      bytes: after.bytes,
    });
  });

  app.post('/shares/:shareId/finalize', async (c) => {
    const t0 = Date.now();
    const note = (status: number, bytes?: number) => v2Metrics.record('v2_finalize', status, { bytes, latencyMs: Date.now() - t0 });
    const { body } = await rawBody(c);
    const parsed = finalizeV2BodySchema.safeParse(body);
    if (!parsed.success) {
      note(400);
      return c.json({ error: { code: 'validation', message: parsed.error.issues[0]?.message ?? 'invalid body' } }, 400);
    }
    const [row] = await db.select().from(sharesV2).where(eq(sharesV2.publicId, c.req.param('shareId') ?? '')).limit(1);
    if (!row) {
      note(404);
      return notFound(c);
    }
    if (!(await uploadTokenOk(row.uploadTokenHash, c))) {
      note(404);
      return notFound(c);
    }
    try {
      const result = await finalizeV2Upload(db, config, {
        id: row.id,
        publicId: row.publicId,
        contentKey: decodeContentKey(parsed.data.contentKey),
      });
      if ('ok' in result) {
        note(result.status);
        return fail(c, result.status, result.code);
      }
      // Key-free by construction: the store's summary carries no content key
      // and no upload token.
      note(200, result.bytes);
      return c.json(result);
    } catch (e) {
      if (e instanceof ShareV2Error) {
        note(e.status);
        return fail(c, e.status, e.code);
      }
      note(500);
      throw e;
    }
  });

  return app;
}
