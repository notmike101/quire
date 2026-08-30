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
 */
export class PostgresLockoutStore implements LockoutStore {
  constructor(
    private readonly db: Db,
    private readonly maxFails = 5,
    private readonly lockMs = 15 * 60 * 1000,
  ) {}

  async isLocked(key: string, now: number): Promise<boolean> {
    const rows = await this.db.select().from(unlockLockouts).where(eq(unlockLockouts.key, key)).limit(1);
    const r = rows[0];
    return !!r && r.lockedUntil !== null && r.lockedUntil.getTime() > now;
  }

  async recordFailure(key: string, now: number): Promise<void> {
    // Prune opportunistically so the table does not grow without bound under a
    // (token, IP) cycling attack. Two classes are removed:
    //   1. expired lockouts (locked_until in the past), and
    //   2. idle sub-threshold counters — a row that has never locked and whose
    //      last failure is older than the lockout window will never reach the
    //      threshold on its own, so it is safe to drop. (Round 4: the old prune
    //      removed only expired lockouts, so a one-shot burst of 100k distinct
    //      keys left 100k sub-threshold rows that were never re-touched.)
    // postgres.js serializes raw sql parameters as text; an ISO string is the
    // canonical form Postgres accepts for a timestamptz comparison.
    const expiredBefore = new Date(now).toISOString();
    const idleBefore = new Date(now - this.lockMs).toISOString();
    await this.db.execute(
      sql`delete from unlock_lockouts
          where (locked_until is not null and locked_until < ${expiredBefore})
             or (locked_until is null and count < ${this.maxFails} and last_seen < ${idleBefore})`,
    );
    // Round 7: atomic upsert. The old SELECT-then-INSERT/UPDATE was a
    // check-then-act race: two concurrent failures on a fresh key both saw "no
    // row" and both INSERTed (the loser hit the key PK -> unhandled 500), and
    // two on an existing key both read the same stale count and both wrote
    // count+1 (one failure silently lost, delaying the lockout). A single
    // ON CONFLICT upsert makes the increment + lock transition atomic. The
    // `locked_until > now` branch preserves an already-active lock: a failure
    // that races in AFTER the key just locked must not reset it (the handler's
    // isLocked check is the primary gate, but two requests can both pass it).
    const nowIso = new Date(now).toISOString();
    const lockUntil = new Date(now + this.lockMs).toISOString();
    await this.db.execute(
      sql`insert into unlock_lockouts (key, count, locked_until, last_seen)
          values (${key}, 1, null, ${nowIso})
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
    await this.db.delete(unlockLockouts).where(eq(unlockLockouts.key, key));
  }
}

/** Fixed 60-second window, 120 requests per IP, for the public content endpoint. */
export class IpWindow {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly maxPerWindow = 120,
    private readonly windowMs = 60 * 1000,
  ) {}

  allow(ip: string, now: number = Date.now()): boolean {
    const w = this.windows.get(ip);
    if (!w || now - w.start >= this.windowMs) {
      // Evict only stale windows instead of clearing everything (M13): a
      // self-DoS of the limiter under an IP-scan burst would momentarily reset
      // the 120 req/min limit for every IP.
      if (this.windows.size > 10_000) {
        for (const [k, e] of this.windows) if (now - e.start >= this.windowMs) this.windows.delete(k);
      }
      this.windows.set(ip, { start: now, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= this.maxPerWindow;
  }
}
