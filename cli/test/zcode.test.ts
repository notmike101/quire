import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
// Regenerate into a temp path (not the committed fixture) so the repo fixture
// is never dirtied by a test run. The committed sample-session.sqlite is the
// canonical artifact; the SQLite header's file-change counter makes any
// in-place rewrite byte-different even with fixed timestamps (M24).
let tempDir: string;
let fixtureDb: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'quire-zcode-fixture-'));
  fixtureDb = join(tempDir, 'sample-session.sqlite');
  execFileSync(process.execPath, [join(dir, 'fixtures', 'make-fixture-db.mjs'), fixtureDb]);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
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
    expect(s.messages).toHaveLength(3); // system message skipped
    expect(s.messages[0]!.role).toBe('user');
    expect(s.messages[0]!.parts).toEqual([{ type: 'text', text: 'hello world' }]);
    const assistant = s.messages[1]!;
    // p2 text, p3 tool, p4 reasoning, p8 think-block text (split), p9 empty
    // think-block text (dropped to a text fallback).
    expect(assistant.parts.map((p) => p.type)).toEqual([
      'text', 'tool', 'reasoning', 'reasoning', 'text', 'text',
    ]);
    const tool = assistant.parts[1]!;
    expect(tool.tool).toBe('Bash');
    expect(tool.callID).toBe('c1');
    expect(tool.input).toEqual({ command: 'ls' });
    expect(tool.output!).toContain('[truncated');
    // p8: a non-empty think block becomes a reasoning part, the trailing text
    // stays a text part.
    expect(assistant.parts[3]!.type).toBe('reasoning');
    expect(assistant.parts[3]!.text).toBe('\nLet me check the file.\n');
    expect(assistant.parts[4]!.type).toBe('text');
    expect(assistant.parts[4]!.text).toBe('\nNow let me read it.');
    // p9: an empty think block is dropped; the trailing text segment is kept.
    expect(assistant.parts[5]!.type).toBe('text');
    expect(assistant.parts[5]!.text).toBe('\n\nSure, here is the final answer.');
  });

  it('splits a pure <system-reminder> user message into a system part', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    const s = await makeZcodeAdapter(fixtureDb).loadSession('sess_fixture');
    const reminderMsg = s.messages[2]!;
    expect(reminderMsg.role).toBe('user');
    expect(reminderMsg.parts).toHaveLength(1);
    expect(reminderMsg.parts[0]!.type).toBe('system');
    // The nested <untrusted_objective> stays inside the system block content.
    expect(reminderMsg.parts[0]!.text).toContain('active session goal');
    expect(reminderMsg.parts[0]!.text).toContain('<untrusted_objective>');
    expect(reminderMsg.parts[0]!.text).toContain('make the thing');
  });

  it('loadSession throws for an unknown id', async () => {
    const { makeZcodeAdapter } = await import('../src/harness/zcode.js');
    await expect(makeZcodeAdapter(fixtureDb).loadSession('sess_nope')).rejects.toThrow(/not found/);
  });
});
