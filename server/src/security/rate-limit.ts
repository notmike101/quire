import { eq, sql } from 'drizzle-orm';
import { unlockLockouts } from '../db/schema.js';
import type { Db } from '../db/client.js';

/**
 * Pluggable persistence for the unlock lockout. The in-memory map is the
 * default fast path; a Postgres-backed store (see PostgresLockoutStore) makes
 * a 15-minute lockout survive a process restart.
 */
export interface LockoutStore {
  isLocked(key: string, now: number): Promise<boolean>;
  recordFailure(key: string, now: number): Promise<void>;
  reset(key: string): Promise<void>;
}

/**
 * 5 failures -> 15-minute lockout, keyed per (token, IP). When no store is
 * wired the state is in-memory (fine for a single container); when a store is
 * provided it is the source of truth so a restart does not clear a lockout.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; lockedUntil: number }>();
  constructor(
    private readonly maxFails = 5,
    private readonly lockMs = 15 * 60 * 1000,
    _unused?: unknown,
    private readonly store?: LockoutStore,
  ) {}

  async isLocked(key: string, now: number = Date.now()): Promise<boolean> {
    if (this.store) return this.store.isLocked(key, now);
    const e = this.hits.get(key);
    return !!e && e.lockedUntil > now;
  }

  async recordFailure(key: string, now: number = Date.now()): Promise<void> {
    if (this.store) {
      await this.store.recordFailure(key, now);
      return;
    }
    this.prune(now);
    const e = this.hits.get(key) ?? { count: 0, lockedUntil: 0 };
    e.count += 1;
    if (e.count >= this.maxFails) {
      e.lockedUntil = now + this.lockMs;
      e.count = 0;
    }
    this.hits.set(key, e);
  }

  async reset(key: string): Promise<void> {
    if (this.store) {
      await this.store.reset(key);
      return;
    }
    this.hits.delete(key);
  }

  private prune(now: number): void {
    if (this.hits.size < 10_000) return;
    // Drop expired lockouts AND idle sub-threshold counters so an adversary
    // cycling distinct (token, IP) keys cannot exhaust memory (M12).
    for (const [k, e] of this.hits) if (e.lockedUntil < now && (e.count === 0 || e.lockedUntil === 0)) this.hits.delete(k);
  }
}

/**
 * Postgres-backed lockout store (Chain C). Reads/writes the unlock_lockouts
 * table so a restart does not clear a 15-minute lockout. `maxFails` and
 * `lockMs` mirror the RateLimiter defaults so the threshold/lockout match the
 * in-memory behavior.
 *
 * Round 7: the per-IP limiter (threshold 5) and the per-token limiter
 * (threshold 25) share this one table. Two problems that sharing created:
 *   (1) The per-IP store's opportunistic prune deleted ANY idle sub-threshold
 *       row (count < 5) — including the per-token store's counters, which are
 *       accumulating toward 25. A slow per-token attack (a few failures per
 *       token, spread over the lockout window) was reset to 0 by the per-IP
 *       prune before it could ever reach 25, defeating the per-token backstop.
 *   (2) There was no namespace, so the two stores' rows were indistinguishable.
 * The fix: every key is written under a store-specific `keyPrefix` (ip: / tok:)
 * and the prune is scoped to that prefix. The per-token store additionally sets
 * `pruneSubThreshold: false` — its rows are bounded by the number of shares
 * (one token each, owner-created, not attacker-cyclable), so it only drops
 * EXPIRED lockouts and keeps sub-threshold counters so a slow attack accumulates.
 */
export class PostgresLockoutStore implements LockoutStore {
  constructor(
    private readonly db: Db,
    private readonly maxFails = 5,
    private readonly lockMs = 15 * 60 * 1000,
    private readonly keyPrefix = '',
    private readonly pruneSubThreshold = true,
  ) {}

  async isLocked(key: string, now: number): Promise<boolean> {
    const rows = await this.db.select().from(unlockLockouts).where(eq(unlockLockouts.key, this.keyPrefix + key)).limit(1);
    const r = rows[0];
    return !!r && r.lockedUntil !== null && r.lockedUntil.getTime() > now;
  }

  async recordFailure(key: string, now: number): Promise<void> {
    // Prune opportunistically so the table does not grow without bound under a
    // (token, IP) cycling attack. Scoped to this store's keyPrefix so the
    // per-IP store (threshold 5) never touches the per-token store's (threshold
    // 25) rows. Two classes are removed:
    //   1. expired lockouts (locked_until in the past) — always dropped, and
    //   2. idle sub-threshold counters — a row that has never locked and whose
    //      last failure is older than the lockout window will never reach the
    //      threshold on its own, so it is safe to drop. (Round 4: the old prune
    //      removed only expired lockouts, so a one-shot burst of 100k distinct
    //      keys left 100k sub-threshold rows that were never re-touched.)
    // Round 7: class 2 is only dropped when pruneSubThreshold is true. The
    // per-token store (false) keeps its sub-threshold counters so a slow
    // per-token attack accumulates to the threshold instead of being reset.
    // postgres.js serializes raw sql parameters as text; an ISO string is the
    // canonical form Postgres accepts for a timestamptz comparison. The key
    // prefix is a fixed literal (ip:/tok:) — the % is the LIKE wildcard and the
    // token's own characters (base64url may include _) are matched by it, not
    // treated as pattern wildcards.
    const expiredBefore = new Date(now).toISOString();
    const idleBefore = new Date(now - this.lockMs).toISOString();
    if (this.pruneSubThreshold) {
      await this.db.execute(
        sql`delete from unlock_lockouts
            where key like ${this.keyPrefix + '%'}
              and ((locked_until is not null and locked_until < ${expiredBefore})
                 or (locked_until is null and count < ${this.maxFails} and last_seen < ${idleBefore}))`,
      );
    } else {
      await this.db.execute(
        sql`delete from unlock_lockouts
            where key like ${this.keyPrefix + '%'}
              and locked_until is not null and locked_until < ${expiredBefore}`,
      );
    }
    // Round 7: atomic upsert. The old SELECT-then-INSERT/UPDATE was a
    // check-then-act race: two concurrent failures on a fresh key both saw "no
    // row" and both INSERTed (the loser hit the key PK -> unhandled 500), and
    // two on an existing key both read the same stale count and both wrote
    // count+1 (one failure silently lost, delaying the lockout). A single
    // ON CONFLICT upsert makes the increment + lock transition atomic. The
    // `locked_until > now` branch preserves an already-active lock: a failure
    // that races in AFTER the key just locked must not reset it (the handler's
    // isLocked check is the primary gate, but two requests can both pass it).
    const k = this.keyPrefix + key;
    const nowIso = new Date(now).toISOString();
    const lockUntil = new Date(now + this.lockMs).toISOString();
    await this.db.execute(
      sql`insert into unlock_lockouts (key, count, locked_until, last_seen)
          values (${k}, 1, null, ${nowIso})
          on conflict (key) do update
          set count = case
                when unlock_lockouts.locked_until > ${nowIso} then unlock_lockouts.count
                when unlock_lockouts.count + 1 >= ${this.maxFails} then 0
                else unlock_lockouts.count + 1
              end,
              locked_until = case
                when unlock_lockouts.locked_until > ${nowIso} then unlock_lockouts.locked_until
                when unlock_lockouts.count + 1 >= ${this.maxFails} then ${lockUntil}
                else null
              end,
              last_seen = ${nowIso}`,
    );
  }

  async reset(key: string): Promise<void> {
    await this.db.delete(unlockLockouts).where(eq(unlockLockouts.key, this.keyPrefix + key));
  }
}

/** Fixed 60-second window, 120 requests per IP, for the public content endpoint. */
export class IpWindow {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly maxPerWindow = 120,
    private readonly windowMs = 60 * 1000,
    // Round 7: hard cap on the number of tracked windows (distinct IPs).
    private readonly maxEntries = 10_000,
  ) {}

  allow(ip: string, now: number = Date.now()): boolean {
    const w = this.windows.get(ip);
    if (!w || now - w.start >= this.windowMs) {
      // Round 7: HARD-CAP the map. The old prune only removed STALE windows and
      // only when size > 10_000, so an attacker spraying one fresh request from
      // 20_000 distinct IPs (all inside the window, none stale) grew the map to
      // 20_000 — unbounded memory (a DoS via the public endpoint). Before adding
      // a new window at/over the cap: evict stale windows; if still at cap, evict
      // the OLDEST window (by start) so the map stays bounded at ~maxEntries.
      // Evicting the oldest is a safe self-DoS trade-off: that window is closest
      // to expiring anyway, and dropping it only resets that one IP's counter.
      if (this.windows.size >= this.maxEntries) {
        for (const [k, e] of this.windows) if (now - e.start >= this.windowMs) this.windows.delete(k);
        if (this.windows.size >= this.maxEntries) {
          let oldest: string | null = null;
          let oldestStart = Infinity;
          for (const [k, e] of this.windows) if (e.start < oldestStart) { oldestStart = e.start; oldest = k; }
          if (oldest !== null) this.windows.delete(oldest);
        }
      }
      this.windows.set(ip, { start: now, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= this.maxPerWindow;
  }
}
