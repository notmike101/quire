import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
  create: vi.fn(async (_session: unknown, _opts?: { preset?: string; password?: string; expiresAt?: string }) => ({ token: 't'.repeat(22), url: `/chats/${'t'.repeat(22)}`, summary: { 'aws-access-key': 1 }, bytes: 10, messageCount: 1 })),
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
    // Chain D: a `none` preset now requires confirmRaw to proceed.
    await runPublish({ yes: true, preset: 'none', confirmRaw: true }, ['sess_a'], { adapter: fakeAdapter as never, api: fakeApi as never, out: () => {} });
    expect(fakeApi.preview).toHaveBeenCalledWith(expect.anything(), 'none');
    expect(fakeApi.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ preset: 'none' }));
  });

  it('--password random generates a secret, prints it once, and sends it to create', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    const lines: string[] = [];
    await runPublish({ current: true, yes: true, password: 'random' }, [], { adapter: fakeAdapter as never, api: fakeApi as never, out: (l) => lines.push(l) });
    const opts = fakeApi.create.mock.lastCall?.[1] as { password?: string };
    expect(opts.password).toMatch(/^[A-Za-z0-9_-]{22}$/); // base64url of 16 bytes
    const printed = lines.filter((l) => l.startsWith('Password: '));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toBe(`Password: ${opts.password}`);
  });

  it('--password with a literal value is sent as-is and not printed', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    const lines: string[] = [];
    await runPublish({ current: true, yes: true, password: 'hunter2' }, [], { adapter: fakeAdapter as never, api: fakeApi as never, out: (l) => lines.push(l) });
    const opts = fakeApi.create.mock.lastCall?.[1] as { password?: string };
    expect(opts.password).toBe('hunter2');
    expect(lines.some((l) => l.startsWith('Password: '))).toBe(false);
  });

  it('no --current and no id: errors with an actionable message and publishes nothing', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    const before = fakeApi.create.mock.calls.length;
    await expect(
      runPublish({ yes: true }, [], { adapter: fakeAdapter as never, api: fakeApi as never, out: () => {} }),
    ).rejects.toThrow(/no session selected/);
    expect(fakeApi.create.mock.calls.length).toBe(before); // nothing new published
  });

  it('--expires tomorrow sends an ISO expiresAt to create', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    await runPublish({ current: true, yes: true, expires: 'tomorrow' }, [], { adapter: fakeAdapter as never, api: fakeApi as never, out: () => {} });
    const opts = fakeApi.create.mock.lastCall?.[1] as { expiresAt?: string };
    expect(opts.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // ISO datetime
  });

  it('chunks a large session: 1 create + N-1 createChunk in order', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    // A session whose serialized size exceeds the (small) injected cap.
    const bigAdapter = {
      name: 'zcode',
      listSessions: vi.fn(async () => [{ id: 'sess_big', title: 'Big', updatedAt: '', isSubagent: false }]),
      resolveCurrent: vi.fn(async () => ({ id: 'sess_big', title: 'Big', updatedAt: '', isSubagent: false })),
      loadSession: vi.fn(async (id: string) => ({
        sessionId: id, title: 'Big',
        messages: Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, parts: [{ type: 'text' as const, text: 'x'.repeat(200) }] })),
      })),
    };
    const calls: string[] = [];
    const chunkyApi = {
      baseUrl: 'https://srv.example.com',
      preview: vi.fn(async () => ({ messages: [], summary: {}, bytes: 0, messageCount: 6 })),
      create: vi.fn(async () => {
        calls.push('create');
        return { token: 't'.repeat(22), url: `/chats/${'t'.repeat(22)}`, uploadId: 'a'.repeat(32), chunkCount: 1, summary: {}, bytes: 0, messageCount: 2 };
      }),
      createChunk: vi.fn(async (_tok: string, body: { chunkSeq: number }) => {
        calls.push(`chunk${body.chunkSeq}`);
        return { ok: true, messageCount: 4, bytes: 0 };
      }),
    };
    // Inject a chunker that forces 3 chunks of 2 (ESM named exports are read-only,
    // so the chunker is a dep, not a spy on the imported chunkMessages).
    const chunker = vi.fn((msgs: unknown[]) => {
      const arr = msgs as unknown[];
      return [arr.slice(0, 2), arr.slice(2, 4), arr.slice(4, 6)];
    });
    await runPublish({ current: true, yes: true }, [], { adapter: bigAdapter as never, api: chunkyApi as never, chunker: chunker as never, out: () => {} });
    expect(chunker).toHaveBeenCalledOnce();
    expect(calls).toEqual(['create', 'chunk1', 'chunk2']);
  });

  it('skips the preview for a session over the per-request cap (E1) and still uploads in chunks', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    // Two 11 MB messages: 22 MB total — over the 20 MB preview cap, but each
    // message fits a chunk, so the chunked path must still run.
    const hugeAdapter = {
      name: 'zcode',
      listSessions: vi.fn(async () => [{ id: 'sess_huge', title: 'Huge', updatedAt: '', isSubagent: false }]),
      resolveCurrent: vi.fn(async () => ({ id: 'sess_huge', title: 'Huge', updatedAt: '', isSubagent: false })),
      loadSession: vi.fn(async (id: string) => ({
        sessionId: id, title: 'Huge',
        messages: Array.from({ length: 2 }, () => ({ role: 'user' as const, parts: [{ type: 'text' as const, text: 'x'.repeat(11 * 1024 * 1024) }] })),
      })),
    };
    const calls: string[] = [];
    const hugeApi = {
      baseUrl: 'https://srv.example.com',
      preview: vi.fn(async () => {
        throw new Error('preview must not be called for a >20 MB session (it would 413)');
      }),
      create: vi.fn(async () => {
        calls.push('create');
        return { token: 't'.repeat(22), url: `/chats/${'t'.repeat(22)}`, uploadId: 'a'.repeat(32), chunkCount: 1, summary: {}, bytes: 0, messageCount: 1 };
      }),
      createChunk: vi.fn(async (_tok: string, body: { chunkSeq: number }) => {
        calls.push(`chunk${body.chunkSeq}`);
        return { ok: true, messageCount: 1, bytes: 0 };
      }),
    };
    const lines: string[] = [];
    await runPublish({ current: true, yes: true }, [], { adapter: hugeAdapter as never, api: hugeApi as never, out: (l) => lines.push(l) });
    expect(hugeApi.preview).not.toHaveBeenCalled();
    expect(calls).toEqual(['create', 'chunk1']);
    expect(lines.join('\n')).toContain('preview is skipped');
  });

  it('--no-chunk sends a single create and no createChunk', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    const calls: string[] = [];
    const noChunkApi = {
      baseUrl: 'https://srv.example.com',
      preview: vi.fn(async () => ({ messages: [], summary: {}, bytes: 0, messageCount: 6 })),
      create: vi.fn(async () => {
        calls.push('create');
        return { token: 't'.repeat(22), url: `/chats/${'t'.repeat(22)}`, uploadId: 'a'.repeat(32), chunkCount: 1, summary: {}, bytes: 0, messageCount: 6 };
      }),
      createChunk: vi.fn(async () => { calls.push('chunk'); return { ok: true, messageCount: 6, bytes: 0 }; }),
    };
    // noChunk must short-circuit before any chunking: the chunker must never run.
    const chunker = vi.fn((msgs: unknown[]) => [msgs]);
    await runPublish({ current: true, yes: true, noChunk: true }, [], { adapter: fakeAdapter as never, api: noChunkApi as never, chunker: chunker as never, out: () => {} });
    expect(chunker).not.toHaveBeenCalled();
    expect(calls).toEqual(['create']);
  });

  it('refuses --preset none without --confirm-raw even under --yes (Chain D)', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    const api = {
      preview: vi.fn(async () => ({ messages: [], summary: {}, bytes: 0, messageCount: 0 })),
      create: vi.fn(),
    };
    await expect(
      runPublish({ current: true, yes: true, preset: 'none' }, [], { adapter: fakeAdapter as never, api: api as never, out: () => {} }),
    ).rejects.toThrow(/confirm-raw/);
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('publishes --preset none with --confirm-raw (Chain D)', async () => {
    const { runPublish } = await import('../src/commands/publish.js');
    const api = {
      preview: vi.fn(async () => ({ messages: [], summary: {}, bytes: 0, messageCount: 0 })),
      create: vi.fn(async () => ({ token: 't'.repeat(22), url: `/chats/${'t'.repeat(22)}`, uploadId: 'u'.repeat(32), chunkCount: 1, summary: {}, bytes: 0, messageCount: 0 })),
    };
    await runPublish({ current: true, yes: true, preset: 'none', confirmRaw: true }, [], { adapter: fakeAdapter as never, api: api as never, out: () => {} });
    expect(api.create).toHaveBeenCalledTimes(1);
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
        } else if (req.method === 'DELETE' && req.url?.startsWith('/api/chats/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
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
    const { code, stdout, stderr } = await runCli(['publish', '--current', '--harness', 'zcode'], 'n\n');
    expect(code, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain('Aborted. Nothing was published.');
    expect(createCalls).toHaveLength(0);
  });

  it('confirming publishes and prints the URL', { timeout: 30000 }, async () => {
    const { code, stdout, stderr } = await runCli(['publish', '--current', '--harness', 'zcode'], 'y\n');
    expect(code, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain('/chats/');
    expect(createCalls).toHaveLength(1);
    const body = createCalls[0] as { session: { sessionId: string; title: string } };
    expect(body.session.sessionId).toBe('sess_fixture'); // most recently updated session
    expect(body.session.title).toBe('Fixture Session');
  });

  it('--yes publishes with no prompt (the agent path)', { timeout: 30000 }, async () => {
    // The agent always passes --yes, so the CLI must publish without reading stdin.
    // stdin is ended immediately (no input) to prove nothing is awaited.
    const { code, stdout, stderr } = await runCli(['publish', '--current', '--harness', 'zcode', '--yes'], '');
    expect(code, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain('/chats/');
    expect(createCalls).toHaveLength(2);
    const body = createCalls[1] as { session: { sessionId: string } };
    expect(body.session.sessionId).toBe('sess_fixture');
  });

  it('--password random + --expires tomorrow + --yes: non-interactive, prints Password and sends both', { timeout: 30000 }, async () => {
    const { code, stdout, stderr } = await runCli(
      ['publish', '--current', '--harness', 'zcode', '--password', 'random', '--expires', 'tomorrow', '--yes'],
      '',
    );
    expect(code, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain('/chats/');
    expect(stdout).toMatch(/Password: [A-Za-z0-9_-]{22}/);
    expect(createCalls).toHaveLength(3);
    const body = createCalls[2] as { password?: string; expiresAt?: string };
    expect(body.password).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // "tomorrow" = next local midnight, which is a valid ISO datetime (not necessarily 00:00Z).
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(body.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('no --current and no id: errors with an actionable message and publishes nothing', { timeout: 30000 }, async () => {
    // There is no interactive picker anymore — a bare `quire publish` must fail
    // fast rather than block on a numbered prompt.
    const { code, stdout, stderr } = await runCli(['publish', '--harness', 'zcode'], '');
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain('no session selected');
    expect(createCalls).toHaveLength(3); // nothing new published
  });

  it('EOF at the prompt aborts with a non-zero exit and a clear message', { timeout: 30000 }, async () => {
    // M37: a truncated/EOF stdin while a question is pending must abort loudly,
    // not resolve as an empty answer (which would look like a declined confirm
    // and exit 0). Ending stdin with no input exercises the readline 'close'
    // path that rejects with PromptAbortedError.
    const child = spawn(process.execPath, ['--import', 'tsx', indexTs, 'publish', '--current', '--harness', 'zcode'], {
      cwd: cliRoot,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, QUIRE_SERVER_URL: baseUrl, QUIRE_API_KEY: 'k'.repeat(64) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let code: number | null = null;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(); // no input, immediate EOF
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.on('close', (c) => {
        clearTimeout(t);
        code = c;
        resolve();
      });
    });
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain('Aborted. Nothing was published.');
    expect(createCalls).toHaveLength(3); // nothing new published
  });

  it('revoke --yes revokes with no prompt (agent path)', { timeout: 30000 }, async () => {
    // `quire revoke <token> --yes` must skip the confirm prompt and call DELETE
    // without reading stdin. The mock server answers DELETE /api/chats/:token.
    const { code, stdout, stderr } = await runCli(['revoke', 't'.repeat(22), '--yes'], '');
    expect(code, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain('Revoked');
  });

  it('refuses --preset none without --confirm-raw even under --yes (Chain D, real binary)', { timeout: 30000 }, async () => {
    // Exercises the real parseArgs path: the kebab --confirm-raw must be a
    // recognized option (Node does not map kebab→camel), and `none` must abort
    // before any create call.
    const { code, stdout, stderr } = await runCli(['publish', '--current', '--harness', 'zcode', '--preset', 'none', '--yes'], '');
    expect(code, `stderr: ${stderr}`).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain('confirm-raw');
    expect(createCalls).toHaveLength(3); // nothing new published
  });

  it('publishes --preset none with --confirm-raw (Chain D, real binary)', { timeout: 30000 }, async () => {
    // The kebab --confirm-raw flag must parse (not "Unknown option") and allow
    // the unredacted publish to proceed.
    const { code, stdout, stderr } = await runCli(['publish', '--current', '--harness', 'zcode', '--preset', 'none', '--confirm-raw', '--yes'], '');
    expect(code, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain('/chats/');
    expect(createCalls).toHaveLength(4);
    const body = createCalls[3] as { preset?: string };
    expect(body.preset).toBe('none');
  });
});
