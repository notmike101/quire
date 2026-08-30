import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
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

  it('warns on stderr when the message cap drops the tail (Round 8)', async () => {
    // Hitting the cap silently drops the tail of the transcript — the adapter
    // must say so (once) instead of publishing a truncated session with no trace.
    const tmp = mkdtempSync(join(tmpdir(), 'quire-cc-warn-'));
    try {
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        lines.push(JSON.stringify({ type: 'user', timestamp: '2026-08-20T00:00:00Z', message: { role: 'user', content: 'x' } }));
      }
      writeFileSync(join(tmp, 'warn-session.jsonl'), lines.join('\n'));
      const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
      const spy = vi.spyOn(process.stderr, 'write');
      try {
        const s = await makeClaudeCodeAdapter(tmp, 3).loadSession('warn-session');
        expect(s.messages.length).toBe(3);
        expect(spy.mock.calls.some((c) => String(c[0]).includes('more than 3 messages'))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not embed a tool_result image block with a non-image media_type (Round 8)', async () => {
    // A tool_result can carry {type:'image', source:{media_type, data}} blocks.
    // Only image/* payloads are images — a text/html (or any other) media_type
    // must not flow into an image part.
    const tmp = mkdtempSync(join(tmpdir(), 'quire-cc-mime-'));
    try {
      const events = [
        { type: 'assistant', timestamp: '2026-08-20T00:00:00Z', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: 'toolu_mime', name: 'Fetch', input: { url: 'http://x' } }] } },
        { type: 'user', timestamp: '2026-08-20T00:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mime', content: [{ type: 'image', source: { type: 'base64', media_type: 'text/html', data: 'aGVsbG8=' } }] }] } },
      ];
      writeFileSync(join(tmp, 'mime-session.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
      const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
      const s = await makeClaudeCodeAdapter(tmp).loadSession('mime-session');
      const allParts = s.messages.flatMap((m) => m.parts);
      expect(allParts.some((p) => p.type === 'image')).toBe(false);
      // The tool card still renders (its output is the stringified content).
      const tool = allParts.find((p) => p.type === 'tool')!;
      expect(tool.tool).toBe('Fetch');
      expect(tool.output).toContain('text/html');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('honors the session-wide image budget (Round 8)', async () => {
    // Two image blocks in one tool_result. With a budget of exactly one
    // image's bytes, the first embeds and the second becomes a tooLarge
    // placeholder — the cumulative cap, not just the per-image cap.
    const tmp = mkdtempSync(join(tmpdir(), 'quire-cc-budget-'));
    try {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';
      const bytes = Buffer.byteLength(png, 'base64');
      const events = [
        { type: 'assistant', timestamp: '2026-08-20T00:00:00Z', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: 'toolu_img', name: 'Screenshot', input: {} }] } },
        { type: 'user', timestamp: '2026-08-20T00:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_img', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        ] }] } },
      ];
      writeFileSync(join(tmp, 'budget-session.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
      const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
      const s = await makeClaudeCodeAdapter(tmp, 50_000, bytes).loadSession('budget-session');
      const imgs = s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'image') as { src?: string; tooLarge?: boolean; bytes?: number }[];
      expect(imgs).toHaveLength(2);
      expect(imgs[0]!.src).toBe(`data:image/png;base64,${png}`);
      expect(imgs[0]!.tooLarge).toBeUndefined();
      expect(imgs[1]!.tooLarge).toBe(true);
      expect(imgs[1]!.src).toBeUndefined();
      expect(imgs[1]!.bytes).toBe(bytes);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reads only a bounded head for the title (Round 8)', async () => {
    // A first line far larger than the 256 KB head: the summary event that
    // follows it lies beyond the head, so the title must fall back to the id —
    // proving listSessions does not read the whole (potentially multi-GB) file.
    const tmp = mkdtempSync(join(tmpdir(), 'quire-cc-head-'));
    try {
      const big = JSON.stringify({ type: 'user', timestamp: '2026-08-20T00:00:00Z', message: { role: 'user', content: 'x'.repeat(300 * 1024) } });
      const summary = JSON.stringify({ type: 'summary', summary: 'The real title' });
      writeFileSync(join(tmp, 'big-head.jsonl'), `${big}\n${summary}\n`);
      const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
      const sessions = await makeClaudeCodeAdapter(tmp).listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.id).toBe('big-head');
      expect(sessions[0]!.title).toBe('big-head'); // fell back to the id
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('streams a multi-MB .jsonl line by line with identical results (C-F3)', async () => {
    // A ~3 MB session: the loader must read the file in a bounded stream and
    // produce exactly the messages a whole-file read would (regression guard
    // for the streaming rewrite).
    const tmp = mkdtempSync(join(tmpdir(), 'quire-cc-stream-'));
    try {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) {
        lines.push(JSON.stringify({ type: 'user', timestamp: '2026-08-20T00:00:00Z', message: { role: 'user', content: `msg ${i} ` + 'x'.repeat(900) } }));
      }
      writeFileSync(join(tmp, 'stream-session.jsonl'), lines.join('\n'));
      const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
      const s = await makeClaudeCodeAdapter(tmp).loadSession('stream-session');
      expect(s.messages).toHaveLength(3000);
      expect(s.messages[0]!.parts[0]!.text).toBe('msg 0 ' + 'x'.repeat(900));
      expect(s.messages[2999]!.parts[0]!.text).toBe('msg 2999 ' + 'x'.repeat(900));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips a broken symlink in the projects dir instead of throwing (C-F12)', async () => {
    // A dangling symlink (or any unstat-able entry) must not crash the
    // session listing — statSync follows the link and throws ENOENT.
    const tmp = mkdtempSync(join(tmpdir(), 'quire-cc-broken-'));
    try {
      const lines = [JSON.stringify({ type: 'user', timestamp: '2026-08-20T00:00:00Z', message: { role: 'user', content: 'hi' } })];
      writeFileSync(join(tmp, 'ok-session.jsonl'), lines.join('\n'));
      symlinkSync(join(tmp, 'does-not-exist.jsonl'), join(tmp, 'broken.jsonl'));
      const { makeClaudeCodeAdapter } = await import('../src/harness/claude-code.js');
      const sessions = await makeClaudeCodeAdapter(tmp).listSessions();
      expect(sessions.map((s) => s.id)).toEqual(['ok-session']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
