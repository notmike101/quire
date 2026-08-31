import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { fileToDataUri, MAX_IMAGE_BYTES, MAX_SESSION_IMAGE_BYTES, mimeFromExtension, parseDataUri, type ImageBudget } from '../image.js';
import { MAX_SESSION_MESSAGES, truncateInput, truncateOutput } from '../shape.js';
import { extractReasoningParts, extractSystemParts } from '../system.js';
import type { HarnessAdapter, HarnessSessionInfo, ShapedMessage, ShapedPart, ShapedSession } from './types.js';

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

interface RolloutEvent {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

function parseJsonOrString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return String(value);
  }
}

function contentParts(content: unknown, budget: ImageBudget, taskRoot: string): ShapedPart[] {
  if (!Array.isArray(content)) return [];
  const parts: ShapedPart[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if ((block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'input_image' && typeof block.image_url === 'string') {
      const image = parseDataUri(block.image_url);
      if (image) {
        if (image.bytes > MAX_IMAGE_BYTES || image.bytes > budget.remaining) {
          parts.push({ type: 'image', mime: image.mime, alt: 'image', bytes: image.bytes, tooLarge: true });
        } else {
          budget.remaining -= image.bytes;
          parts.push({ type: 'image', src: image.dataUri, mime: image.mime, alt: 'image', bytes: image.bytes });
        }
        continue;
      }
      try {
        const url = new URL(block.image_url);
        if (url.protocol !== 'file:') continue;
        const filePath = fileURLToPath(url);
        const mime = mimeFromExtension(filePath);
        if (!mime) continue;
        const local = fileToDataUri(filePath, mime, Math.min(MAX_IMAGE_BYTES, budget.remaining), taskRoot);
        if (!local) continue;
        budget.remaining -= local.bytes;
        parts.push({ type: 'image', src: local.dataUri, mime: local.mime, alt: 'image', bytes: local.bytes });
      } catch {
        continue;
      }
    }
  }
  return parts;
}

function reasoningSummary(summary: unknown): string | undefined {
  if (!Array.isArray(summary)) return undefined;
  const texts = summary
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .filter((item) => item.type === 'summary_text' && typeof item.text === 'string')
    .map((item) => item.text as string);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function isCodexContextInjection(text: string): boolean {
  return /^\s*(?:<recommended_plugins(?:\s|>)|# AGENTS\.md instructions for\b|<environment_context(?:\s|>))/.test(text);
}

export function makeCodexAdapter(
  dbPath: string = codexStateDbPath(),
  env: NodeJS.ProcessEnv = process.env,
  maxMessages: number = MAX_SESSION_MESSAGES,
  maxImageBytes: number = MAX_SESSION_IMAGE_BYTES,
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
      const messages: ShapedMessage[] = [];
      const calls = new Map<string, ShapedPart>();
      const imageBudget: ImageBudget = { remaining: maxImageBytes };
      let capWarned = false;
      const pushMessage = (role: 'user' | 'assistant', parts: ShapedPart[], time?: string): void => {
        const shaped = extractReasoningParts(extractSystemParts(parts));
        const kept = role === 'user'
          ? shaped.filter((part) => part.type !== 'system' && !(part.type === 'text' && isCodexContextInjection(part.text ?? '')))
          : shaped;
        if (kept.length === 0) return;
        if (messages.length >= maxMessages) {
          if (!capWarned) {
            capWarned = true;
            process.stderr.write(`[quire] warning: session ${id} has more than ${maxMessages} messages; only the first ${maxMessages} are published\n`);
          }
          return;
        }
        messages.push({ role, parts: kept, time });
      };

      try {
        const lines = createInterface({ input: createReadStream(row.rollout_path), crlfDelay: Infinity });
        for await (const line of lines) {
          let event: RolloutEvent;
          try {
            event = JSON.parse(line) as RolloutEvent;
          } catch {
            continue;
          }
          if (event.type !== 'response_item' || !event.payload) continue;
          const payload = event.payload;
          if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
            pushMessage(payload.role, contentParts(payload.content, imageBudget, row.cwd), event.timestamp);
          } else if (payload.type === 'reasoning') {
            const text = reasoningSummary(payload.summary);
            if (text) pushMessage('assistant', [{ type: 'reasoning', text }], event.timestamp);
          } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
            const callID = typeof payload.call_id === 'string' ? payload.call_id : undefined;
            const name = typeof payload.name === 'string' ? payload.name : '?';
            const namespace = typeof payload.namespace === 'string' ? payload.namespace : undefined;
            const part: ShapedPart = {
              type: 'tool',
              callID,
              tool: namespace ? `${namespace}.${name}` : name,
              input: truncateInput(parseJsonOrString(payload.arguments ?? payload.input)),
            };
            if (typeof payload.status === 'string') part.status = payload.status;
            pushMessage('assistant', [part], event.timestamp);
            if (callID) calls.set(callID, part);
          } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
            const callID = typeof payload.call_id === 'string' ? payload.call_id : undefined;
            const part = callID ? calls.get(callID) : undefined;
            if (part) part.output = truncateOutput(stringifyOutput(payload.output));
          }
        }
      } catch {
        throw new Error(`Could not read Codex rollout for task ${id}`);
      }
      return {
        sessionId: row.id,
        title: row.title || row.id,
        model: row.model ?? undefined,
        provider: row.model_provider || undefined,
        messages,
      };
    },
  };
}
