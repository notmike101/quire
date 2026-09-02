import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(dir, '..');
const indexTs = join(cliRoot, 'src', 'index.ts');

// The fragment is exactly the base64url of the 32-byte content key (43 chars, unpadded).
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

// ---------- unit tests (injected deps) ----------

const fakeAdapter = {
  name: 'zcode',
  listSessions: vi.fn(async () => [
    { id: 'sess_a', title: 'Session A', updatedAt: '2026-08-20T00:00:00Z', isSubagent: false },
  ]),
  resolveCurrent: vi.fn(async () => ({ id: 'sess_a', title: 'Session A', updatedAt: '2026-08-20T00:00:00Z', isSubagent: false })),
  loadSession: vi.fn(async (id: string) => ({
    sessionId: id,
    title: 'Session A',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  })),
};

function makeV2Api() {
  const create = vi.fn(async (_body: unknown) => ({
    shareId: 'pub-v2',
    uploadToken: 'utok',
    acceptedSourceChunk: 0,
    redactions: {},
    messageCount: 1,
    bytes: 10,
  }));
  const finalize = vi.fn(async (shareId: string, _body: unknown, _token: string) => ({
    shareId,
    publicPath: `/chats/${shareId}`,
    messageCount: 1,
    pageCount: 1,
    bytes: 10,
    redactions: { 'aws-access-key': 1 },
  }));
  return {
    api: {
      baseUrl: 'https://srv.example.com',
      origin: 'https://srv.example.com',
      createV2Share: create,
      uploadV2Chunk: vi.fn(async (_shareId: string, seq: number) => ({
        acceptedSourceChunk: seq,
        redactions: {},
        messageCount: 1,
        bytes: 10,
      })),
      finalizeV2Share: finalize,
    } as never,
    create,
    finalize,
  };
}

describe('runPublish (unit)', () => {
  it('publishes v2 and prints the fragment URL plus the summary', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    const { api, create, finalize } = makeV2Api();
    const lines: string[] = [];
    await runPublish({ current: true, yes: true }, [], { adapter: fakeAdapter as never, api, out: (l) => lines.push(l) });

    const text = lines.join('\n');
    const published = text.split('\n').find((l) => l.startsWith('Published: '));
    expect(published).toBeDefined();
    // The URL is built from the configured base URL and carries the key fragment.
    expect(published).toMatch(/^Published: https:\/\/srv\.example\.com\/chats\/pub-v2#[A-Za-z0-9_-]{43}$/);
    // Same summary shape as v1: message count, stored bytes, redactions.
    expect(text).toContain('Messages: 1 · Stored: 10 bytes · Redactions: 1 aws-access-key');
    // The v2 orchestration ran (create + finalize), the v1 flow did not.
    expect(create).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    // The v2 create body carried the content key and the shaped session.
    const body = create.mock.calls[0]![0] as { contentKey: string; session: { sessionId: string } };
    expect(body.contentKey).toMatch(KEY_RE);
    expect(body.session.sessionId).toBe('sess_a');
  });

  it('sends preset, password, and expiry to publishV2', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    const { api, create } = makeV2Api();
    await runPublish(
      { current: true, yes: true, preset: 'normal', password: 'hunter2', expires: 'tomorrow' },
      [],
      { adapter: fakeAdapter as never, api, out: () => {} },
    );
    const body = create.mock.calls[0]![0] as { preset: string; password: string; expiresAt: string };
    expect(body.preset).toBe('normal');
    expect(body.password).toBe('hunter2');
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// ---------- process-level tests (real CLI, mock v2 server, temp home) ----------

describe('runPublish (process)', () => {
  let server: Server;
  let baseUrl: string;
  let tempHome: string;
  let v2Calls: Array<{ method: string; url: string; body: unknown }>;
  let failFinalize = false;

  beforeAll(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'quire-publish-v2-home-'));
    v2Calls = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : undefined;
        if (req.method === 'POST' && req.url === '/api/v2/shares') {
          v2Calls.push({ method: 'create', url: req.url!, body: parsed });
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ shareId: 'v2share1', uploadToken: 'utok', acceptedSourceChunk: 0, redactions: {}, messageCount: 2, bytes: 42 }));
        } else if (req.method === 'PUT' && /^\/api\/v2\/shares\/v2share1\/source-chunks\/\d+$/.test(req.url ?? '')) {
          v2Calls.push({ method: 'chunk', url: req.url!, body: parsed });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ acceptedSourceChunk: Number(req.url!.split('/').pop()), redactions: {}, messageCount: 2, bytes: 42 }));
        } else if (req.method === 'POST' && req.url === '/api/v2/shares/v2share1/finalize') {
          v2Calls.push({ method: 'finalize', url: req.url!, body: parsed });
          if (failFinalize) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'internal', message: 'boom' } }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ shareId: 'v2share1', publicPath: '/chats/v2share1', messageCount: 2, pageCount: 1, bytes: 42, redactions: { 'aws-access-key': 1 } }));
        } else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tempHome, { recursive: true, force: true });
  });

  function runCli(args: string[], timeoutMs = 30000): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, ['--import', 'tsx', indexTs, ...args], {
      cwd: cliRoot,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, QUIRE_SERVER_URL: baseUrl, QUIRE_API_KEY: 'k'.repeat(64) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(); // --yes: nothing is awaited from stdin
    return new Promise((resolve) => {
      // Kill guard for a hung child; completion is the real 'close' event, not the timer.
      const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('close', (code) => {
        clearTimeout(t);
        resolve({ code, stdout, stderr });
      });
    });
  }

  function ompExport(): string {
    const path = join(tempHome, 'export.html');
    const data = {
      header: { type: 'session', id: 'omp-v2-1', title: 'OMP v2', cwd: 'D:/workspace' },
      entries: [
        { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', model: 'omp-model', content: [{ type: 'text', text: 'hi' }] } },
      ],
      leafId: 'a1',
    };
    writeFileSync(path, `<!doctype html><script id="session-data" type="application/json">${Buffer.from(JSON.stringify(data), 'utf8').toString('base64')}</script>`);
    return path;
  }

  it('publishes through the v2 endpoints and prints the fragment URL', { timeout: 30000 }, async () => {
    const path = ompExport();
    const { code, stdout, stderr } = await runCli(['publish', path, '--harness', 'omp', '--yes']);
    expect(code, `stderr: ${stderr}`).toBe(0);

    const published = stdout.split(/\r?\n/).find((l) => l.startsWith('Published: '));
    expect(published).toBeDefined();
    const url = published!.slice('Published: '.length).trim();
    expect(url.startsWith(`${baseUrl}/chats/v2share1#`)).toBe(true);
    const fragment = url.slice(`${baseUrl}/chats/v2share1#`.length);
    expect(fragment).toMatch(KEY_RE);
    // The fragment (the content key) reaches stdout only — never stderr.
    expect(stderr).not.toContain(fragment);
    // Same summary as v1: message count and redactions.
    expect(stdout).toContain('Messages: 2');
    expect(stdout).toContain('Redactions: 1 aws-access-key');
    // Only v2 endpoints were hit (2 messages fit one chunk: create + finalize).
    expect(v2Calls.map((c) => c.method)).toEqual(['create', 'finalize']);
    const createBody = v2Calls[0]!.body as { protocol: string; contentKey: string; session: { sessionId: string } };
    expect(createBody.contentKey).toBe(fragment); // the printed fragment IS the content key
    expect(createBody.session.sessionId).toBe('omp-v2-1');
  });

  it('publishes v2 by default', { timeout: 30000 }, async () => {
    const path = ompExport();
    const before = v2Calls.length;
    const { code, stdout, stderr } = await runCli(['publish', path, '--harness', 'omp', '--yes']);
    expect(code, `stderr: ${stderr}`).toBe(0);

    const published = stdout.split(/\r?\n/).find((l) => l.startsWith('Published: '));
    expect(published).toBeDefined();
    const url = published!.slice('Published: '.length).trim();
    expect(url.startsWith(`${baseUrl}/chats/v2share1#`)).toBe(true);
    // Only the v2 endpoints were hit.
    expect(v2Calls.slice(before).map((c) => c.method)).toEqual(['create', 'finalize']);
  });

  it('a failed v2 publish leaves no content key or fragment in stdout/stderr (the debug log input)', { timeout: 30000 }, async () => {
    const path = ompExport();
    const createsBefore = v2Calls.filter((c) => c.method === 'create').length;
    failFinalize = true;
    const { code, stdout, stderr } = await runCli(['publish', path, '--harness', 'omp', '--yes']);
    failFinalize = false;
    expect(code).toBe(1);

    // The debug log (the OMP handler's capture of stdout+stderr on a nonzero
    // exit) must contain no content key and no fragment URL: the key the
    // server received must appear nowhere in the process output.
    const createBody = v2Calls.filter((c) => c.method === 'create').slice(createsBefore).pop()!.body as { contentKey: string };
    expect(createBody.contentKey).toMatch(KEY_RE);
    expect(stdout).not.toContain(createBody.contentKey);
    expect(stderr).not.toContain(createBody.contentKey);
    expect(stdout).not.toContain('#'); // no URL (fragment or otherwise) was printed
    // The CLI itself never writes the debug log.
    expect(existsSync(join(tempHome, '.quire', 'share-debug.log'))).toBe(false);
  });
});
