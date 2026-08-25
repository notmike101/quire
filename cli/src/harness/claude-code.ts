import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter, HarnessSessionInfo, ShapedMessage, ShapedPart, ShapedSession } from './types.js';
import { truncateOutput } from '../shape.js';

export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

interface CcBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface CcEvent {
  type?: string;
  summary?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { role?: string; model?: string; content?: string | CcBlock[] };
}

function jsonlEvents(file: string): CcEvent[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as CcEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is CcEvent => e !== null);
}

function toolResultText(block: CcBlock): string {
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
}

export function makeClaudeCodeAdapter(projectsDir: string = claudeProjectsDir()): HarnessAdapter {
  const sessionFiles = (): string[] => {
    if (!existsSync(projectsDir)) return [];
    const files: string[] = [];
    for (const entry of readdirSync(projectsDir)) {
      const p = join(projectsDir, entry);
      if (statSync(p).isDirectory()) {
        for (const f of readdirSync(p)) {
          if (f.endsWith('.jsonl')) files.push(join(p, f));
        }
      } else if (entry.endsWith('.jsonl')) {
        files.push(p);
      }
    }
    return files;
  };

  const titleFor = (file: string): string => {
    const id = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '');
    try {
      for (const ev of jsonlEvents(file).slice(0, 50)) {
        if (ev.isSidechain) continue;
        if (ev.type === 'summary' && typeof ev.summary === 'string') return ev.summary;
        if (ev.type === 'user') {
          const c = ev.message?.content;
          const t = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b.type === 'text')?.text : undefined;
          if (typeof t === 'string' && t) return t.slice(0, 80);
        }
      }
    } catch {
      // unreadable file: fall back to the id
    }
    return id;
  };

  return {
    name: 'claude-code',

    async listSessions(): Promise<HarnessSessionInfo[]> {
      const infos = sessionFiles().map((file) => ({
        id: file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, ''),
        title: titleFor(file),
        updatedAt: new Date(statSync(file).mtimeMs).toISOString(),
        isSubagent: false,
      }));
      infos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return infos.slice(0, 50);
    },

    async resolveCurrent(): Promise<HarnessSessionInfo> {
      const all = await this.listSessions();
      if (all.length === 0) throw new Error('no Claude Code sessions found');
      return all[0]!;
    },

    async loadSession(id: string): Promise<ShapedSession> {
      const file = sessionFiles().find((f) => f.split(/[\\/]/).pop() === `${id}.jsonl`);
      if (!file) throw new Error(`Claude Code session not found: ${id}`);
      const messages: ShapedMessage[] = [];
      let lastAssistant: ShapedMessage | undefined;
      let title: string | undefined;
      let model: string | undefined;

      for (const ev of jsonlEvents(file)) {
        if (ev.isSidechain) continue;
        if (ev.type === 'summary' && typeof ev.summary === 'string' && !title) title = ev.summary;

        if (ev.type === 'user') {
          const content = ev.message?.content;
          if (Array.isArray(content)) {
            const results = content.filter((b) => b.type === 'tool_result');
            if (results.length > 0) {
              for (const r of results) {
                const part = lastAssistant?.parts.find((p) => p.type === 'tool' && p.callID === r.tool_use_id);
                if (part && part.type === 'tool') part.output = truncateOutput(toolResultText(r));
              }
              continue; // tool-result-only turns are not chat messages
            }
            const texts = content
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string);
            if (texts.length === 0) continue;
            messages.push({ role: 'user', parts: texts.map((t) => ({ type: 'text', text: t })), time: ev.timestamp });
            lastAssistant = undefined;
          } else if (typeof content === 'string' && content.length > 0) {
            messages.push({ role: 'user', parts: [{ type: 'text', text: content }], time: ev.timestamp });
            lastAssistant = undefined;
          }
        } else if (ev.type === 'assistant') {
          const content = ev.message?.content;
          if (!Array.isArray(content)) continue;
          const parts: ShapedPart[] = [];
          for (const b of content) {
            if (b.type === 'text' && typeof b.text === 'string') parts.push({ type: 'text', text: b.text });
            else if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push({ type: 'reasoning', text: b.thinking });
            else if (b.type === 'tool_use' && typeof b.id === 'string') parts.push({ type: 'tool', callID: b.id, tool: b.name, input: b.input });
          }
          if (parts.length === 0) continue;
          const msg: ShapedMessage = { role: 'assistant', parts, time: ev.timestamp };
          messages.push(msg);
          lastAssistant = msg;
          if (typeof ev.message?.model === 'string') model = ev.message.model;
        }
      }

      return {
        sessionId: id,
        title: title ?? id,
        model,
        messages,
      };
    },
  };
}
