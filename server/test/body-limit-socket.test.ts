import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { makeDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';

/**
 * Socket-level behavior of the body-limit 413, over a REAL connection with a
 * keep-alive (connection-pooling) client.
 *
 * Why this file exists: an over-cap 413 leaves the request body unconsumed on
 * the socket. If the response advertises `keep-alive` (Node's default), a
 * pooling client (Playwright's driver shares one keep-alive agent across all
 * APIRequestContexts; so do browsers and undici) reuses that socket for the
 * next request — while the server may still be draining (or force-closing,
 * after its 500 ms drain timeout) the unread body. Under load the reuse lands
 * on a socket the server is about to destroy: "socket hang up" (the e2e
 * "lazy-loads subsequent pages" flake). The correct behavior — what nginx and
 * Express do on an oversized-body reject — is to answer with
 * `Connection: close` so no client ever pools the dirty socket.
 *
 * The client runs in a SEPARATE process (fixtures/keepalive-413-client.mjs):
 * the real client (Playwright's driver) is a separate process with its own
 * event loop, so it reads the 413 promptly even while the server tears down
 * the connection. A same-process client shares the server's event loop and
 * gets busy writing the body, missing the 413 before the server's RST — a
 * race that does not exist in reality.
 *
 * The scenarios use the DECLARED-LENGTH (fast) path — the shape the real
 * clients use (the CLI chunks at 19 MB WITH content-length; Playwright sets
 * content-length for a known-size body). The middleware rejects on the header
 * before any body is read; `fast` sends no body bytes, so the close is clean
 * (no unread body in the receive buffer to trigger a kernel RST).
 */

const url = process.env.DATABASE_URL ?? 'postgres://quire:quire@localhost:54329/quire_test';
const config = { databaseUrl: url, apiKey: 'a'.repeat(64), unlockSecret: 'b'.repeat(64), port: 8787, webDist: '' };

let db: Db;
let app: ReturnType<typeof createApp>;
let dist: string;
let server: ServerType;
let port: number;

// The client fixture, resolved relative to THIS file (vitest runs from the
// server/ package root, so pin an absolute path via import.meta.url).
const testDir = fileURLToPath(new URL('.', import.meta.url));
const CLIENT = join(testDir, 'fixtures', 'keepalive-413-client.mjs');

interface ClientOut {
  fast: { status: number; connection: string | null; closedWithin2s: boolean } | null;
  full: { status: number; connection: string | null } | null;
  next: { status: number; body: string } | null;
  error?: string;
}

function runClient(): Promise<ClientOut> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`client exited ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout) as ClientOut);
      } catch {
        reject(new Error(`client output not JSON: ${stdout}\n${stderr}`));
      }
    });
  });
}

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'quire-web-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Quire</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  (config as { webDist: string }).webDist = dist;
  // No DB queries are issued by the endpoints exercised here (413s fire in
  // middleware, /healthz is static); makeDb connects lazily.
  db = makeDb(url);
  app = createApp({ db, config });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  // Kill sockets the server still holds (a keep-alive socket from a test that
  // did not close), then close the listener.
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
  rmSync(dist, { recursive: true, force: true });
});

describe('body-limit 413 over a real keep-alive socket', () => {
  it('answers the over-cap 413 with Connection: close, closes the socket, and keeps serving', async () => {
    const out = await runClient();
    expect(out.error, out.error).toBeUndefined();
    // FAST: declared 21 MB, no body — the middleware rejects on the header.
    // The dirty socket MUST be answered with Connection: close AND actually
    // closed promptly (a keep-alive advertisement invites the pooled-socket
    // reuse that causes "socket hang up").
    expect(out.fast?.status).toBe(413);
    expect(out.fast?.connection).toBe('close');
    expect(out.fast?.closedWithin2s).toBe(true);
    // FULL: declared 21 MB AND the full body actually sent (the shape the e2e
    // 413 test and a real over-cap client use). Without a pre-response drain
    // the unread body bytes make the kernel RST the close and discard the
    // queued 413 → the client sees a bare ECONNRESET instead of the 413. With
    // the drain the close is a graceful FIN and the 413 is delivered reliably.
    expect(out.full?.status).toBe(413);
    expect(out.full?.connection).toBe('close');
    // NEXT: the next request on the same keep-alive agent works (no "socket
    // hang up") — the dirty socket was not pooled.
    expect(out.next?.status).toBe(200);
    expect(JSON.parse(out.next!.body).ok).toBe(true);
  }, 30_000);
});
