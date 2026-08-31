import { afterAll, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDirs: string[] = [];

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
