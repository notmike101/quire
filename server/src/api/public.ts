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

// Round 6: the first-page response carries the full-share user-message index
// (one rail tick per user message, so the viewer can render the whole rail
// before the transcript lazy-loads). Without a bound, a share at the 1 GB cap
// with a very large number of user messages makes this projection O(share-size)
// Postgres work on EVERY first-page load AND ships an enormous userIndex array
// that the viewer would render as thousands of rail ticks (a client-side DoS).
// The rail is a convenience — a share with more user messages than this shows
// the first MAX_RAIL_USER_ENTRIES ticks; the full transcript is still reachable
// by scrolling. 2000 is far beyond any realistic share and bounds both the
// query and the rendered DOM.
const MAX_RAIL_USER_ENTRIES = 2000;

export interface PublicDeps {
  db: Db;
  config: Config;
  unlockLimiter: RateLimiter;
  // Round 6: a SECOND lockout dimension keyed by token ALONE (no IP). The
  // per-(token, IP) limiter above is evadable by rotating source IPs; this one
  // accumulates failures across all IPs for a given token, so an IP-rotating
  // brute-forcer eventually locks the token. It uses a higher threshold (wired
  // in app.ts) so ordinary multi-user access (a few people each mistyping once)
  // does not trip it.
  tokenLimiter: RateLimiter;
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
// Round 9 (B-F3): the seq columns are int4. Number.parseInt('99999999999999999999')
// is 1e20 and Number.isInteger(1e20) is TRUE, so an oversized cursor sailed
// through the old check into SQL, where the int4 cast overflowed and the
// request 500'd. Clamp to the int32 max so a crafted cursor is just an empty
// page, never an error.
const INT32_MAX = 2_147_483_647;
function parseCursor(raw: string | undefined): Cursor {
  if (raw === undefined) return { chunkSeq: 0, seq: 0 };
  const idx = raw.indexOf(':');
  if (idx < 0) return { chunkSeq: 0, seq: 0 };
  const chunkSeq = Number.parseInt(raw.slice(0, idx), 10);
  const seq = Number.parseInt(raw.slice(idx + 1), 10);
  const clamp = (n: number) => (Number.isInteger(n) && n >= 0 ? Math.min(n, INT32_MAX) : 0);
  return { chunkSeq: clamp(chunkSeq), seq: clamp(seq) };
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
    // Round 8: 410 (GONE) for an expired share is DELIBERATE, not an oracle.
    // The no-existence-oracle invariant covers unknown-vs-revoked tokens (both
    // return byte-identical 404s above). An expired token was once valid, and
    // 410 is the semantically correct status for a resource that existed and is
    // gone; tokens are high-entropy random, so an attacker cannot enumerate
    // them to distinguish "expired" from "never existed".
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
            .limit(MAX_RAIL_USER_ENTRIES)
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
    // Round 8: same deliberate 410 for the expired case (see the GET handler).
    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
      return c.json({ error: { code: 'expired', message: 'This share has expired' } }, 410);
    }
    // A live share without a password returns the same 404 as an unknown token:
    // a distinct no_password response would let an attacker separate live from
    // dead tokens (a liveness oracle).
    if (!share.passwordHash) {
      return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    }
    // Two lockout dimensions (Round 6): per-(token, IP) for the normal case,
    // plus a per-token (IP-independent) dimension so an IP-rotating brute-forcer
    // cannot evade the lock by cycling source addresses. Either tripping it
    // locks the share for the window; a successful unlock clears both.
    const ipKey = `${share.token}:${clientIp(c, config.trustProxy)}`;
    const tokenKey = share.token;
    if ((await deps.unlockLimiter.isLocked(ipKey)) || (await deps.tokenLimiter.isLocked(tokenKey))) {
      return c.json({ error: { code: 'rate_limited', message: 'Too many failed attempts. Try again in 15 minutes.' } }, 429);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = unlockBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'validation', message: 'password is required' } }, 400);
    }
    const ok = await verifyPassword(share.passwordHash, parsed.data.password);
    if (!ok) {
      await deps.unlockLimiter.recordFailure(ipKey);
      await deps.tokenLimiter.recordFailure(tokenKey);
      return c.json({ error: { code: 'bad_password', message: 'Incorrect password' } }, 401);
    }
    await deps.unlockLimiter.reset(ipKey);
    await deps.tokenLimiter.reset(tokenKey);
    const value = signUnlockCookie(config.unlockSecret, share.token, Date.now() + UNLOCK_TTL_MS);
    c.header(
      'Set-Cookie',
      `${unlockCookieName(share.token)}=${value}; HttpOnly; Secure; SameSite=Strict; Max-Age=1800; Path=/`,
    );
    return c.json({ ok: true });
  });

  return app;
}
