import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { sharesV2, shareBlobsV2 } from '../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { hashPassword } from '../src/security/password.js';
import { RateLimiter, IpWindow } from '../src/security/rate-limit.js';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';
const config = { databaseUrl: url, apiKey: 'a'.repeat(64), unlockSecret: 'b'.repeat(64), port: 8787, webDist: '' };

const sha256Hex = (v: Uint8Array): string => createHash('sha256').update(v).digest('hex');
const enc = new TextEncoder();

let db: Db;
let app: Hono;

/** Response.json() is typed Promise<unknown> under @types/node (no DOM lib); cast to a plain object. */
const json = (r: Response): Promise<Record<string, any>> => r.json() as Promise<Record<string, any>>;

/**
 * Seeds a v2 share directly (the ingestion routes are covered by
 * owner-v2.test.ts). Blob envelopes are opaque to the server: deterministic
 * fake ciphertext with the correct stored digest.
 */
async function seedV2Share(
  publicId: string,
  opts: { password?: string; expiresAt?: Date; state?: string; blobs?: boolean } = {},
) {
  const [share] = await db.insert(sharesV2).values({
    publicId,
    uploadRequestId: `req_${publicId}`,
    uploadTokenHash: 'c'.repeat(64),
    state: opts.state ?? 'ready',
    sourceChunkCount: 1,
    receivedChunkCount: 1,
    pageCount: opts.blobs === false ? 0 : 1,
    messageCount: 2,
    title: `secret title ${publicId}`,
    passwordHash: opts.password ? await hashPassword(opts.password) : null,
    expiresAt: opts.expiresAt ?? null,
  }).returning();
  if (!share) throw new Error('seed insert returned no row');
  if (opts.blobs !== false) {
    const manifest = enc.encode(`QSHR-manifest-${publicId}`);
    const index = enc.encode(`QSHR-index-${publicId}`);
    const page = enc.encode(`QSHR-page-${publicId}`);
    await db.insert(shareBlobsV2).values([
      { shareId: share.id, kind: 'manifest', seq: 0, ciphertext: manifest, ciphertextBytes: manifest.byteLength, digest: sha256Hex(manifest) },
      { shareId: share.id, kind: 'index', seq: 0, ciphertext: index, ciphertextBytes: index.byteLength, digest: sha256Hex(index) },
      { shareId: share.id, kind: 'page', seq: 0, ciphertext: page, ciphertextBytes: page.byteLength, digest: sha256Hex(page) },
    ]);
  }
  return share;
}

beforeAll(async () => {
  db = makeDb(url);
  // postgres.js console.logs NOTICE lines; migrateDb against an already-migrated
  // container emits "already exists, skipping". Silence so output stays clean.
  const origLog = console.log;
  console.log = () => {};
  try {
    await migrateDb(db);
  } finally {
    console.log = origLog;
  }
  await db.execute(sql`delete from share_blobs_v2; delete from share_source_chunks_v2; delete from shares_v2`);
  app = createApp({ db, config, ipWindow: new IpWindow(1000, 60_000) });
});

beforeEach(async () => {
  await db.execute(sql`delete from share_blobs_v2; delete from share_source_chunks_v2; delete from shares_v2`);
});

afterAll(async () => {
  await db.execute(sql`delete from share_blobs_v2; delete from share_source_chunks_v2; delete from shares_v2`);
  const withClient = db as unknown as { $client?: { end(): Promise<void> } };
  await withClient.$client?.end();
});

describe('v2 public bootstrap', () => {
  it('returns the key-free state for a ready share (no title, no content)', async () => {
    const future = new Date(Date.now() + 3600_000);
    await seedV2Share('v2ready', { expiresAt: future });
    const res = await app.request('/api/v2/public/shares/v2ready/bootstrap');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.state).toBe('ready');
    expect(body.expiresAt).toBe(future.toISOString());
    expect(body.expired).toBe(false);
    expect(body.passwordRequired).toBe(false);
    // The title and the blob content live in the encrypted manifest, never
    // in the bootstrap.
    expect(body.title).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('secret title');
    expect(JSON.stringify(body)).not.toContain('QSHR');
  });

  it('404 not_found for an unknown share', async () => {
    const res = await app.request('/api/v2/public/shares/nope/bootstrap');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('404 not_found for an incomplete (uploading) share — no existence oracle', async () => {
    await seedV2Share('v2incomplete', { state: 'uploading' });
    const res = await app.request('/api/v2/public/shares/v2incomplete/bootstrap');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('not_found');
  });

  it('410 expired for an expired share', async () => {
    await seedV2Share('v2expired', { expiresAt: new Date(Date.now() - 1000) });
    const res = await app.request('/api/v2/public/shares/v2expired/bootstrap');
    expect(res.status).toBe(410);
    expect((await json(res)).error.code).toBe('expired');
  });

  it('401 needs_password for a password-protected share without a valid cookie', async () => {
    await seedV2Share('v2pw', { password: 'hunter2' });
    const res = await app.request('/api/v2/public/shares/v2pw/bootstrap');
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe('needs_password');
  });
});

describe('v2 public blobs', () => {
  it('serves the exact stored envelope bytes for manifest, index, and page', async () => {
    await seedV2Share('v2blob');
    const cases: Array<[string, string]> = [
      ['/api/v2/public/shares/v2blob/blobs/manifest/0', 'QSHR-manifest-v2blob'],
      ['/api/v2/public/shares/v2blob/blobs/index/0', 'QSHR-index-v2blob'],
      ['/api/v2/public/shares/v2blob/blobs/page/0', 'QSHR-page-v2blob'],
    ];
    for (const [path, expected] of cases) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(Buffer.from(bytes).toString('utf8')).toBe(expected);
    }
  });

  it('404 not_found for a missing page seq', async () => {
    await seedV2Share('v2seq');
    const res = await app.request('/api/v2/public/shares/v2seq/blobs/page/7');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('not_found');
  });

  it('404 not_found for a malformed page seq', async () => {
    await seedV2Share('v2seqbad');
    const res = await app.request('/api/v2/public/shares/v2seqbad/blobs/page/abc');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('not_found');
  });

  it('applies the same gating as bootstrap: 404 unknown, 410 expired, 401 password', async () => {
    await seedV2Share('v2gate-pw', { password: 'x' });
    await seedV2Share('v2gate-exp', { expiresAt: new Date(Date.now() - 1000) });
    expect((await app.request('/api/v2/public/shares/nope/blobs/manifest/0')).status).toBe(404);
    expect((await app.request('/api/v2/public/shares/v2gate-exp/blobs/manifest/0')).status).toBe(410);
    expect((await app.request('/api/v2/public/shares/v2gate-pw/blobs/manifest/0')).status).toBe(401);
  });

  it('500 when the stored digest does not match the envelope bytes (corrupt row is not served)', async () => {
    const share = await seedV2Share('v2corrupt');
    await db.update(shareBlobsV2).set({ digest: '0'.repeat(64) }).where(eq(shareBlobsV2.shareId, share.id));
    const res = await app.request('/api/v2/public/shares/v2corrupt/blobs/manifest/0');
    expect(res.status).toBe(500);
    expect((await json(res)).error.code).toBe('internal');
  });
});

describe('v2 public unlock', () => {
  it('full password flow: 401 -> bad_password -> unlock -> cookie grants access', async () => {
    await seedV2Share('v2pw1', { password: 's3cret!' });
    expect((await app.request('/api/v2/public/shares/v2pw1/bootstrap')).status).toBe(401);

    const bad = await app.request('/api/v2/public/shares/v2pw1/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }),
    });
    expect(bad.status).toBe(401);
    expect((await json(bad)).error.code).toBe('bad_password');

    const good = await app.request('/api/v2/public/shares/v2pw1/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 's3cret!' }),
    });
    expect(good.status).toBe(200);
    const setCookie = good.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('quire_unlock_v2pw1=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    const value = setCookie.split(';')[0]!;

    const withCookie = await app.request('/api/v2/public/shares/v2pw1/blobs/manifest/0', { headers: { cookie: value } });
    expect(withCookie.status).toBe(200);
    const boot = await app.request('/api/v2/public/shares/v2pw1/bootstrap', { headers: { cookie: value } });
    expect(boot.status).toBe(200);
    expect((await json(boot)).passwordRequired).toBe(true);
  });

  it('a cookie for one share does not unlock another', async () => {
    await seedV2Share('v2pw2a', { password: 'same' });
    await seedV2Share('v2pw2b', { password: 'same' });
    const good = await app.request('/api/v2/public/shares/v2pw2a/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'same' }),
    });
    const value = (good.headers.get('set-cookie') ?? '').split(';')[0]!;
    const res = await app.request('/api/v2/public/shares/v2pw2b/bootstrap', { headers: { cookie: value } });
    expect(res.status).toBe(401);
  });

  it('429 after 5 failed unlocks, keyed per (shareId, IP)', async () => {
    const rl = new RateLimiter();
    const locked = createApp({ db, config, unlockLimiter: rl, tokenLimiter: new RateLimiter(), ipWindow: new IpWindow(1000, 60_000) });
    await seedV2Share('v2pw3', { password: 'right' });
    for (let i = 0; i < 5; i++) {
      const res = await locked.request('/api/v2/public/shares/v2pw3/unlock', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }),
      });
      expect(res.status).toBe(401);
    }
    // even the right password is refused while locked
    const res = await locked.request('/api/v2/public/shares/v2pw3/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'right' }),
    });
    expect(res.status).toBe(429);
  });

  it('404 (no liveness oracle) when the share has no password', async () => {
    await seedV2Share('v2nopw');
    const res = await app.request('/api/v2/public/shares/v2nopw/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }),
    });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('not_found');
  });

  it('404 for an unknown shareId and 410 for an expired share', async () => {
    await seedV2Share('v2pw4', { password: 'x', expiresAt: new Date(Date.now() - 1000) });
    const unknown = await app.request('/api/v2/public/shares/nope/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }),
    });
    expect(unknown.status).toBe(404);
    const expired = await app.request('/api/v2/public/shares/v2pw4/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }),
    });
    expect(expired.status).toBe(410);
  });

  it('400 validation for a malformed body', async () => {
    await seedV2Share('v2pw5', { password: 'x' });
    const res = await app.request('/api/v2/public/shares/v2pw5/unlock', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation');
  });
});
