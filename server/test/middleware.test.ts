import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDb, migrateDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import { errorHandler } from '../src/api/errors.js';
import { HTTPException } from 'hono/http-exception';

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';
const config = { databaseUrl: url, apiKey: 'a'.repeat(64), unlockSecret: 'b'.repeat(64), port: 8787, webDist: '' };

let db: Db;
let app: ReturnType<typeof createApp>;
let dist: string;

/** Response.json() is typed Promise<unknown> under @types/node (no DOM lib); cast to a plain object. */
const json = (r: Response): Promise<Record<string, any>> => r.json() as Promise<Record<string, any>>;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'quire-web-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Quire</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  (config as { webDist: string }).webDist = dist;
  db = makeDb(url);
  // postgres.js console.logs NOTICE lines by default; migrateDb against the
  // already-migrated test container emits two ("schema/relation already
  // exists, skipping"). Silence them so this file's output stays clean.
  const origLog = console.log;
  console.log = () => {};
  try {
    await migrateDb(db);
  } finally {
    console.log = origLog;
  }
  app = createApp({ db, config });
});

afterAll(async () => {
  await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
  rmSync(dist, { recursive: true, force: true });
});

describe('security headers', () => {
  it('are present on every response', async () => {
    const res = await app.request('/healthz');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    // Shiki (code highlighting in the SPA) instantiates a WebAssembly module,
    // which script-src gates behind 'wasm-unsafe-eval'. Without it every code
    // block in a transcript renders unhighlighted (verified live 2026-08-27).
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });
  it('sends X-Robots-Tag: noindex, nofollow on every response', async () => {
    for (const path of ['/healthz', '/chats/sometoken', '/api/public/chats/doesnotexist', '/robots.txt']) {
      const res = await app.request(path);
      expect(res.headers.get('x-robots-tag'), `x-robots-tag on ${path}`).toBe('noindex, nofollow');
    }
  });
});

describe('body limit', () => {
  it('413 too_large above 20 MB', async () => {
    const res = await app.request('/api/chats', {
      method: 'POST',
      headers: { 'content-length': String(21 * 1024 * 1024), authorization: `Bearer ${'a'.repeat(64)}` },
    });
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe('too_large');
  });
});

describe('static SPA', () => {
  it('serves index.html for /chats/:token', async () => {
    const res = await app.request('/chats/sometoken');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Quire');
  });
  it('serves assets', async () => {
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
  });
  it('rejects path traversal out of /assets', async () => {
    for (const p of ['/assets/../index.html', '/assets/..%2F..%2Findex.html']) {
      const res = await app.request(p, { redirect: 'manual' });
      expect(res.status).not.toBe(200);
      expect(await res.text()).not.toContain('Quire');
    }
  });
  it('serves a robots.txt that disallows all crawling', async () => {
    const res = await app.request('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Disallow: /');
  });
});

describe('error handler', () => {
  it('maps unknown errors to a uniform 500 without leaking internals', () => {
    const fakeCtx = { json: (body: unknown, status?: number) => ({ body, status }) } as never;
    const result = errorHandler(new Error('secret internal detail'), fakeCtx) as unknown as { body: { error: { code: string; message: string } }; status: number };
    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('internal');
    expect(result.body.error.message).not.toContain('secret internal detail');
  });
  it('passes HTTPException status through', () => {
    const fakeCtx = { json: (body: unknown, status?: number) => ({ body, status }) } as never;
    const result = errorHandler(new HTTPException(404, { message: 'gone' }), fakeCtx) as { status: number };
    expect(result.status).toBe(404);
  });
});
