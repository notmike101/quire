import { type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Config } from '../config.js';
import { UNLOCK_TTL_MS, signUnlockCookie, unlockCookieName } from '../security/unlock.js';
import { verifyPassword } from '../security/password.js';
import type { RateLimiter } from '../security/rate-limit.js';
import { unlockBodySchema } from './schema.js';

// Chain C: a well-formed IP is a 4-octet IPv4 (each <= 255) or a colon-grouped
// IPv6. Anything else (a hostname, "not-an-ip", a port, garbage) is rejected so
// a broken proxy assumption cannot let a client choose its own rate-limit key.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/**
 * Check whether a proxy header contains a supported IPv4 or IPv6 address.
 *
 * @param s - Candidate address without a port.
 * @returns Whether the address passes the proxy-header format checks.
 */
function isWellFormedIp(s: string): boolean {
  if (IPV4_RE.test(s)) return s.split('.').every((o) => Number(o) <= 255);
  if (s.includes(':')) return /^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$/.test(s);
  return false;
}

// The rate-limit / lockout key MUST be a value the client cannot control. By
// default (trustProxy=false) we use the socket address, which is always safe:
// a direct client cannot spoof it. When a deployment fronts the server with a
// proxy, it sets TRUST_PROXY=true and we use the RIGHTMOST XFF hop instead:
// every proxy appends the peer it saw to the right end of the list, so the
// rightmost entry is the one the IMMEDIATE (trusted) proxy wrote — a client
// behind that proxy can prepend spoofed entries but cannot control the
// rightmost one. This is correct for both append-style proxies (Cloudflare:
// "spoofed, real-client") and overwrite-style single-entry proxies. The hop
// is still validated as a well-formed IP, then we fall back to x-real-ip, then
// the socket address, so a malformed/absent header cannot pick the key.
// (Round 9 B-F2: the old LEFTMOST choice was attacker-controlled behind
// Cloudflare — the client's own XFF value — letting it cycle keys to evade the
// per-IP unlock lockout and content throttle.)
/**
 * Select the socket address or a validated hop supplied by a trusted proxy.
 *
 * @param c - Request context containing headers and connection information.
 * @param trustProxy - Whether the immediate proxy's address headers are trusted.
 * @returns The rate-limit address, or "unknown" when no connection is available.
 */
export function clientIp(c: Context, trustProxy = false): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const last = xff.split(',').pop()?.trim();
      if (last && isWellFormedIp(last)) return last;
    }
    const xri = c.req.header('x-real-ip');
    if (xri && isWellFormedIp(xri)) return xri;
  }
  // Socket address as seen by the Node server (the proxy when fronted). The
  // Node server attaches the IncomingMessage to c.env; under the Hono test
  // harness (app.request) there is no socket, so fall back to a stable key.
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Find an unmodified cookie value in a request header.
 *
 * @param header - Raw Cookie header, if present.
 * @param name - Cookie name to match exactly.
 * @returns The trimmed value of the first matching cookie, if any.
 */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue;
    if (part.slice(0, eqIdx).trim() === name) return part.slice(eqIdx + 1).trim();
  }
  return undefined;
}

/**
 * Shared unlock core for the v2 public routes, called after the route's own
 * gating (404 unknown, 410 expired, 404 no-password). `shareId` is the share's
 * publicId: it drives the cookie name and both lockout keys. Two lockout
 * dimensions (Round 6): per-(shareId, IP) for the normal case, plus a
 * per-shareId (IP-independent) dimension so an IP-rotating brute-forcer cannot
 * evade the lock by cycling source addresses. Either tripping it locks the
 * share for the window; a successful unlock clears both. Returns a Response
 * for every terminal outcome: 429 locked, 400 malformed body, 401 wrong
 * password (failure recorded), 200 (cookie set).
 *
 * @param c - Request context containing the password body and client address.
 * @param deps - Unlock dependencies shared by the public routes.
 * @param deps.unlockLimiter - Failure limiter for the share-and-IP pair.
 * @param deps.tokenLimiter - Failure limiter shared by all IPs for this share.
 * @param deps.config - Server configuration for proxy trust and cookie signing.
 * @param shareId - Public share identifier used in cookies and limiter keys.
 * @param passwordHash - Stored password hash to verify.
 * @returns The unlock result, setting a signed cookie only on success.
 */
export async function checkUnlock(
  c: Context,
  deps: { unlockLimiter: RateLimiter; tokenLimiter: RateLimiter; config: Config },
  shareId: string,
  passwordHash: string,
): Promise<Response> {
  const ipKey = `${shareId}:${clientIp(c, deps.config.trustProxy)}`;
  const tokenKey = shareId;
  if ((await deps.unlockLimiter.isLocked(ipKey)) || (await deps.tokenLimiter.isLocked(tokenKey))) {
    return c.json({ error: { code: 'rate_limited', message: 'Too many failed attempts. Try again in 15 minutes.' } }, 429);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = unlockBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'validation', message: 'password is required' } }, 400);
  }
  const ok = await verifyPassword(passwordHash, parsed.data.password);
  if (!ok) {
    await deps.unlockLimiter.recordFailure(ipKey);
    await deps.tokenLimiter.recordFailure(tokenKey);
    return c.json({ error: { code: 'bad_password', message: 'Incorrect password' } }, 401);
  }
  await deps.unlockLimiter.reset(ipKey);
  await deps.tokenLimiter.reset(tokenKey);
  setUnlockCookie(c, deps.config, shareId);
  return c.json({ ok: true });
}

/**
 * Sets the stateless unlock cookie for a share.
 *
 * @param c - Request context whose response receives the cookie.
 * @param config - Server configuration containing the signing secret.
 * @param shareId - Public share identifier bound into the cookie signature.
 */
export function setUnlockCookie(c: Context, config: Config, shareId: string): void {
  const value = signUnlockCookie(config.unlockSecret, shareId, Date.now() + UNLOCK_TTL_MS);
  c.header('Set-Cookie', `${unlockCookieName(shareId)}=${value}; HttpOnly; Secure; SameSite=Strict; Max-Age=1800; Path=/`);
}
