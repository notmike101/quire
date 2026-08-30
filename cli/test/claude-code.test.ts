import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dir = dirname(fileURLToPath(import.meta.url));
const projectsDir = join(dir, 'fixtures'); // contains sample-session.jsonl directly

describe('claude-code adapter', () => {
  it('lists sessions with title from the summary line', async () => {
    const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
    const sessions = await makeClaudeCodeAdapter(projectsDir).listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe('sample-session');
    expect(sessions[0]!.title).toBe('Fix the login bug');
  });

  it('loadSession maps events, attaches tool results, skips sidechain', async () => {
    const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
    const s = await makeClaudeCodeAdapter(projectsDir).loadSession('sample-session');
    expect(s.title).toBe('Fix the login bug');
    expect(s.model).toBe('claude-test');
    expect(s.messages).toHaveLength(5); // tool_result-only user turn is not a message; sidechain skipped
    expect(s.messages[0]!.role).toBe('user');
    expect(s.messages[0]!.parts).toEqual([{ type: 'text', text: 'please fix the login bug' }]);
    const a1 = s.messages[1]!;
    expect(a1.parts.map((p) => p.type)).toEqual(['text', 'tool']);
    const tool = a1.parts[1]!;
    expect(tool.callID).toBe('toolu_01');
    expect(tool.tool).toBe('Read');
    expect(tool.input).toEqual({ file_path: '/tmp/proj/login.ts' });
    expect(tool.output).toBe('export function login() {}');
    const a2 = s.messages[2]!;
    expect(a2.parts.map((p) => p.type)).toEqual(['reasoning', 'text']);
    // a5: an assistant turn whose text carries a literal think block. The
    // non-empty block becomes a reasoning part; the trailing text stays.
    const a5 = s.messages[3]!;
    expect(a5.parts.map((p) => p.type)).toEqual(['reasoning', 'text']);
    expect(a5.parts[0]!.text).toBe('\nI should double-check the path.\n');
    expect(a5.parts[1]!.text).toBe('\nDone.');
  });

  it('splits a <system-reminder> user turn into a system part', async () => {
    const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
    const s = await makeClaudeCodeAdapter(projectsDir).loadSession('sample-session');
    const reminder = s.messages[4]!;
    expect(reminder.role).toBe('user');
    expect(reminder.parts).toHaveLength(1);
    expect(reminder.parts[0]!.type).toBe('system');
    expect(reminder.parts[0]!.text).toContain('active session goal');
  });

  it('loadSession throws for an unknown id', async () => {
    const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
    await expect(makeClaudeCodeAdapter(projectsDir).loadSession('nope')).rejects.toThrow(/not found/);
  });

  it('caps a session at the injected maxMessages (Round 5)', async () => {
    // A single huge .jsonl must not be able to OOM the CLI. Build a temp
    // projects dir with 5 user events and cap at 3 — the adapter must stop at
    // the cap (the scan still runs in full for title/model).
    const tmp = mkdtempSync(join(tmpdir(), 'quire-cc-cap-'));
    try {
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        lines.push(JSON.stringify({ type: 'user', timestamp: '2026-08-20T00:00:00Z', message: { role: 'user', content: 'x' } }));
      }
      writeFileSync(join(tmp, 'cap-session.jsonl'), lines.join('\n'));
      const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
      const s = await makeClaudeCodeAdapter(tmp, 3).loadSession('cap-session');
      expect(s.messages.length).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
