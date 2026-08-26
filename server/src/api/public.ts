import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { and, asc, eq, gt } from 'drizzle-orm';
import { shares, shareMessages } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { UNLOCK_TTL_MS, signUnlockCookie, unlockCookieName, verifyUnlockCookie } from '../security/unlock.js';
import { verifyPassword } from '../security/password.js';
import { RateLimiter, IpWindow } from '../security/rate-limit.js';
import { unlockBodySchema } from './schema.js';

export interface PublicDeps {
  db: Db;
  config: Config;
  unlockLimiter: RateLimiter;
  ipWindow: IpWindow;
}

// Behind the documented reverse proxy the leftmost XFF hop is the real client
// IP. The server is loopback-bound and fronted by a proxy that sets XFF, so a
// direct client cannot inject a spoofed value — the proxy overwrites it. If the
// server is ever exposed directly, set `trustProxy` to false to ignore XFF and
// rate-limit on the socket address instead (which would then be the proxy).
function clientIp(c: Context, trustProxy = true): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    const xri = c.req.header('x-real-ip');
    if (xri) return xri;
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

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue;
    if (part.slice(0, eqIdx).trim() === name) return part.slice(eqIdx + 1).trim();
  }
  return undefined;
}

function clampLimit(raw: string | undefined): number {
  const n = raw === undefined ? 50 : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50;
}

function parseCursor(raw: string | undefined): number {
  const n = raw === undefined ? 0 : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Unknown and revoked tokens both return null -> identical 404 bodies (no existence oracle). */
async function activeShareByToken(c: Context, db: Db) {
  const token = c.req.param('token') ?? '';
  const rows = await db.select().from(shares).where(eq(shares.token, token)).limit(1);
  const share = rows[0];
  if (!share || share.revokedAt) return null;
  return share;
}

export function publicRoutes(deps: PublicDeps): Hono {
  const { db, config } = deps;
  const app = new Hono();

  app.get('/api/public/chats/:token', async (c) => {
    if (!deps.ipWindow.allow(clientIp(c))) {
      return c.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, 429);
    }
    const share = await activeShareByToken(c, db);
    if (!share) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
      return c.json({ error: { code: 'expired', message: 'This share has expired' } }, 410);
    }
    if (share.passwordHash) {
      const value = parseCookie(c.req.header('cookie'), unlockCookieName(share.token));
      if (!verifyUnlockCookie(config.unlockSecret, share.token, value)) {
        return c.json({ error: { code: 'needs_password', message: 'This share is password protected' } }, 401);
      }
    }
    const limit = clampLimit(c.req.query('limit'));
    const cursor = parseCursor(c.req.query('cursor'));
    const rows = await db
      .select()
      .from(shareMessages)
      .where(and(eq(shareMessages.shareId, share.id), gt(shareMessages.seq, cursor)))
      .orderBy(asc(shareMessages.seq))
      .limit(limit);
    const nextCursor = rows.length === limit ? rows[rows.length - 1]!.seq : null;
    return c.json({
      meta: {
        title: share.title,
        model: share.model,
        provider: share.provider,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        messageCount: share.messageCount,
        redactions: share.redactions,
      },
      messages: rows.map((r) => ({ seq: r.seq, role: r.role, time: r.time, parts: r.parts })),
      nextCursor,
    });
  });

  app.post('/api/public/chats/:token/unlock', async (c) => {
    const share = await activeShareByToken(c, db);
    if (!share) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
      return c.json({ error: { code: 'expired', message: 'This share has expired' } }, 410);
    }
    if (!share.passwordHash) {
      return c.json({ error: { code: 'no_password', message: 'This share has no password' } }, 400);
    }
    const key = `${share.token}:${clientIp(c)}`;
    if (deps.unlockLimiter.isLocked(key)) {
      return c.json({ error: { code: 'rate_limited', message: 'Too many failed attempts. Try again in 15 minutes.' } }, 429);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = unlockBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'validation', message: 'password is required' } }, 400);
    }
    const ok = await verifyPassword(share.passwordHash, parsed.data.password);
    if (!ok) {
      deps.unlockLimiter.recordFailure(key);
      return c.json({ error: { code: 'bad_password', message: 'Incorrect password' } }, 401);
    }
    deps.unlockLimiter.reset(key);
    const value = signUnlockCookie(config.unlockSecret, share.token, Date.now() + UNLOCK_TTL_MS);
    c.header(
      'Set-Cookie',
      `${unlockCookieName(share.token)}=${value}; HttpOnly; Secure; SameSite=Strict; Max-Age=1800; Path=/`,
    );
    return c.json({ ok: true });
  });

  return app;
}
