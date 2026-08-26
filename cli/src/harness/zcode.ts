import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter, HarnessSessionInfo, ShapedMessage, ShapedPart, ShapedSession } from './types.js';
import { truncateOutput } from '../shape.js';

export function zcodeDbPath(): string {
  return join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

type SessionRow = { id: string; title: string | null; time_updated: number; };
interface MessageData { role?: string; modelID?: string; model?: string; providerID?: string; }
type PartRow = { message_id: string; data: string; };

interface RawPart {
  type?: string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: unknown };
}

function partToShaped(raw: RawPart): ShapedPart | null {
  switch (raw.type) {
    case 'text':
      return typeof raw.text === 'string' ? { type: 'text', text: raw.text } : null;
    case 'reasoning':
      return typeof raw.text === 'string' ? { type: 'reasoning', text: raw.text } : null;
    case 'tool': {
      const output = typeof raw.state?.output === 'string' ? truncateOutput(raw.state.output) : undefined;
      return {
        type: 'tool',
        callID: raw.callID,
        tool: raw.tool,
        status: raw.state?.status,
        input: raw.state?.input,
        output,
      };
    }
    default:
      return null; // step-start, step-finish, compaction
  }
}

export function makeZcodeAdapter(dbPath: string = zcodeDbPath()): HarnessAdapter {
  const open = (): DatabaseSync => new DatabaseSync(dbPath, { readOnly: true });

  return {
    name: 'zcode',

    async listSessions(): Promise<HarnessSessionInfo[]> {
      const db = open();
      try {
        const rows = db
          .prepare(
            `select id, title, time_updated from session
             where coalesce(task_type, 'interactive') != 'subagent_child'
             order by time_updated desc limit 50`,
          )
          .all() as SessionRow[];
        return rows.map((r) => ({
          id: r.id,
          title: r.title ?? r.id,
          updatedAt: new Date(r.time_updated).toISOString(),
          isSubagent: false,
        }));
      } finally {
        db.close();
      }
    },

    async resolveCurrent(): Promise<HarnessSessionInfo> {
      const all = await this.listSessions();
      if (all.length === 0) throw new Error('no ZCode sessions found');
      return all[0]!;
    },

    async loadSession(id: string): Promise<ShapedSession> {
      const db = open();
      try {
        const sess = db.prepare('select id, title from session where id = ?').get(id) as
          | { id: string; title: string | null }
          | undefined;
        if (!sess) throw new Error(`ZCode session not found: ${id}`);
        const rows = db
          .prepare('select id, data from message where session_id = ? order by sequence')
          .all(id) as { id: string; data: string }[];
        const messages = rows.map((r) => ({ id: r.id, data: JSON.parse(r.data) as MessageData }));
        const parts = db
          .prepare('select message_id, data from part where session_id = ? order by sequence')
          .all(id) as PartRow[];
        const byMessage = new Map<string, ShapedPart[]>();
        for (const p of parts) {
          const shaped = partToShaped(JSON.parse(p.data) as RawPart);
          if (!shaped) continue;
          const list = byMessage.get(p.message_id) ?? [];
          list.push(shaped);
          byMessage.set(p.message_id, list);
        }
        const out: ShapedMessage[] = [];
        for (const m of messages) {
          const role = m.data.role;
          if (role !== 'user' && role !== 'assistant') continue;
          const kept = byMessage.get(m.id) ?? [];
          if (kept.length === 0) continue;
          out.push({ role, parts: kept });
        }
        return {
          sessionId: id,
          title: sess.title ?? id,
          model: messages.find((m) => m.data.modelID !== undefined)?.data.modelID
            ?? messages.find((m) => m.data.model !== undefined)?.data.model
            ?? undefined,
          provider: messages.find((m) => m.data.providerID !== undefined)?.data.providerID ?? undefined,
          messages: out,
        };
      } finally {
        db.close();
      }
    },
  };
}
