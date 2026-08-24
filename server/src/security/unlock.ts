import { createHmac, timingSafeEqual } from 'node:crypto';

export const UNLOCK_TTL_MS = 30 * 60 * 1000;

export function unlockCookieName(token: string): string {
  return `quire_unlock_${token}`;
}

/** Stateless per-share unlock token: "<expiryEpoch>.<HMAC-SHA256(secret, "<token>|<expiryEpoch>")>". */
export function signUnlockCookie(secret: string, token: string, expiresAtMs: number): string {
  const epoch = Math.floor(expiresAtMs / 1000);
  const mac = createHmac('sha256', secret).update(`${token}|${epoch}`).digest('base64url');
  return `${epoch}.${mac}`;
}

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
