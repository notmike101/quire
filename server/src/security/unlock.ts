import { createHmac, timingSafeEqual } from 'node:crypto';

export const UNLOCK_TTL_MS = 30 * 60 * 1000;

/**
 * Derive the per-share unlock-cookie name.
 *
 * @param token - Public share identifier.
 * @returns The cookie name scoped to that share.
 */
export function unlockCookieName(token: string): string {
  return `quire_unlock_${token}`;
}

/**
 * Sign a stateless per-share unlock token containing its expiration.
 *
 * @param secret - Server-side HMAC signing secret.
 * @param token - Public share identifier bound into the signature.
 * @param expiresAtMs - Expiration time in epoch milliseconds.
 * @returns The expiration in seconds followed by its base64url HMAC.
 */
export function signUnlockCookie(secret: string, token: string, expiresAtMs: number): string {
  const epoch = Math.floor(expiresAtMs / 1000);
  const mac = createHmac('sha256', secret).update(`${token}|${epoch}`).digest('base64url');
  return `${epoch}.${mac}`;
}

/**
 * Validate a share-bound cookie's expiration and HMAC.
 *
 * @param secret - Server-side HMAC signing secret.
 * @param token - Public share identifier expected in the signature.
 * @param cookie - Cookie value supplied by the client, if present.
 * @param nowMs - Current epoch time in milliseconds.
 * @returns Whether the cookie is unexpired and has the expected signature.
 */
export function verifyUnlockCookie(
  secret: string,
  token: string,
  cookie: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!cookie) return false;
  const dot = cookie.indexOf('.');
  if (dot < 0) return false;
  const epoch = Number(cookie.slice(0, dot));
  const mac = cookie.slice(dot + 1);
  if (!Number.isInteger(epoch) || epoch * 1000 <= nowMs) return false;
  const expected = createHmac('sha256', secret).update(`${token}|${epoch}`).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
