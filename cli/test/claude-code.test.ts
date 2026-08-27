import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    expect(s.messages).toHaveLength(4); // tool_result-only user turn is not a message; sidechain skipped
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
  });

  it('splits a <system-reminder> user turn into a system part', async () => {
    const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
    const s = await makeClaudeCodeAdapter(projectsDir).loadSession('sample-session');
    const reminder = s.messages[3]!;
    expect(reminder.role).toBe('user');
    expect(reminder.parts).toHaveLength(1);
    expect(reminder.parts[0]!.type).toBe('system');
    expect(reminder.parts[0]!.text).toContain('active session goal');
  });

  it('loadSession throws for an unknown id', async () => {
    const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
    await expect(makeClaudeCodeAdapter(projectsDir).loadSession('nope')).rejects.toThrow(/not found/);
  });
});
