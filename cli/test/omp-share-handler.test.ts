import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OMP_SHARE_HANDLER_SOURCE } from '../src/omp-share-handler.js';

let tempDir: string;
let handlerPath: string;
let importCount = 0;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'quire-omp-handler-'));
  handlerPath = join(tempDir, 'share.mjs');
  writeFileSync(handlerPath, OMP_SHARE_HANDLER_SOURCE);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// Import the installed artifact (not a hand-maintained copy) with a
// cache-busting query so each test gets a fresh module instance.
/**
 * Import the installed handler with a fresh module cache key.
 *
 * @returns Handler exports from an isolated module instance.
 */
async function loadHandler(): Promise<any> {
  importCount += 1;
  return import(pathToFileURL(handlerPath).href + '?v=' + importCount);
}

interface FakeBunOptions {
  stdoutText?: string;
  stderrText?: string;
  exitCode?: number;
  spawnError?: Error;
  neverEnds?: boolean;
}

/**
 * Simulate Bun process spawning for handler success and failure scenarios.
 *
 * @param options - Process output, exit, and hanging behavior.
 * @returns Spawn implementation, recorded calls, and kill spy.
 */
function makeFakeBun(options: FakeBunOptions = {}) {
  const calls: Array<{ cmd: string[]; stdout?: string; stderr?: string; shell?: boolean }> = [];
  const kill = vi.fn();
  /**
   * Record a command and return the configured child-process behavior.
   *
   * @param opts - Command vector and stream options supplied by the handler.
   * @param opts.cmd - Executable and exact argument vector to record.
   * @param opts.stdout - Requested standard-output handling mode.
   * @param opts.stderr - Requested standard-error handling mode.
   * @returns Simulated child streams, exit promise, and kill function.
   */
  const spawn = (opts: { cmd: string[]; stdout?: string; stderr?: string }) => {
    calls.push(opts);
    if (options.spawnError) throw options.spawnError;
    const stdout = options.neverEnds
      ? new ReadableStream<Uint8Array>({
          /** Leave the stream open and silent to exercise handler timeouts. */
          start() { /* never enqueues, never closes */ },
        })
      : new Response(options.stdoutText ?? '').body;
    const exited = options.neverEnds
      ? new Promise<number>(() => { /* never resolves */ })
      : Promise.resolve(options.exitCode ?? 0);
    return {
      stdout,
      stderr: new Response(options.stderrText ?? '').body,
      exited,
      kill,
    };
  };
  return { spawn, calls, kill };
}

const EXPECTED_CMD = [
  process.platform === 'win32' ? 'quire.cmd' : 'quire',
  'publish', 'D:/tmp/a path & $(bad).html',
  '--harness', 'omp', '--preset', 'strict', '--yes',
];

describe('OMP share handler (installed source)', () => {
  it('spawns quire with the exact argument vector, no shell, and parses the published URL', async () => {
    const mod = await loadHandler();
    const fake = makeFakeBun({
      stdoutText: 'Published: https://quire.test/chats/token\nMessages: 3 · Stored: 42 bytes · Redactions: 1 generic-secret',
    });

    const result = await mod.runQuire('D:/tmp/a path & $(bad).html', fake);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.cmd).toEqual(EXPECTED_CMD);
    expect(fake.calls[0]?.shell).toBeUndefined();
    expect(result).toEqual({
      url: 'https://quire.test/chats/token',
      message: 'Messages: 3 · Stored: 42 bytes · Redactions: 1 generic-secret',
    });
  });

  it('falls back to a generic message when the Messages line is absent', async () => {
    const mod = await loadHandler();
    const fake = makeFakeBun({ stdoutText: 'Published: https://quire.test/chats/token2' });

    const result = await mod.runQuire('x.html', fake);

    expect(result.message).toBe('Session published by Quire');
  });

  it('fails when stdout has zero Published lines', async () => {
    const mod = await loadHandler();
    const fake = makeFakeBun({ stdoutText: 'Messages: 0 · Redactions: none' });

    await expect(mod.runQuire('x.html', fake)).rejects.toThrow('Quire did not return exactly one published URL');
  });

  it('fails when stdout has multiple Published lines', async () => {
    const mod = await loadHandler();
    const fake = makeFakeBun({ stdoutText: 'Published: https://a.test/1\nPublished: https://b.test/2' });

    await expect(mod.runQuire('x.html', fake)).rejects.toThrow('Quire did not return exactly one published URL');
  });

  it('fails when the published URL is not http(s)', async () => {
    const mod = await loadHandler();
    const fake = makeFakeBun({ stdoutText: 'Published: not-a-url' });

    await expect(mod.runQuire('x.html', fake)).rejects.toThrow('Quire returned an invalid published URL');
  });

  it('reports a nonzero exit concisely and never leaks stderr transcript content', async () => {
    const mod = await loadHandler();
    const sentinel = 'TRANSCRIPT_SENTINEL_DO_NOT_LEAK';
    const fake = makeFakeBun({ stdoutText: '', stderrText: 'line one\n' + sentinel + '\nline three', exitCode: 1 });

    const err = await mod.runQuire('x.html', fake).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Quire publish failed (exit 1). Check QUIRE_SERVER_URL and QUIRE_API_KEY.');
    expect((err as Error).message).not.toContain(sentinel);
  });

  it('reports a spawn failure concisely without transcript content', async () => {
    const mod = await loadHandler();
    const fake = makeFakeBun({ spawnError: new Error('ENOENT: quire not found') });

    await expect(mod.runQuire('x.html', fake)).rejects.toThrow(/Quire executable not found/);
  });

  it('fails concisely when the Bun runtime is missing (named and default exports)', async () => {
    const mod = await loadHandler();

    await expect(mod.runQuire('x.html')).rejects.toThrow(/Bun runtime/);
    await expect(mod.default('x.html')).rejects.toThrow(/Bun runtime/);
  });

  it('times out, kills the process, and reports a concise error', async () => {
    const mod = await loadHandler();
    const fake = makeFakeBun({ neverEnds: true });

    const err = await mod.runQuire('x.html', fake, 50).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out/);
    expect(fake.kill).toHaveBeenCalled();
  });
});
