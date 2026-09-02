import { describe, it, expect, vi } from 'vitest';
import { runList } from '../src/commands/list.js';
import type { ShareMeta } from '../src/api.js';

function shareMeta(overrides: Partial<ShareMeta> = {}): ShareMeta {
  return {
    id: '1',
    publicId: 'abcdefgh1234567890',
    title: 'My session',
    preset: 'strict',
    expiresAt: null,
    messageCount: 1,
    bytes: 0,
    redactions: {},
    createdAt: '2026-08-20T00:00:00Z',
    state: 'ready',
    format: 'v2',
    ...overrides,
  };
}

describe('runList', () => {
  it('prints a table with the id prefix and title', async () => {
    const api = { list: vi.fn(async () => ({ shares: [shareMeta()] })) };
    const lines: string[] = [];
    await runList(api as never, (l) => lines.push(l));
    const out = lines.join('\n');
    expect(out).toContain('abcdefgh');
    expect(out).toContain('My session');
  });

  it('prints "No shares." for an empty list', async () => {
    const api = { list: vi.fn(async () => ({ shares: [] })) };
    const lines: string[] = [];
    await runList(api as never, (l) => lines.push(l));
    expect(lines).toEqual(['No shares.']);
  });

  it('strips control characters from titles (C-F10: no terminal injection)', async () => {
    // A share title with ANSI escapes / NUL bytes (titles come from the
    // server-stored, redacted session title) must not inject terminal
    // sequences into the CLI's own output.
    const api = { list: vi.fn(async () => ({ shares: [shareMeta({ title: 'A\x00B\x1b[31mC' })] })) };
    const lines: string[] = [];
    await runList(api as never, (l) => lines.push(l));
    const out = lines.join('\n');
    expect(out).toContain('AB[31mC');
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x00');
  });
});
