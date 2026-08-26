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
    writeFileSync(zcode, 'x');
    writeFileSync(cc, 'x');
    const old = new Date(Date.now() - 3600_000);
    const now = new Date();
    utimesSync(zcode, old, old);
    utimesSync(cc, now, now);
    const { detectHarness } = await import('../src/harness/detect.js');
    expect(detectHarness({}, { zcode, claudeCode: cc })).toBe('claude-code');
    utimesSync(zcode, now, now);
    utimesSync(cc, old, old);
    expect(detectHarness({}, { zcode, claudeCode: cc })).toBe('zcode');
  });

  it('throws when no signal matches', async () => {
    const dir = trackTemp(mkdtempSync(join(tmpdir(), 'detect-empty-')));
    const { detectHarness } = await import('../src/harness/detect.js');
    expect(() => detectHarness({}, { zcode: join(dir, 'nope'), claudeCode: join(dir, 'nope2') })).toThrow(/--harness/);
  });
});

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
