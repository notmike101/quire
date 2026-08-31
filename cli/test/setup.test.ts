 import { describe, it, expect, vi, afterAll } from 'vitest';
 import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
 import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { fileURLToPath } from 'node:url';
 import { dirname, join } from 'node:path';
import { ompAgentDir, installOmpShareHandler, runSetup } from '../src/commands/setup.js';
import { OMP_SHARE_HANDLER_SOURCE } from '../src/omp-share-handler.js';
 
 vi.mock('node:fs/promises', async (importOriginal) => {
   const actual = await importOriginal<typeof import('node:fs/promises')>();
   return { ...actual, rename: vi.fn(actual.rename) };
 });

const dir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(dir, '..');
const indexTs = join(cliRoot, 'src', 'index.ts');

const tempDirs: string[] = [];
function trackTemp(d: string): string {
  tempDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe('ompAgentDir', () => {
  it('defaults to <home>/.omp/agent', () => {
    expect(ompAgentDir({}, 'C:/users/test')).toBe(join('C:/users/test', '.omp', 'agent'));
  });

  it('uses PI_CODING_AGENT_DIR as the agent directory itself', () => {
    expect(ompAgentDir({ PI_CODING_AGENT_DIR: 'D:/omp/agent' } as NodeJS.ProcessEnv, 'C:/users/test')).toBe('D:/omp/agent');
  });

  it('falls back to home when PI_CODING_AGENT_DIR is empty', () => {
    expect(ompAgentDir({ PI_CODING_AGENT_DIR: '' } as NodeJS.ProcessEnv, 'C:/users/test')).toBe(join('C:/users/test', '.omp', 'agent'));
  });
});

describe('installOmpShareHandler', () => {
  it('installs the bundled bytes to <home>/.omp/agent/share.mjs, creating missing directories', async () => {
    const home = trackTemp(mkdtempSync(join(tmpdir(), 'quire-setup-home-')));
    const env: NodeJS.ProcessEnv = {};

    const result = await installOmpShareHandler({ env, home });

    expect(result).toEqual({ path: join(home, '.omp', 'agent', 'share.mjs'), unchanged: false });
    expect(readFileSync(join(home, '.omp', 'agent', 'share.mjs'), 'utf8')).toBe(OMP_SHARE_HANDLER_SOURCE);
  });

  it('installs into PI_CODING_AGENT_DIR when set', async () => {
    const home = trackTemp(mkdtempSync(join(tmpdir(), 'quire-setup-home-')));
    const agentDir = join(home, 'custom-agent');
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: agentDir };

    const result = await installOmpShareHandler({ env, home });

    expect(result.path).toBe(join(agentDir, 'share.mjs'));
    expect(readFileSync(join(agentDir, 'share.mjs'), 'utf8')).toBe(OMP_SHARE_HANDLER_SOURCE);
  });

  it('returns unchanged: true when the identical bundled handler is already installed', async () => {
    const home = trackTemp(mkdtempSync(join(tmpdir(), 'quire-setup-home-')));
    const env: NodeJS.ProcessEnv = {};
    await installOmpShareHandler({ env, home });

    const result = await installOmpShareHandler({ env, home });

    expect(result).toEqual({ path: join(home, '.omp', 'agent', 'share.mjs'), unchanged: true });
  });

  it.each(['share.ts', 'share.js', 'share.mjs'] as const)(
    'refuses an existing %s and leaves it byte-identical',
    async (candidate) => {
      const home = trackTemp(mkdtempSync(join(tmpdir(), 'quire-setup-home-')));
      const env: NodeJS.ProcessEnv = {};
      const agentDir = ompAgentDir(env, home);
      const existing = candidate === 'share.mjs' ? 'user-modified handler' : OMP_SHARE_HANDLER_SOURCE;
      // Create the agent dir and the conflicting candidate.
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, candidate), existing);

      const err = await installOmpShareHandler({ env, home }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(candidate);
      expect(readFileSync(join(agentDir, candidate), 'utf8')).toBe(existing);
      expect(existsSync(join(agentDir, 'share.mjs'))).toBe(candidate === 'share.mjs');
    },
  );

  it('leaves no temporary file behind after success', async () => {
    const home = trackTemp(mkdtempSync(join(tmpdir(), 'quire-setup-home-')));
    const env: NodeJS.ProcessEnv = {};
    await installOmpShareHandler({ env, home });

    const remaining = readdirSync(ompAgentDir(env, home));
    expect(remaining).toEqual(['share.mjs']);
  });

  it('removes its temporary file after an injected rename failure', async () => {
    const home = trackTemp(mkdtempSync(join(tmpdir(), 'quire-setup-home-')));
    const env: NodeJS.ProcessEnv = {};
    vi.mocked(fsp.rename).mockRejectedValueOnce(new Error('injected rename failure'));
    const err = await installOmpShareHandler({ env, home }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('injected rename failure');
    const remaining = readdirSync(ompAgentDir(env, home));
    expect(remaining.filter((f) => f.startsWith('share.mjs.tmp-'))).toHaveLength(0);
    expect(existsSync(join(ompAgentDir(env, home), 'share.mjs'))).toBe(false);
  });

  it('never prints handler contents when runSetup installs', async () => {
    const home = trackTemp(mkdtempSync(join(tmpdir(), 'quire-setup-home-')));
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => logs.push(args.join(' ')));
    try {
      await runSetup(['omp'], { env: {} as NodeJS.ProcessEnv, home });
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');
    expect(out).toContain(join(home, '.omp', 'agent', 'share.mjs'));
    expect(out).toContain('strict redaction, no password, no expiry');
    expect(out).not.toContain('QUIRE_BIN');
    expect(out).not.toContain('parseResult');
  });
});

 describe('runSetup (process)', () => {
   function freshHome(): string {
     return trackTemp(mkdtempSync(join(tmpdir(), 'quire-setup-proc-')));
   }
 
   function runCli(args: string[], home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
     const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
     delete env.PI_CODING_AGENT_DIR;
     const child = spawn(process.execPath, ['--import', 'tsx', indexTs, ...args], {
       cwd: cliRoot,
       env,
       stdio: ['pipe', 'pipe', 'pipe'],
     });
     let stdout = '';
     let stderr = '';
     child.stdout.on('data', (d) => (stdout += d));
     child.stderr.on('data', (d) => (stderr += d));
     child.stdin.end();
     return new Promise((resolve) => {
       // Watchdog only: the test awaits the child's real 'close' event; this just bounds a hung spawn.
       const t = setTimeout(() => child.kill('SIGKILL'), 30000);
       child.on('close', (code) => {
         clearTimeout(t);
         resolve({ code, stdout, stderr });
       });
     });
   }
 
   it('quire setup omp installs and prints the final path plus the /share behavior', { timeout: 30000 }, async () => {
     const home = freshHome();
     const { code, stdout, stderr } = await runCli(['setup', 'omp'], home);
 
     expect(code, `stderr: ${stderr}`).toBe(0);
     expect(stdout).toContain(join('.omp', 'agent', 'share.mjs'));
     expect(stdout).toContain('strict redaction, no password, no expiry');
     expect(readFileSync(join(home, '.omp', 'agent', 'share.mjs'), 'utf8')).toBe(OMP_SHARE_HANDLER_SOURCE);
   });
 
   it('plain quire setup retains the key-generation instructions', { timeout: 30000 }, async () => {
     const home = freshHome();
     const { code, stdout } = await runCli(['setup'], home);
 
     expect(code).toBe(0);
     expect(stdout).toContain('QUIRE_API_KEY=');
     expect(stdout).toContain('UNLOCK_SECRET=');
     expect(existsSync(join(home, '.omp'))).toBe(false);
   });
 
   it('rejects an unknown setup target with usage and a nonzero exit', { timeout: 30000 }, async () => {
     const { code, stderr } = await runCli(['setup', 'nope'], freshHome());
 
     expect(code).toBe(1);
     expect(stderr).toMatch(/usage: quire setup/);
   });
 
   it('rejects more than one setup positional', { timeout: 30000 }, async () => {
     const { code, stderr } = await runCli(['setup', 'omp', 'omp'], freshHome());
 
     expect(code).toBe(1);
     expect(stderr).toMatch(/usage: quire setup/);
   });
 });
