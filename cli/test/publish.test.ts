import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(dir, '..');
const indexTs = join(cliRoot, 'src', 'index.ts');

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
const fakeApi = {
  baseUrl: 'https://srv.example.com',
  preview: vi.fn(async () => ({ messages: [], summary: { 'aws-access-key': 1 }, bytes: 10, messageCount: 1 })),
  create: vi.fn(async () => ({ token: 't'.repeat(22), url: `/chats/${'t'.repeat(22)}`, summary: { 'aws-access-key': 1 }, bytes: 10, messageCount: 1 })),
};

describe('runPublish (unit)', () => {
  it('--current --yes previews, confirms implicitly, creates, prints the URL', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    const lines: string[] = [];
    await runPublish({ current: true, yes: true }, [], { adapter: fakeAdapter as never, api: fakeApi as never, out: (l) => lines.push(l) });
    expect(fakeAdapter.resolveCurrent).toHaveBeenCalled();
    expect(fakeApi.preview).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess_a' }), 'strict');
    expect(fakeApi.create).toHaveBeenCalled();
    expect(lines.join('\n')).toContain('https://srv.example.com/chats/');
    expect(lines.join('\n')).toContain('1 aws-access-key');
  });

  it('resolves an explicit id by exact match', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    await runPublish({ yes: true }, ['sess_a'], { adapter: fakeAdapter as never, api: fakeApi as never, out: () => {} });
    expect(fakeAdapter.loadSession).toHaveBeenCalledWith('sess_a');
  });

  it('resolves a unique prefix', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    await runPublish({ yes: true }, ['sess'], { adapter: fakeAdapter as never, api: fakeApi as never, out: () => {} });
    expect(fakeAdapter.loadSession).toHaveBeenCalledWith('sess_a');
  });

  it('rejects an ambiguous prefix', async () => {
    const ambiguous = {
      ...fakeAdapter,
      listSessions: vi.fn(async () => [
        { id: 'sess_a', title: 'A', updatedAt: '', isSubagent: false },
        { id: 'sess_b', title: 'B', updatedAt: '', isSubagent: false },
      ]),
    };
    const { runPublish } = await import('../src/commands/publish.js');
    await expect(runPublish({ yes: true }, ['sess'], { adapter: ambiguous as never, api: fakeApi as never, out: () => {} })).rejects.toThrow(/ambiguous/);
  });

  it('rejects an unknown --expires value', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    await expect(runPublish({ yes: true, expires: '24x' }, ['sess_a'], { adapter: fakeAdapter as never, api: fakeApi as never, out: () => {} })).rejects.toThrow(/invalid --expires/);
  });

  it('passes the preset through to preview and create', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    await runPublish({ yes: true, preset: 'none' }, ['sess_a'], { adapter: fakeAdapter as never, api: fakeApi as never, out: () => {} });
    expect(fakeApi.preview).toHaveBeenCalledWith(expect.anything(), 'none');
    expect(fakeApi.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ preset: 'none' }));
  });
});

// ---------- process-level tests (real CLI, mock server, temp home) ----------

describe('runPublish (process)', () => {
  let server: Server;
  let baseUrl: string;
  let createCalls: unknown[];
  let tempHome: string;

  beforeAll(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'quire-publish-home-'));
    const dbDir = join(tempHome, '.zcode', 'cli', 'db');
    mkdirSync(dbDir, { recursive: true });
    execFileSync(process.execPath, [join(dir, 'fixtures', 'make-fixture-db.mjs'), join(dbDir, 'db.sqlite')]);

    createCalls = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/api/chats/preview') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ messages: [], summary: {}, bytes: 10, messageCount: 2 }));
        } else if (req.method === 'POST' && req.url === '/api/chats') {
          createCalls.push(JSON.parse(body));
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ token: 't'.repeat(22), url: `/chats/${'t'.repeat(22)}`, summary: {}, bytes: 10, messageCount: 2 }));
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
  });

  function runCli(args: string[], stdin: string, timeoutMs = 30000): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, ['--import', 'tsx', indexTs, ...args], {
      cwd: cliRoot,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, QUIRE_SERVER_URL: baseUrl, QUIRE_API_KEY: 'k'.repeat(64) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.write(stdin);
    child.stdin.end();
    return new Promise((resolve) => {
      const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('close', (code) => {
        clearTimeout(t);
        resolve({ code, stdout, stderr });
      });
    });
  }

  it('requires confirmation: declining publishes nothing', { timeout: 30000 }, async () => {
    const { code, stdout } = await runCli(['publish', '--current', '--harness', 'zcode'], 'n\n');
    expect(code).toBe(0);
    expect(stdout).toContain('Aborted. Nothing was published.');
    expect(createCalls).toHaveLength(0);
  });

  it('confirming publishes and prints the URL', { timeout: 30000 }, async () => {
    const { code, stdout } = await runCli(['publish', '--current', '--harness', 'zcode'], 'y\n');
    expect(code).toBe(0);
    expect(stdout).toContain('/chats/');
    expect(createCalls).toHaveLength(1);
    const body = createCalls[0] as { session: { sessionId: string; title: string } };
    expect(body.session.sessionId).toBe('sess_fixture'); // most recently updated session
    expect(body.session.title).toBe('Fixture Session');
  });

  it('interactive numbered list selects by number', { timeout: 30000 }, async () => {
    // D3: stage stdin. A single '1\ny\n' write coalesces into one pipe chunk consumed whole by
    // the first readline interface ('1' resolves the selection, 'y' is discarded), leaving the
    // confirm ask unsettled. 'y' is written only after 'Sharing:' — the first stdout line
    // emitted after the first readline closed — then stdin is ended.
    const child = spawn(process.execPath, ['--import', 'tsx', indexTs, 'publish', '--harness', 'zcode'], {
      cwd: cliRoot,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, QUIRE_SERVER_URL: baseUrl, QUIRE_API_KEY: 'k'.repeat(64) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let confirmed = false;
    let code: number | null = null;
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!confirmed && stdout.includes('Sharing:')) {
        confirmed = true;
        child.stdin.write('y\n');
        child.stdin.end();
      }
    });
    child.stdin.write('1\n');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.on('close', (c) => {
        clearTimeout(t);
        code = c;
        resolve();
      });
    });
    expect(code).toBe(0);
    expect(stdout).toContain('Recent sessions:');
    expect(createCalls).toHaveLength(2);
    const body = createCalls[1] as { session: { sessionId: string } };
    expect(body.session.sessionId).toBe('sess_fixture'); // session 1 in the list
  });
});
