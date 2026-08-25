import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const fixtureDb = join(dir, 'fixtures', 'sample-session.sqlite');

beforeAll(() => {
  execFileSync(process.execPath, [join(dir, 'fixtures', 'make-fixture-db.mjs')]);
});

describe('zcode adapter', () => {
  it('lists non-subagent sessions, newest first', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const sessions = await makeZcodeAdapter(fixtureDb).listSessions();
    expect(sessions.map((s) => s.id)).toEqual(['sess_fixture', 'sess_older']);
    expect(sessions[0]!.title).toBe('Fixture Session');
    expect(sessions.every((s) => s.isSubagent === false)).toBe(true);
  });

  it('resolveCurrent returns the most recently updated session', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const current = await makeZcodeAdapter(fixtureDb).resolveCurrent();
    expect(current.id).toBe('sess_fixture');
  });

  it('loadSession shapes parts, drops noise, truncates tool output', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const s = await makeZcodeAdapter(fixtureDb).loadSession('sess_fixture');
    expect(s.title).toBe('Fixture Session');
    expect(s.model).toBe('test-model');
    expect(s.provider).toBe('test-provider');
    expect(s.messages).toHaveLength(2); // system message skipped
    expect(s.messages[0]!.role).toBe('user');
    expect(s.messages[0]!.parts).toEqual([{ type: 'text', text: 'hello world' }]);
    const assistant = s.messages[1]!;
    expect(assistant.parts.map((p) => p.type)).toEqual(['text', 'tool', 'reasoning']);
    const tool = assistant.parts[1]!;
    expect(tool.tool).toBe('Bash');
    expect(tool.callID).toBe('c1');
    expect(tool.input).toEqual({ command: 'ls' });
    expect(tool.output!).toContain('[truncated');
  });

  it('loadSession throws for an unknown id', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    await expect(makeZcodeAdapter(fixtureDb).loadSession('sess_nope')).rejects.toThrow(/not found/);
  });
});
