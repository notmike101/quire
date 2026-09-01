import { Hono, type Context } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { unlockCookieName, verifyUnlockCookie } from '../security/unlock.js';
import { RateLimiter, IpWindow } from '../security/rate-limit.js';
import { getV2Blob, getV2PublicShareState, type V2PublicShareState } from '../share-v2/store.js';
import { checkUnlock, clientIp, parseCookie } from './public.js';

export interface PublicV2Deps {
  db: Db;
  config: Config;
  unlockLimiter: RateLimiter;
  tokenLimiter: RateLimiter;
  ipWindow: IpWindow;
}

const notFound = (c: Context) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
const expired = (c: Context) => c.json({ error: { code: 'expired', message: 'This share has expired' } }, 410);
const needsPassword = (c: Context) => c.json({ error: { code: 'needs_password', message: 'This share is password protected' } }, 401);

/**
 * Gating shared by every public v2 route (v1 parity): an unknown share and an
 * incomplete share (state !== 'ready') both return the uniform 404 (no
 * existence oracle — a killed upload never reveals its partial state); an
 * expired share returns 410 (it existed and is gone); a password-protected
 * share without a valid unlock cookie returns 401.
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
async function serveBlob(c: Context, db: Db, config: Config, kind: 'manifest' | 'index' | 'page', seq: number): Promise<Response> {
  const gated = await gate(c, db, config);
  if (gated instanceof Response) return gated;
  if (seq < 0) return notFound(c);
  const blob = await getV2Blob(db, gated.id, kind, seq);
  if (!blob) return notFound(c);
  const actual = createHash('sha256').update(blob.ciphertext).digest();
  const expected = Buffer.from(blob.digest, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  }
  // Buffer.from: Hono's body wants an ArrayBuffer-backed view; the driver
  // value is already ArrayBuffer-backed, so this is a bounded (≤4 MiB) copy.
  return c.body(Buffer.from(blob.ciphertext), 200, { 'content-type': 'application/octet-stream' });
}

export function publicV2Routes({ db, config, unlockLimiter, tokenLimiter, ipWindow }: PublicV2Deps): Hono {
  const app = new Hono();

  // Per-IP volume window shared with v1's public endpoints: bounds total
  // per-IP request volume on every path, not just the failure paths.
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
