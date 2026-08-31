import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
