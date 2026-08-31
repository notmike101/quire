import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAX_SESSION_IMAGE_BYTES } from '../image.js';
import { MAX_SESSION_MESSAGES } from '../shape.js';
import type { HarnessAdapter, HarnessSessionInfo, ShapedSession } from './types.js';

interface ThreadRow {
  id: string;
  rollout_path: string;
  updated_at: number;
  updated_at_ms: number | null;
  title: string;
  model_provider: string;
  model: string | null;
  cwd: string;
  is_subagent?: number;
}

export function codexStateDbPath(): string {
  return join(homedir(), '.codex', 'state_5.sqlite');
}

export function codexStoreUpdatedAt(dbPath: string): number | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare('select max(coalesce(updated_at_ms, updated_at * 1000)) as updated_at from threads')
      .get() as { updated_at: number | null };
    return typeof row.updated_at === 'number' ? row.updated_at : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

function updatedAt(row: ThreadRow): string {
  const value = row.updated_at_ms ?? row.updated_at * 1000;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function sessionInfo(row: ThreadRow): HarnessSessionInfo {
  return {
    id: row.id,
    title: row.title || row.id,
    updatedAt: updatedAt(row),
    isSubagent: row.is_subagent === 1,
  };
}

export function makeCodexAdapter(
  dbPath: string = codexStateDbPath(),
  env: NodeJS.ProcessEnv = process.env,
  _maxMessages: number = MAX_SESSION_MESSAGES,
  _maxImageBytes: number = MAX_SESSION_IMAGE_BYTES,
): HarnessAdapter {
  const open = (): DatabaseSync => new DatabaseSync(dbPath, { readOnly: true });
  const findThread = (id: string): ThreadRow | undefined => {
    const db = open();
    try {
      return db
        .prepare(`
          select t.*,
                 exists(select 1 from thread_spawn_edges e where e.child_thread_id = t.id) as is_subagent
          from threads t
          where t.id = ?
        `)
        .get(id) as ThreadRow | undefined;
    } finally {
      db.close();
    }
  };

  return {
    name: 'codex',

    async listSessions(): Promise<HarnessSessionInfo[]> {
      const db = open();
      try {
        const rows = db
          .prepare(`
            select t.*
            from threads t
            where not exists (
              select 1 from thread_spawn_edges e where e.child_thread_id = t.id
            )
            order by coalesce(t.updated_at_ms, t.updated_at * 1000) desc
            limit 50
          `)
          .all() as unknown as ThreadRow[];
        return rows.map(sessionInfo);
      } finally {
        db.close();
      }
    },

    async resolveCurrent(): Promise<HarnessSessionInfo> {
      const currentId = env.CODEX_THREAD_ID;
      if (currentId) {
        const row = findThread(currentId);
        if (!row) throw new Error(`Codex task not found: ${currentId}`);
        return sessionInfo(row);
      }
      const sessions = await this.listSessions();
      if (sessions.length === 0) throw new Error('no Codex tasks found');
      return sessions[0]!;
    },

    async loadSession(id: string): Promise<ShapedSession> {
      const row = findThread(id);
      if (!row) throw new Error(`Codex task not found: ${id}`);
      return {
        sessionId: row.id,
        title: row.title || row.id,
        model: row.model ?? undefined,
        provider: row.model_provider || undefined,
        messages: [],
      };
    },
  };
}
