import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(dir, '..');
const indexTs = join(cliRoot, 'src', 'index.ts');

describe('runList (unit)', () => {
  it('renders a table with a REVOKED marker', async () => {
    const fakeApi = {
      list: vi.fn(async () => ({
        shares: [
          { token: 'abcdefgh1234567890abcd', title: 'A'.repeat(60), createdAt: '2026-08-20T00:00:00Z', expiresAt: null, hasPassword: true, revoked: false, messageCount: 3, preset: 'strict' },
          { token: 'ijklmnop1234567890ijkl', title: 'Dead', createdAt: '2026-08-21T00:00:00Z', expiresAt: '2026-08-22T00:00:00Z', hasPassword: false, revoked: true, messageCount: 1, preset: 'normal' },
        ],
      })),
    };
    const { runList } = await import('../src/commands/list.js');
    const lines: string[] = [];
    await runList(fakeApi as never, (l) => lines.push(l));
    const table = lines.join('\n');
    expect(table).toContain('abcdefgh');
    expect(table).toContain('REVOKED');
    expect(table).toContain('yes');
    expect(table).not.toContain('A'.repeat(41)); // title clipped to 40
  });
});

describe('runUpdate (unit)', () => {
  it('PATCHes parsed expiry and password', async () => {
    const fakeApi = { patch: vi.fn(async () => ({ ok: true })) };
    const { runUpdate } = await import('../src/commands/update.js');
    await runUpdate('tok123', { password: 'pw', expires: '7d' }, fakeApi as never);
    expect(fakeApi.patch).toHaveBeenCalledWith('tok123', expect.objectContaining({ password: 'pw', expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) }));
  });

  it('refuses to run with nothing to update', async () => {
    const { runUpdate } = await import('../src/commands/update.js');
    await expect(runUpdate('tok123', {}, {} as never)).rejects.toThrow(/nothing to update/);
  });
});

describe('revoke (process)', () => {
  let server: Server;
  let baseUrl: string;
  let deleteCalls: string[];

  beforeAll(async () => {
    deleteCalls = [];
    server = createServer((req, res) => {
      if (req.method === 'DELETE' && req.url?.startsWith('/api/chats/')) {
        deleteCalls.push(req.url!);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function runCli(args: string[], stdin: string): Promise<{ code: number | null; stdout: string }> {
    const child = spawn(process.execPath, ['--import', 'tsx', indexTs, ...args], {
      cwd: cliRoot,
      env: { ...process.env, QUIRE_SERVER_URL: baseUrl, QUIRE_API_KEY: 'k'.repeat(64) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stdin.write(stdin);
    child.stdin.end();
    return new Promise((resolve) => {
      const t = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.on('close', (code) => {
        clearTimeout(t);
        resolve({ code, stdout });
      });
    });
  }

  it('declining does not revoke', { timeout: 30000 }, async () => {
    const { code } = await runCli(['revoke', 'sometoken1234567890'], 'n\n');
    expect(code).toBe(0);
    expect(deleteCalls).toHaveLength(0);
  });

  it('confirming revokes', { timeout: 30000 }, async () => {
    const { code, stdout } = await runCli(['revoke', 'sometoken1234567890'], 'y\n');
    expect(code).toBe(0);
    expect(stdout).toContain('Revoked');
    expect(deleteCalls).toEqual(['/api/chats/sometoken1234567890']);
  });
});
