import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
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

// Chain C: a well-formed IP is a 4-octet IPv4 (each <= 255) or a colon-grouped
// IPv6. Anything else (a hostname, "not-an-ip", a port, garbage) is rejected so
// a broken proxy assumption cannot let a client choose its own rate-limit key.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function isWellFormedIp(s: string): boolean {
  if (IPV4_RE.test(s)) return s.split('.').every((o) => Number(o) <= 255);
  if (s.includes(':')) return /^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$/.test(s);
  return false;
}

// Behind the documented reverse proxy the leftmost XFF hop is the real client
// IP. The server is loopback-bound and fronted by a proxy that sets XFF, so a
// direct client cannot inject a spoofed value — the proxy overwrites it. We
// still VALIDATE the hop is a well-formed IP and fall back to x-real-ip, then
// the socket address, so a malformed/absent header cannot pick the key. If the
// server is ever exposed directly, set TRUST_PROXY=false to ignore XFF entirely
// and rate-limit on the socket address (which would then be the proxy).
export function clientIp(c: Context, trustProxy = true): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first && isWellFormedIp(first)) return first;
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

interface Cursor { chunkSeq: number; seq: number }
function parseCursor(raw: string | undefined): Cursor {
  if (raw === undefined) return { chunkSeq: 0, seq: 0 };
  const idx = raw.indexOf(':');
  if (idx < 0) return { chunkSeq: 0, seq: 0 };
  const chunkSeq = Number.parseInt(raw.slice(0, idx), 10);
  const seq = Number.parseInt(raw.slice(idx + 1), 10);
  return {
    chunkSeq: Number.isInteger(chunkSeq) && chunkSeq >= 0 ? chunkSeq : 0,
    seq: Number.isInteger(seq) && seq >= 0 ? seq : 0,
  };
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
    if (!deps.ipWindow.allow(clientIp(c, config.trustProxy))) {
      return c.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, 429);
    }
    const share = await activeShareByToken(c, db);
    if (!share) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
      return c.json({ error: { code: 'expired', message: 'This share has expired' } }, 410);
    }
    // Chain E: a chunked share is not ready until all expected chunks have
    // arrived. Incomplete shares return the SAME 404 as not-found (no existence
    // oracle) so a killed upload never serves a partial share as complete.
    const [chunkAgg] = await db
      .select({ n: sql<number>`count(distinct "chunk_seq")::int` })
      .from(shareMessages)
      .where(eq(shareMessages.shareId, share.id));
    if ((chunkAgg?.n ?? 0) < (share.expectedChunks ?? 1)) {
      return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    }
    if (share.passwordHash) {
      const value = parseCookie(c.req.header('cookie'), unlockCookieName(share.token));
      if (!verifyUnlockCookie(config.unlockSecret, share.token, value)) {
        return c.json({ error: { code: 'needs_password', message: 'This share is password protected' } }, 401);
      }
    }
    const limit = clampLimit(c.req.query('limit'));
    const rawCursor = c.req.query('cursor');
    const { chunkSeq, seq } = parseCursor(rawCursor);
    const after = or(
      gt(shareMessages.chunkSeq, chunkSeq),
      and(eq(shareMessages.chunkSeq, chunkSeq), gt(shareMessages.seq, seq)),
    );
    const [rows, userRows] = await Promise.all([
      db
        .select()
        .from(shareMessages)
        .where(and(eq(shareMessages.shareId, share.id), after))
        .orderBy(asc(shareMessages.chunkSeq), asc(shareMessages.seq))
        .limit(limit),
      // The rail renders one tick per user message for the WHOLE share, so the
      // viewer needs the full user-message index up front (not just the loaded
      // page). Chain B: the preview is computed SERVER-SIDE via jsonb extraction
      // (first non-empty text part, left 80) instead of selecting the full
      // `parts` jsonb for every user message — a long share would otherwise
      // ship its entire transcript in this tiny projection.
      rawCursor === undefined
        ? db
            .select({
              seq: shareMessages.seq,
              preview: sql<string>`left(
                coalesce(
                  (select (elem->>'text') from jsonb_array_elements("parts") as elem
                    where elem->>'type' = 'text' and coalesce((elem->>'text'),'') <> ''
                    limit 1),
                  ''
                ), 80)`,
            })
            .from(shareMessages)
            .where(and(eq(shareMessages.shareId, share.id), eq(shareMessages.role, 'user')))
            .orderBy(asc(shareMessages.chunkSeq), asc(shareMessages.seq))
        : Promise.resolve([] as { seq: number; preview: string }[]),
    ]);
    const last = rows[rows.length - 1];
    const nextCursor = rows.length === limit && last ? `${last.chunkSeq}:${last.seq}` : null;
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
      messages: rows.map((r) => ({ chunkSeq: r.chunkSeq, seq: r.seq, role: r.role, time: r.time, parts: r.parts })),
      userIndex: rawCursor === undefined ? (userRows as { seq: number; preview: string }[]).map((r) => ({ seq: r.seq, preview: (r.preview ?? '').replace(/\s+/g, ' ').trim() })) : undefined,
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
    const key = `${share.token}:${clientIp(c, config.trustProxy)}`;
    if (await deps.unlockLimiter.isLocked(key)) {
      return c.json({ error: { code: 'rate_limited', message: 'Too many failed attempts. Try again in 15 minutes.' } }, 429);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = unlockBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'validation', message: 'password is required' } }, 400);
    }
    const ok = await verifyPassword(share.passwordHash, parsed.data.password);
    if (!ok) {
      await deps.unlockLimiter.recordFailure(key);
      return c.json({ error: { code: 'bad_password', message: 'Incorrect password' } }, 401);
    }
    await deps.unlockLimiter.reset(key);
    const value = signUnlockCookie(config.unlockSecret, share.token, Date.now() + UNLOCK_TTL_MS);
    c.header(
      'Set-Cookie',
      `${unlockCookieName(share.token)}=${value}; HttpOnly; Secure; SameSite=Strict; Max-Age=1800; Path=/`,
    );
    return c.json({ ok: true });
  });

  return app;
}
