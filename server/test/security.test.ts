import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { generateShareToken, generateUploadId } from '../src/security/token.js';
import { hashPassword, verifyPassword } from '../src/security/password.js';
import { signUnlockCookie, verifyUnlockCookie, UNLOCK_TTL_MS, unlockCookieName } from '../src/security/unlock.js';
import { RateLimiter, IpWindow, PostgresLockoutStore } from '../src/security/rate-limit.js';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';

describe('generateShareToken', () => {
  it('is 22 base64url chars (128 bits)', () => {
    const t = generateShareToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  it('is unique across 1000 draws', () => {
    const set = new Set(Array.from({ length: 1000 }, () => generateShareToken()));
    expect(set.size).toBe(1000);
  });
});

describe('generateUploadId', () => {
  it('returns 32 lowercase hex chars and is unique', () => {
    const a = generateUploadId();
    const b = generateUploadId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('password (argon2id)', () => {
  it('hashes and verifies the right password', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h).toContain('$argon2id$');
    // Pin the argon2id parameters (M14): a regression to weaker params must fail.
    expect(h).toMatch(/\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    await expect(verifyPassword(h, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(h, 'wrong')).resolves.toBe(false);
  });
  it('verifyPassword is false on a malformed hash, never throws', async () => {
    await expect(verifyPassword('not-a-hash', 'x')).resolves.toBe(false);
  });
});

describe('unlock cookie', () => {
  const secret = 's'.repeat(64);
  it('round-trips for the same token', () => {
    const now = Date.now();
    const c = signUnlockCookie(secret, 'tok123', now + UNLOCK_TTL_MS);
    expect(verifyUnlockCookie(secret, 'tok123', c, now)).toBe(true);
  });
  it('rejects a different token', () => {
    const now = Date.now();
    const c = signUnlockCookie(secret, 'tok123', now + UNLOCK_TTL_MS);
    expect(verifyUnlockCookie(secret, 'other', c, now)).toBe(false);
  });
  it('rejects a tampered mac', () => {
    const now = Date.now();
    const c = signUnlockCookie(secret, 'tok123', now + UNLOCK_TTL_MS);
    const tampered = c.slice(0, -2) + (c.endsWith('aa') ? 'bb' : 'aa');
    expect(verifyUnlockCookie(secret, 'tok123', tampered, now)).toBe(false);
  });
  it('rejects expired cookies', () => {
    const now = Date.now();
    const c = signUnlockCookie(secret, 'tok123', now - 1000);
    expect(verifyUnlockCookie(secret, 'tok123', c, now)).toBe(false);
  });
  it('rejects garbage and undefined', () => {
    expect(verifyUnlockCookie(secret, 't', undefined)).toBe(false);
    expect(verifyUnlockCookie(secret, 't', 'garbage')).toBe(false);
  });
  it('cookie name is bound to the token', () => {
    expect(unlockCookieName('abc')).toBe('quire_unlock_abc');
  });
});

describe('RateLimiter (5 fails -> 15 min lockout)', () => {
  const t0 = 1_000_000;
  it('locks on the 5th failure and unlocks after 15 minutes', async () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 4; i++) { await rl.recordFailure('k', t0 + i); expect(await rl.isLocked('k', t0 + i)).toBe(false); }
    await rl.recordFailure('k', t0 + 4);
    expect(await rl.isLocked('k', t0 + 5)).toBe(true);
    expect(await rl.isLocked('k', t0 + 4 + 15 * 60 * 1000 + 1)).toBe(false);
  });
  it('reset clears the counter', async () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 4; i++) await rl.recordFailure('k', t0 + i);
    await rl.reset('k');
    await rl.recordFailure('k', t0 + 10);
    expect(await rl.isLocked('k', t0 + 11)).toBe(false);
  });
});

describe('IpWindow (120 req/min)', () => {
  const t0 = 1_000_000;
  it('allows 120 then blocks within the window', () => {
    const w = new IpWindow();
    for (let i = 0; i < 120; i++) expect(w.allow('1.2.3.4', t0 + i)).toBe(true);
    expect(w.allow('1.2.3.4', t0 + 120)).toBe(false);
  });
  it('different IPs are independent', () => {
    const w = new IpWindow(2, 60_000);
    expect(w.allow('a', t0)).toBe(true);
    expect(w.allow('a', t0 + 1)).toBe(true);
    expect(w.allow('a', t0 + 2)).toBe(false);
    expect(w.allow('b', t0 + 2)).toBe(true);
  });
  it('a new window resets the count', () => {
    const w = new IpWindow(2, 60_000);
    w.allow('a', t0); w.allow('a', t0 + 1);
    expect(w.allow('a', t0 + 60_000 + 1)).toBe(true);
  });
  it('stays bounded at maxEntries under a fresh-IP spray (L7)', () => {
    // An attacker spraying one fresh request from many distinct IPs (all inside
    // the window, none stale) must not grow the map without bound. The hard cap
    // evicts the oldest window when at maxEntries, so size stays <= maxEntries.
    const w = new IpWindow(120, 60_000, 100); // maxEntries = 100
    for (let i = 0; i < 500; i++) w.allow(`10.0.0.${i}`, t0); // 500 distinct IPs, all fresh
    const size = (w as unknown as { windows: Map<string, unknown> }).windows.size;
    expect(size).toBeLessThanOrEqual(100);
  });
});

describe('PostgresLockoutStore (Chain C)', () => {
  let db: Db;
  beforeAll(async () => {
    db = makeDb(url);
    await migrateDb(db);
  });
  it('persists unlock lockouts across RateLimiter instances (simulated restart)', async () => {
    const key = 'persist-test-key';
    await db.execute(sql`delete from unlock_lockouts where key = ${key}`);
    const store = new PostgresLockoutStore(db);
    const a = new RateLimiter(5, 15 * 60 * 1000, undefined, store);
    for (let i = 0; i < 5; i++) await a.recordFailure(key);
    expect(await a.isLocked(key)).toBe(true);
    // A NEW limiter (simulating a process restart) with the same store is still locked.
    const b = new RateLimiter(5, 15 * 60 * 1000, undefined, store);
    expect(await b.isLocked(key)).toBe(true);
    await b.reset(key);
    expect(await b.isLocked(key)).toBe(false);
    await db.execute(sql`delete from unlock_lockouts where key = ${key}`);
  });
  it('prunes idle sub-threshold rows on the next recordFailure (Round 4)', async () => {
    // A key-cycling attack leaves many distinct keys that never reach the
    // threshold and are never re-touched. The opportunistic prune must drop an
    // idle sub-threshold row (last_seen older than the lockout window) so the
    // table does not grow without bound.
    const idleKey = 'r4-idle-prune-key';
    const freshKey = 'r4-fresh-prune-key';
    const now = Date.now();
    const lockMs = 15 * 60 * 1000;
    await db.execute(sql`delete from unlock_lockouts where key in (${idleKey}, ${freshKey})`);
    // Seed an IDLE sub-threshold row: count below max, last_seen 20 min ago.
    await db.execute(sql`insert into unlock_lockouts (key, count, locked_until, last_seen)
        values (${idleKey}, 2, null, ${new Date(now - 20 * 60 * 1000).toISOString()})`);
    // Seed a FRESH sub-threshold row: count below max, last_seen now.
    await db.execute(sql`insert into unlock_lockouts (key, count, locked_until, last_seen)
        values (${freshKey}, 2, null, ${new Date(now).toISOString()})`);
    // A recordFailure for an unrelated key triggers the global prune.
    const store = new PostgresLockoutStore(db);
    await store.recordFailure('r4-unrelated-key', now);
    const [idleRow] = await db.execute(sql`select 1 from unlock_lockouts where key = ${idleKey}`);
    const [freshRow] = await db.execute(sql`select 1 from unlock_lockouts where key = ${freshKey}`);
    expect(idleRow).toBeUndefined(); // idle sub-threshold row was pruned
    expect(freshRow).toBeDefined();  // fresh sub-threshold row was kept
    await db.execute(sql`delete from unlock_lockouts where key in (${idleKey}, ${freshKey}, 'r4-unrelated-key')`);
  });
  it('concurrent recordFailure on a fresh key -> no lost updates, no 500 (Round 7)', async () => {
    // The old SELECT-then-INSERT/UPDATE was a check-then-act race: N concurrent
    // failures on a fresh key each saw "no row" and each INSERTed (N-1 losers hit
    // the key PK -> unhandled 500), and on an existing key each read the same
    // stale count and wrote count+1 (N-1 failures silently lost, delaying the
    // lockout). The atomic ON CONFLICT upsert closes both: every failure
    // increments exactly once. The pool (max 10) overlaps these 20 calls, so the
    // race is real. A high maxFails keeps it a pure increment (no lock transition).
    const key = 'r7-concurrent-upsert-key';
    const now = Date.now();
    await db.execute(sql`delete from unlock_lockouts where key = ${key}`);
    const store = new PostgresLockoutStore(db, 100, 15 * 60 * 1000);
    const N = 20;
    const results = await Promise.allSettled(Array.from({ length: N }, () => store.recordFailure(key, now)));
    for (const r of results) expect(r.status).toBe('fulfilled'); // no 500 from a PK collision
    const [row] = await db.execute(sql`select count from unlock_lockouts where key = ${key}`);
    expect(Number((row as { count: string | number }).count)).toBe(N); // no lost updates
    await db.execute(sql`delete from unlock_lockouts where key = ${key}`);
  });
  it('has indexes on unlock_lockouts.locked_until and last_seen (L5)', async () => {
    // The opportunistic prune deletes by locked_until OR last_seen on every
    // unlock failure. Without one index per OR branch that is a full table scan
    // on the hot path under a key-cycling attack.
    const rows = await db.execute(sql`
      select indexname from pg_indexes
      where tablename = 'unlock_lockouts'
        and indexname in ('unlock_lockouts_locked_until_idx', 'unlock_lockouts_last_seen_idx')
    `);
    const names = (rows as unknown as Array<{ indexname: string }>).map((r) => r.indexname).sort();
    expect(names).toEqual(['unlock_lockouts_last_seen_idx', 'unlock_lockouts_locked_until_idx']);
  });
  it('per-IP prune does not reset per-token sub-threshold counters (L6)', async () => {
    // The per-IP store (prefix 'ip:', pruneSubThreshold=true) and the per-token
    // store (prefix 'tok:', pruneSubThreshold=false) share the table. The per-IP
    // prune is scoped to 'ip:%', so it must NOT touch a 'tok:' row — even an idle
    // sub-threshold one (which the per-token store deliberately keeps).
    const now = Date.now();
    const lockMs = 15 * 60 * 1000;
    const tokKey = 'tok:idle-token-key';
    const ipKey = 'ip:idle-ip-key';
    await db.execute(sql`delete from unlock_lockouts where key in (${tokKey}, ${ipKey})`);
    // An IDLE per-token sub-threshold row (count 3, last_seen 20 min ago).
    await db.execute(sql`insert into unlock_lockouts (key, count, locked_until, last_seen)
        values (${tokKey}, 3, null, ${new Date(now - 20 * 60 * 1000).toISOString()})`);
    // An IDLE per-IP sub-threshold row (count 2, last_seen 20 min ago).
    await db.execute(sql`insert into unlock_lockouts (key, count, locked_until, last_seen)
        values (${ipKey}, 2, null, ${new Date(now - 20 * 60 * 1000).toISOString()})`);
    // A per-IP recordFailure triggers the per-IP prune (scoped to 'ip:%').
    const ipStore = new PostgresLockoutStore(db, 5, lockMs, 'ip:', true);
    await ipStore.recordFailure('some-ip', now);
    const [tokRow] = await db.execute(sql`select 1 from unlock_lockouts where key = ${tokKey}`);
    const [ipRow] = await db.execute(sql`select 1 from unlock_lockouts where key = ${ipKey}`);
    expect(tokRow).toBeDefined();  // per-token row untouched by the per-IP prune
    expect(ipRow).toBeUndefined(); // idle per-IP sub-threshold row was pruned
    await db.execute(sql`delete from unlock_lockouts where key in (${tokKey}, ${ipKey}, 'ip:some-ip')`);
  });
  it('per-token store keeps idle sub-threshold counters (L6)', async () => {
    // The per-token store (pruneSubThreshold=false) only drops EXPIRED lockouts,
    // never idle sub-threshold counters — so a slow per-token attack accumulates
    // to the threshold instead of being reset by a prune.
    const now = Date.now();
    const lockMs = 15 * 60 * 1000;
    const tokKey = 'tok:slow-token-key';
    await db.execute(sql`delete from unlock_lockouts where key = ${tokKey}`);
    // An IDLE per-token sub-threshold row (count 3, last_seen 20 min ago).
    await db.execute(sql`insert into unlock_lockouts (key, count, locked_until, last_seen)
        values (${tokKey}, 3, null, ${new Date(now - 20 * 60 * 1000).toISOString()})`);
    // A per-token recordFailure triggers the per-token prune (expired-only).
    const tokStore = new PostgresLockoutStore(db, 25, lockMs, 'tok:', false);
    await tokStore.recordFailure('some-token', now);
    const [row] = await db.execute(sql`select count from unlock_lockouts where key = ${tokKey}`);
    // The idle sub-threshold row was KEPT (count still 3), not pruned.
    expect(Number((row as { count: string | number }).count)).toBe(3);
    await db.execute(sql`delete from unlock_lockouts where key in (${tokKey}, 'tok:some-token')`);
  });
});
