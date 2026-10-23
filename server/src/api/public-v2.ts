import { Hono, type Context } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { unlockCookieName, verifyUnlockCookie } from '../security/unlock.js';
import { RateLimiter, IpWindow } from '../security/rate-limit.js';
import { getV2Blob, getV2PublicShareState, type V2PublicShareState } from '../share-v2/store.js';
import { v2Metrics } from '../metrics.js';
import { checkUnlock, clientIp, parseCookie } from './public.js';

export interface PublicV2Deps {
  db: Db;
  config: Config;
  unlockLimiter: RateLimiter;
  tokenLimiter: RateLimiter;
  ipWindow: IpWindow;
}

/**
 * Hide unknown and incomplete shares behind the same response.
 *
 * @param c - Request context used to create the response.
 * @returns The uniform not-found response.
 */
const notFound = (c: Context) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
/**
 * Report that a previously published share has expired.
 *
 * @param c - Request context used to create the response.
 * @returns An expired-share response.
 */
const expired = (c: Context) => c.json({ error: { code: 'expired', message: 'This share has expired' } }, 410);
/**
 * Ask the viewer to unlock a password-protected share.
 *
 * @param c - Request context used to create the response.
 * @returns A password-required response.
 */
const needsPassword = (c: Context) => c.json({ error: { code: 'needs_password', message: 'This share is password protected' } }, 401);

/**
 * Gating shared by every public v2 route (v1 parity): an unknown share and an
 * incomplete share (state !== 'ready') both return the uniform 404 (no
 * existence oracle — a killed upload never reveals its partial state); an
 * expired share returns 410 (it existed and is gone); a password-protected
 * share without a valid unlock cookie returns 401.
 *
 * @param c - Request context containing the share ID and unlock cookie.
 * @param db - Database used to load the public share state.
 * @param config - Configuration containing the unlock-cookie signing secret.
 * @returns Ready share state or the response denying access.
 */
async function gate(c: Context, db: Db, config: Config): Promise<V2PublicShareState | Response> {
  const shareId = c.req.param('shareId') ?? '';
  const state = await getV2PublicShareState(db, shareId);
  if (!state || state.state !== 'ready') return notFound(c);
  if (state.expiresAt && new Date(state.expiresAt).getTime() <= Date.now()) return expired(c);
  if (state.passwordHash) {
    const value = parseCookie(c.req.header('cookie'), unlockCookieName(shareId));
    if (!verifyUnlockCookie(config.unlockSecret, shareId, value)) return needsPassword(c);
  }
  return state;
}

// The seq columns are int4 (same as v1's cursor columns): a crafted oversized
// seq is clamped to the int32 max so it is just a miss (404), never a driver
// overflow 500. Non-integer and negative seqs are misses too.
const INT32_MAX = 2_147_483_647;
/**
 * Parse a blob sequence and clamp it to the database integer range.
 *
 * @param raw - Sequence route parameter.
 * @returns The parsed sequence, or -1 for invalid or negative values.
 */
function parseSeq(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(n) || n < 0) return -1;
  return Math.min(n, INT32_MAX);
}

// Serves one stored ciphertext envelope (the viewer decrypts — the server
// never re-encrypts or touches plaintext). The stored SHA-256 digest must
// match the envelope bytes before they are served (defense in depth: a
// corrupt row must not reach the viewer as an undecryptable blob); on
// mismatch the row is broken server-side, so 500, never the corrupt bytes.
/**
 * Gate access and serve a ciphertext blob only after verifying its stored digest.
 *
 * @param c - Request context containing the share ID and unlock cookie.
 * @param db - Database containing the share and blob.
 * @param config - Server configuration used to validate access.
 * @param kind - Blob family to retrieve.
 * @param seq - Sequence within the selected blob family.
 * @returns Ciphertext bytes or an access, missing-blob, or integrity error.
 */
async function serveBlob(c: Context, db: Db, config: Config, kind: 'manifest' | 'index' | 'page', seq: number): Promise<Response> {
  const t0 = Date.now();
  /**
   * Record the blob request's status, byte count, and elapsed time.
   *
   * @param status - HTTP response status.
   * @param bytes - Served ciphertext bytes, when available.
   * @returns No value; the metric bucket is updated in place.
   */
  const note = (status: number, bytes?: number) => v2Metrics.record('v2_blob_serve', status, { bytes, latencyMs: Date.now() - t0 });
  const gated = await gate(c, db, config);
  if (gated instanceof Response) {
    note(gated.status);
    return gated;
  }
  if (seq < 0) {
    note(404);
    return notFound(c);
  }
  const blob = await getV2Blob(db, gated.id, kind, seq);
  if (!blob) {
    note(404);
    return notFound(c);
  }
  const actual = createHash('sha256').update(blob.ciphertext).digest();
  const expected = Buffer.from(blob.digest, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    note(500);
    // Canary (Task 15): a row whose digest no longer matches its ciphertext
    // can never decrypt — the only decrypt failure the server can observe.
    v2Metrics.record('v2_client_decrypt_error', 500, { latencyMs: Date.now() - t0 });
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  }
  note(200, blob.ciphertext.byteLength);
  // Buffer.from: Hono's body wants an ArrayBuffer-backed view; the driver
  // value is already ArrayBuffer-backed, so this is a bounded (≤4 MiB) copy.
  return c.body(Buffer.from(blob.ciphertext), 200, { 'content-type': 'application/octet-stream' });
}

/**
 * Build rate-limited bootstrap, ciphertext, and password-unlock routes.
 *
 * @param deps - Public-route dependencies.
 * @param deps.db - Database containing sealed shares.
 * @param deps.config - Server configuration for cookies and proxy handling.
 * @param deps.unlockLimiter - Failed-unlock limiter keyed by share and IP.
 * @param deps.tokenLimiter - Failed-unlock limiter keyed by share alone.
 * @param deps.ipWindow - Request-volume limiter shared across public endpoints.
 * @returns The router mounted under the v2 API prefix.
 */
export function publicV2Routes({ db, config, unlockLimiter, tokenLimiter, ipWindow }: PublicV2Deps): Hono {
  const app = new Hono();

  // Per-IP volume window shared with v1's public endpoints: bounds total
  // per-IP request volume on every path, not just the failure paths.
  /**
   * Consume the caller's public-request allowance.
   *
   * @param c - Request context used to identify the caller.
   * @returns A rate-limit response when exhausted, otherwise undefined.
   */
  const volumeLimited = (c: Context): Response | undefined =>
    ipWindow.allow(clientIp(c, config.trustProxy))
      ? undefined
      : c.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, 429);

  app.get('/shares/:shareId/bootstrap', async (c) => {
    const limited = volumeLimited(c);
    if (limited) return limited;
    const gated = await gate(c, db, config);
    if (gated instanceof Response) return gated;
    // No transcript content or title here: those live in the encrypted
    // manifest blob.
    return c.json({
      state: 'ready',
      expiresAt: gated.expiresAt,
      expired: false,
      passwordRequired: gated.passwordHash !== null,
    });
  });

  app.get('/shares/:shareId/blobs/manifest/0', async (c) => {
    const limited = volumeLimited(c);
    if (limited) return limited;
    return serveBlob(c, db, config, 'manifest', 0);
  });

  app.get('/shares/:shareId/blobs/index/:seq', async (c) => {
    const limited = volumeLimited(c);
    if (limited) return limited;
    return serveBlob(c, db, config, 'index', parseSeq(c.req.param('seq')));
  });

  app.get('/shares/:shareId/blobs/page/:seq', async (c) => {
    const limited = volumeLimited(c);
    if (limited) return limited;
    return serveBlob(c, db, config, 'page', parseSeq(c.req.param('seq')));
  });

  app.post('/shares/:shareId/unlock', async (c) => {
    const limited = volumeLimited(c);
    if (limited) return limited;
    const shareId = c.req.param('shareId') ?? '';
    const state = await getV2PublicShareState(db, shareId);
    if (!state || state.state !== 'ready') return notFound(c);
    if (state.expiresAt && new Date(state.expiresAt).getTime() <= Date.now()) return expired(c);
    // A live share without a password returns the same 404 as an unknown
    // share: a distinct no_password response would be a liveness oracle.
    if (!state.passwordHash) return notFound(c);
    return checkUnlock(c, { unlockLimiter, tokenLimiter, config }, shareId, state.passwordHash);
  });

  return app;
}
