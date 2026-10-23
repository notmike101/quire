import { afterAll, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeCodexAdapter } from '../src/harness/codex.js';

const tempDirs: string[] = [];

/**
 * Create an isolated Codex store with two parent tasks and one child.
 *
 * @returns Database and empty parent/child rollout paths.
 */
function makeStateDb(): { dbPath: string; parentRollout: string; childRollout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'quire-codex-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'state_5.sqlite');
  const parentRollout = join(dir, 'parent.jsonl');
  const childRollout = join(dir, 'child.jsonl');
  writeFileSync(parentRollout, '');
  writeFileSync(childRollout, '');

  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table threads (
      id text primary key,
      rollout_path text not null,
      updated_at integer not null,
      updated_at_ms integer,
      title text not null,
      model_provider text not null,
      model text,
      cwd text not null,
      agent_role text,
      agent_path text
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text primary key,
      status text not null
    );
  `);
  const insert = db.prepare(`
    insert into threads
      (id, rollout_path, updated_at, updated_at_ms, title, model_provider, model, cwd, agent_role, agent_path)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('parent-old', parentRollout, 1_700_000_000, 1_700_000_000_000, 'Old parent', 'openai', 'gpt-test', dir, null, null);
  insert.run('parent-new', parentRollout, 1_700_000_100, 1_700_000_100_000, 'New parent', 'openai', 'gpt-test', dir, null, null);
  insert.run('child', childRollout, 1_700_000_200, 1_700_000_200_000, 'Child', 'openai', 'gpt-test', dir, 'worker', '/root/child');
  db.prepare('insert into thread_spawn_edges values (?, ?, ?)').run('parent-new', 'child', 'completed');
  db.close();
  return { dbPath, parentRollout, childRollout };
}

/**
 * Serialize a Codex response-item event.
 *
 * @param payload - Response-item payload.
 * @param timestamp - Deterministic event timestamp.
 * @returns JSONL-ready event text without a trailing newline.
 */
function event(payload: Record<string, unknown>, timestamp = '2026-08-31T12:00:00.000Z'): string {
  return JSON.stringify({ timestamp, type: 'response_item', payload });
}

describe('Codex task discovery', () => {
  it('lists newest top-level tasks and excludes child tasks', async () => {
    const { dbPath } = makeStateDb();
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    const sessions = await makeCodexAdapter(dbPath, {}).listSessions();

    expect(sessions).toEqual([
      { id: 'parent-new', title: 'New parent', updatedAt: '2023-11-14T22:15:00.000Z', isSubagent: false },
      { id: 'parent-old', title: 'Old parent', updatedAt: '2023-11-14T22:13:20.000Z', isSubagent: false },
    ]);
  });

  it('resolves CODEX_THREAD_ID exactly, including a child task', async () => {
    const { dbPath } = makeStateDb();
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    await expect(makeCodexAdapter(dbPath, { CODEX_THREAD_ID: 'child' }).resolveCurrent()).resolves.toEqual({
      id: 'child',
      title: 'Child',
      updatedAt: '2023-11-14T22:16:40.000Z',
      isSubagent: true,
    });
  });

  it('does not fall back when CODEX_THREAD_ID names a missing task', async () => {
    const { dbPath } = makeStateDb();
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    await expect(makeCodexAdapter(dbPath, { CODEX_THREAD_ID: 'missing' }).resolveCurrent()).rejects.toThrow(
      'Codex task not found: missing',
    );
  });

  it('falls back to the newest top-level task without a current-task signal', async () => {
    const { dbPath } = makeStateDb();
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    await expect(makeCodexAdapter(dbPath, {}).resolveCurrent()).resolves.toMatchObject({ id: 'parent-new' });
  });

  it('loads an explicitly selected child task', async () => {
    const { dbPath } = makeStateDb();
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    await expect(makeCodexAdapter(dbPath, {}).loadSession('child')).resolves.toEqual({
      sessionId: 'child',
      title: 'Child',
      model: 'gpt-test',
      provider: 'openai',
      messages: [],
    });
  });

  it('reads task recency from SQLite rather than the database file mtime', async () => {
    const { dbPath } = makeStateDb();
    const { codexStoreUpdatedAt } = await import('../src/harness/codex.js');

    expect(codexStoreUpdatedAt(dbPath)).toBe(1_700_000_200_000);
    expect(codexStoreUpdatedAt(join(dirname(dbPath), 'missing.sqlite'))).toBeUndefined();
  });
});

describe('Codex rollout shaping', () => {
  it('drops leading Codex context injections without dropping ordinary mentions', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    const events = [
      event({
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<recommended_plugins>\nprivate plugin inventory\n</recommended_plugins>' },
          { type: 'input_text', text: '# AGENTS.md instructions for D:\\quire\n\n<INSTRUCTIONS>private instructions</INSTRUCTIONS>' },
          { type: 'input_text', text: '<environment_context>\n<cwd>D:\\quire</cwd>\n</environment_context>' },
          { type: 'input_text', text: '<system-reminder>private reminder</system-reminder>' },
        ],
      }),
      event({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Tell me about this repository.' }] }),
      event({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'The docs mention <recommended_plugins> in prose.' }],
      }),
    ];
    writeFileSync(parentRollout, `${events.join('\n')}\n`);
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages).toEqual([
      { role: 'user', time: '2026-08-31T12:00:00.000Z', parts: [{ type: 'text', text: 'Tell me about this repository.' }] },
      {
        role: 'user',
        time: '2026-08-31T12:00:00.000Z',
        parts: [{ type: 'text', text: 'The docs mention <recommended_plugins> in prose.' }],
      },
    ]);
  });

  it('omits Quire publish calls so an earlier preview cannot leak back into a republished task', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    const events = [
      event({
        type: 'custom_tool_call',
        call_id: 'share-call',
        name: 'exec',
        input: 'tools.exec_command({"cmd":"quire publish --current --harness codex --yes"})',
      }),
      event({
        type: 'custom_tool_call_output',
        call_id: 'share-call',
        output: 'preview: <recommended_plugins>private plugin inventory</recommended_plugins>',
      }),
      event({ type: 'custom_tool_call', call_id: 'normal-call', name: 'exec', input: 'tools.exec_command({"cmd":"git status"})' }),
      event({ type: 'custom_tool_call_output', call_id: 'normal-call', output: 'clean' }),
    ];
    writeFileSync(parentRollout, `${events.join('\n')}\n`);
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages).toEqual([
      {
        role: 'assistant',
        time: '2026-08-31T12:00:00.000Z',
        parts: [{ type: 'tool', callID: 'normal-call', tool: 'exec', input: 'tools.exec_command({"cmd":"git status"})', output: 'clean' }],
      },
    ]);
  });

  it('keeps visible conversation items and correlates tool outputs', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    const events = [
      event({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'hidden developer' }] }),
      event({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }),
      event({ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'checking' }] }),
      event({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'considered options' }], encrypted_content: 'hidden reasoning' }),
      event({ type: 'function_call', call_id: 'f1', name: 'read_file', namespace: 'workspace', arguments: '{"path":"README.md"}' }),
      event({ type: 'function_call_output', call_id: 'f1', output: 'file contents' }),
      event({ type: 'custom_tool_call', call_id: 'c1', name: 'exec_command', input: '{"cmd":"pwd"}', status: 'completed' }),
      event({ type: 'custom_tool_call_output', call_id: 'c1', output: 'D:/quire' }),
      event({ type: 'agent_message', author: '/root/child', recipient: '/root', content: [{ type: 'input_text', text: 'internal agent traffic' }] }),
      event({ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'done' }] }),
    ];
    writeFileSync(parentRollout, `${events.join('\n')}\n`);
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages).toEqual([
      { role: 'user', time: '2026-08-31T12:00:00.000Z', parts: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', time: '2026-08-31T12:00:00.000Z', parts: [{ type: 'text', text: 'checking' }] },
      { role: 'assistant', time: '2026-08-31T12:00:00.000Z', parts: [{ type: 'reasoning', text: 'considered options' }] },
      {
        role: 'assistant',
        time: '2026-08-31T12:00:00.000Z',
        parts: [{ type: 'tool', callID: 'f1', tool: 'workspace.read_file', input: { path: 'README.md' }, output: 'file contents' }],
      },
      {
        role: 'assistant',
        time: '2026-08-31T12:00:00.000Z',
        parts: [{ type: 'tool', callID: 'c1', tool: 'exec_command', status: 'completed', input: { cmd: 'pwd' }, output: 'D:/quire' }],
      },
      { role: 'assistant', time: '2026-08-31T12:00:00.000Z', parts: [{ type: 'text', text: 'done' }] },
    ]);
    expect(JSON.stringify(session)).not.toContain('hidden developer');
    expect(JSON.stringify(session)).not.toContain('hidden reasoning');
    expect(JSON.stringify(session)).not.toContain('internal agent traffic');
  });

  it.each([{ summary: [] }, { summary: [{ type: 'summary_text', text: '' }] }, { summary: undefined }])('keeps an empty thinking marker without exposing encrypted reasoning ($summary)', async ({ summary }) => {
    const { dbPath, parentRollout } = makeStateDb();
    writeFileSync(parentRollout, [
      event({ type: 'reasoning', summary, encrypted_content: 'unpublished encrypted reasoning' }),
      event({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible answer' }] }),
    ].join('\n'));
    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');
    expect(session.messages[0]?.parts).toEqual([{ type: 'reasoning', text: '' }]);
    expect(session.messages[1]?.parts).toEqual([{ type: 'text', text: 'Visible answer' }]);
    expect(JSON.stringify(session)).not.toContain('unpublished encrypted reasoning');
  });

  it.each([
    ['result status', { status: 'failed', output: 'denied' }],
    ['snake-case error flag', { is_error: true, output: 'denied' }],
    ['camel-case error flag', { isError: true, output: 'denied' }],
    ['result exit code', { exit_code: -1, output: 'command failed' }],
    ['result metadata', { metadata: { exit_code: 1 }, output: 'command failed' }],
    ['structured output status', { output: { status: 'error', content: 'denied' } }],
    ['JSON output error flag', { output: '{"is_error":true,"content":"denied"}' }],
    ['structured output error flag', { output: { isError: true, content: 'denied' } }],
    ['command exit code', { output: { exit_code: 2, output: 'command failed' } }],
    ['command metadata', { output: '{"output":"command failed","metadata":{"exit_code":1}}' }],
  ])('marks explicit failure from %s', async (_name, result) => {
    const { dbPath, parentRollout } = makeStateDb();
    writeFileSync(parentRollout, [
      event({ type: 'function_call', call_id: 'failed', name: 'exec_command', arguments: '{"cmd":"false"}', status: 'completed' }),
      event({ type: 'function_call_output', call_id: 'failed', ...result }),
    ].join('\n'));

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages[0]?.parts[0]?.status).toBe('error');
  });

  it.each([{ isError: true }, { is_error: true }, { status: 'failed' }])('keeps native read result failure metadata %#', async (output) => {
    const { dbPath, parentRollout } = makeStateDb();
    writeFileSync(parentRollout, [
      event({ type: 'function_call', call_id: 'read', name: 'read_file', arguments: '{}' }),
      event({ type: 'function_call_output', call_id: 'read', output }),
    ].join('\n'));

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages[0]?.parts[0]?.status).toBe('error');
  });

  it.each(['is_error', 'isError'])('keeps explicit %s call failures without a result', async (flag) => {
    const { dbPath, parentRollout } = makeStateDb();
    writeFileSync(parentRollout, event({
      type: 'function_call', call_id: 'failed', name: 'read_file', arguments: '{}', [flag]: true,
    }));

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages[0]?.parts[0]?.status).toBe('error');
  });

  it('recognizes structured command envelopes inside Codex exec text blocks', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    writeFileSync(parentRollout, [
      event({ type: 'custom_tool_call', call_id: 'exec', name: 'exec', input: 'tools.exec_command({"cmd":"false"})' }),
      event({ type: 'custom_tool_call_output', call_id: 'exec', output: [
        { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
        { type: 'input_text', text: '{"chunk_id":"abc","wall_time_seconds":0.1,"exit_code":1,"output":"denied"}' },
      ] }),
    ].join('\n'));

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages[0]?.parts[0]?.status).toBe('error');
  });

  it('reads command failure envelopes before truncating output', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    writeFileSync(parentRollout, [
      event({ type: 'function_call', call_id: 'exec', name: 'exec_command', arguments: '{"cmd":"false"}' }),
      event({ type: 'function_call_output', call_id: 'exec', output: {
        output: 'x'.repeat(30_000),
        metadata: { exit_code: 1 },
      } }),
      event({ type: 'function_call', call_id: 'wait', name: 'write_stdin', arguments: '{"session_id":1,"chars":""}' }),
      event({ type: 'function_call_output', call_id: 'wait', output: 'Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 2\nFinal output:\ndenied' }),
    ].join('\n'));

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages.map((message) => message.parts[0]?.status)).toEqual(['error', 'error']);
    expect(session.messages[0]?.parts[0]?.output).toContain('[truncated ');
    expect(session.messages[0]?.parts[0]?.output).not.toContain('exit_code');
  });

  it.each([
    ['read_file', 'error: failed to parse the example'],
    ['read_file', '{"isError":true}'],
    ['read_file', '{"is_error":true}'],
    ['read_file', '{"exit_code":1}'],
    ['read_file', '{"metadata":{"exit_code":1}}'],
    ['read_file', '{"status":"error"}'],
    ['read_file', { data: { isError: true, metadata: { exit_code: 1 }, status: 'error' } }],
    ['read_file', { content: '{"isError":true}', path: 'example.json' }],
    ['read_file', 'Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 1\nFinal output:\nquoted documentation'],
    ['read_file', [{ type: 'input_text', text: '{"exit_code":1,"output":"quoted documentation"}' }]],
    ['exec_command', 'Process exited with code 1'],
    ['exec_command', 'Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 0\nFinal output:\nProcess exited with code 1\nerror: failed example'],
    ['exec_command', { exit_code: 0, output: 'error: a message in a successful command' }],
    ['exec_command', { metadata: { exit_code: null }, output: 'unknown result' }],
    ['exec_command', { exit_code: 'unknown', is_error: false, isError: false, output: 'unknown result' }],
    ['exec_command', null],
    ['read_file', { content: [{ type: 'text', text: '{"isError":true}' }] }],
  ])('does not infer failure for nonfailure %s result %#', async (name, output) => {
    const { dbPath, parentRollout } = makeStateDb();
    writeFileSync(parentRollout, [
      event({ type: 'function_call', call_id: 'ok', name, arguments: '{}' }),
      event({ type: 'function_call_output', call_id: 'ok', output }),
    ].join('\n'));

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages[0]?.parts[0]?.status).toBeUndefined();
  });

  it('preserves an explicitly failed call when a later output reports success', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    writeFileSync(parentRollout, [
      event({ type: 'function_call', call_id: 'failed', name: 'exec_command', arguments: '{}', status: 'failed' }),
      event({ type: 'function_call_output', call_id: 'failed', status: 'completed', is_error: false, output: { exit_code: 0 } }),
    ].join('\n'));

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages[0]?.parts[0]?.status).toBe('failed');
  });

  it('skips malformed JSONL lines and keeps later valid events', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    writeFileSync(parentRollout, `{broken\n${event({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'survived' }] })}\n`);
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'survived' });
  });

  it('caps shaped messages and warns once', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    writeFileSync(
      parentRollout,
      `${[0, 1, 2, 3].map((n) => event({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `message ${n}` }] })).join('\n')}\n`,
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    const session = await makeCodexAdapter(dbPath, {}, 2).loadSession('parent-new');

    expect(session.messages).toHaveLength(2);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('only the first 2 are published');
    stderr.mockRestore();
  });

  it('embeds data-URI images within the session image budget', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    const image = 'data:image/png;base64,YWJj';
    writeFileSync(
      parentRollout,
      `${event({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: image }] })}\n`,
    );
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    const session = await makeCodexAdapter(dbPath, {}, 10, 3).loadSession('parent-new');

    expect(session.messages[0]?.parts).toEqual([
      { type: 'image', src: image, mime: 'image/png', alt: 'image', bytes: 3 },
    ]);
  });

  it('emits a placeholder when a data-URI image exceeds the remaining budget', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    const image = 'data:image/png;base64,YWJjZA==';
    writeFileSync(
      parentRollout,
      `${event({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: image }] })}\n`,
    );
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    const session = await makeCodexAdapter(dbPath, {}, 10, 3).loadSession('parent-new');

    expect(session.messages[0]?.parts).toEqual([
      { type: 'image', mime: 'image/png', alt: 'image', bytes: 4, tooLarge: true },
    ]);
  });

  it('embeds a local image only when it is inside the task working directory', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    const imagePath = join(dirname(parentRollout), 'inside.png');
    writeFileSync(imagePath, 'abc');
    writeFileSync(
      parentRollout,
      `${event({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: pathToFileURL(imagePath).href }] })}\n`,
    );
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages[0]?.parts).toEqual([
      { type: 'image', src: 'data:image/png;base64,YWJj', mime: 'image/png', alt: 'image', bytes: 3 },
    ]);
  });

  it('ignores remote and out-of-workspace image references', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    const outsideDir = mkdtempSync(join(tmpdir(), 'quire-codex-outside-'));
    tempDirs.push(outsideDir);
    const outsideImage = join(outsideDir, 'outside.png');
    writeFileSync(outsideImage, 'secret');
    writeFileSync(
      parentRollout,
      `${event({
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'safe' },
          { type: 'input_image', image_url: 'https://example.com/remote.png' },
          { type: 'input_image', image_url: pathToFileURL(outsideImage).href },
        ],
      })}\n`,
    );
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    const session = await makeCodexAdapter(dbPath, {}).loadSession('parent-new');

    expect(session.messages[0]?.parts).toEqual([{ type: 'text', text: 'safe' }]);
  });

  it('reports a clear error when the rollout file is missing', async () => {
    const { dbPath, parentRollout } = makeStateDb();
    rmSync(parentRollout);
    const { makeCodexAdapter } = await import('../src/harness/codex.js');

    await expect(makeCodexAdapter(dbPath, {}).loadSession('parent-new')).rejects.toThrow(
      'Could not read Codex rollout for task parent-new',
    );
  });
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
