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
});
