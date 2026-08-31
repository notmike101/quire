import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];
function trackTemp(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

describe('detectHarness', () => {
  it('CODEX_THREAD_ID env wins', async () => {
    const { detectHarness } = await import('../src/harness/detect.js');
    expect(
      detectHarness({ CODEX_THREAD_ID: 'task-1', CLAUDECODE: '1', ZCODE_APP_VERSION: '1' } as NodeJS.ProcessEnv),
    ).toBe('codex');
  });

  it('CLAUDECODE env wins', async () => {
    const { detectHarness } = await import('../src/harness/detect.js');
    expect(detectHarness({ CLAUDECODE: '1', ZCODE_APP_VERSION: '1' } as NodeJS.ProcessEnv)).toBe('claude-code');
  });

  it('ZCODE_APP_VERSION env wins when CLAUDECODE is absent', async () => {
    const { detectHarness } = await import('../src/harness/detect.js');
    expect(detectHarness({ ZCODE_APP_VERSION: '1' } as NodeJS.ProcessEnv)).toBe('zcode');
  });

  it('falls back to the most recently modified store', async () => {
    const dir = trackTemp(mkdtempSync(join(tmpdir(), 'detect-')));
    const zcode = join(dir, 'zcode.sqlite');
    const cc = join(dir, 'cc.jsonl');
    const codex = join(dir, 'missing-codex.sqlite');
    writeFileSync(zcode, 'x');
    writeFileSync(cc, 'x');
    const old = new Date(Date.now() - 3600_000);
    const now = new Date();
    utimesSync(zcode, old, old);
    utimesSync(cc, now, now);
    const { detectHarness } = await import('../src/harness/detect.js');
    expect(detectHarness({}, { zcode, claudeCode: cc, codex })).toBe('claude-code');
    utimesSync(zcode, now, now);
    utimesSync(cc, old, old);
    expect(detectHarness({}, { zcode, claudeCode: cc, codex })).toBe('zcode');
  });

  it('uses Codex task recency when it is newer than the other stores', async () => {
    const dir = trackTemp(mkdtempSync(join(tmpdir(), 'detect-codex-')));
    const zcode = join(dir, 'zcode.sqlite');
    const cc = join(dir, 'cc.jsonl');
    const codex = join(dir, 'state_5.sqlite');
    writeFileSync(zcode, 'x');
    writeFileSync(cc, 'x');
    const old = new Date(1_600_000_000_000);
    utimesSync(zcode, old, old);
    utimesSync(cc, old, old);
    const db = new (await import('node:sqlite')).DatabaseSync(codex);
    db.exec('create table threads (updated_at integer not null, updated_at_ms integer)');
    db.prepare('insert into threads values (?, ?)').run(1_700_000_000, 1_700_000_000_000);
    db.close();
    const { detectHarness } = await import('../src/harness/detect.js');

    expect(detectHarness({}, { zcode, claudeCode: cc, codex })).toBe('codex');
  });

  it('throws when no signal matches', async () => {
    const dir = trackTemp(mkdtempSync(join(tmpdir(), 'detect-empty-')));
    const { detectHarness } = await import('../src/harness/detect.js');
    expect(() => detectHarness({}, { zcode: join(dir, 'nope'), claudeCode: join(dir, 'nope2'), codex: join(dir, 'nope3') })).toThrow(
      /zcode.*claude-code.*codex.*omp/,
    );
  });

  it('never auto-detects OMP from env or store signals', async () => {
    const dir = trackTemp(mkdtempSync(join(tmpdir(), 'detect-omp-')));
    const { detectHarness } = await import('../src/harness/detect.js');
    expect(() => detectHarness({ PI_CODING_AGENT_DIR: 'omp' } as NodeJS.ProcessEnv, { zcode: join(dir, 'nope'), claudeCode: join(dir, 'nope2'), codex: join(dir, 'nope3') })).toThrow(
      /could not detect a harness/,
    );
  });

  it('builds the OMP adapter only by explicit name', async () => {
    const { makeAdapter } = await import('../src/harness/detect.js');
    expect(makeAdapter('omp').name).toBe('omp');
  });
});

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
