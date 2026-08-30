import { closeSync, createReadStream, existsSync, openSync, readdirSync, readSync, statSync, type Stats } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter, HarnessSessionInfo, ShapedMessage, ShapedPart, ShapedSession } from './types.js';
import { truncateOutput, truncateInput, MAX_SESSION_MESSAGES } from '../shape.js';
import { extractSystemParts, extractReasoningParts } from '../system.js';
import { MAX_IMAGE_BYTES, MAX_SESSION_IMAGE_BYTES, isImageMime, type ImageBudget } from '../image.js';

export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

interface CcImageSource {
  type?: string;
  media_type?: string;
  data?: string;
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
  source?: CcImageSource;
}

interface CcEvent {
  type?: string;
  summary?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { role?: string; model?: string; content?: string | CcBlock[] };
}

// Round 9 (C-F3): stream the .jsonl line by line instead of readFileSync-ing
// the whole file. A multi-GB session file would otherwise be fully
// materialized as one string (plus the split array of lines) before parsing.
// Malformed lines are skipped, mirroring the old readFileSync path.
async function* jsonlEventsStream(file: string): AsyncGenerator<CcEvent> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        yield JSON.parse(trimmed) as CcEvent;
      } catch {
        // malformed line: skip
      }
    }
  } finally {
    rl.close();
  }
}

// Round 9 (C-F12): a broken symlink (or a file removed between readdir and
// stat) makes statSync throw; session discovery must skip the entry, not
// crash the whole list/load.
function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function toolResultText(block: CcBlock): string {
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
}

/**
 * Claude Code encodes images as {type:'image', source:{type:'base64',
 * media_type, data}} blocks inside a tool_result's content array. Extract them
 * as image parts (data URIs). Non-image content is left to toolResultText.
 */
function imagePartsFromToolResult(block: CcBlock, budget: ImageBudget): ShapedPart[] {
  const content = block.content;
  if (!Array.isArray(content)) return [];
  const out: ShapedPart[] = [];
  for (const b of content) {
    if (!b || b.type !== 'image' || !b.source) continue;
    const src = b.source;
    if (src.type !== 'base64' || typeof src.data !== 'string' || !src.media_type) continue;
    // Round 8: only image/* payloads are images — a non-image media_type
    // (e.g. text/html) must not be embedded as an image part.
    if (!isImageMime(src.media_type)) continue;
    const mime = src.media_type;
    const bytes = Buffer.byteLength(src.data, 'base64');
    // Round 8: per-image cap AND the session-wide cumulative budget.
    if (bytes > MAX_IMAGE_BYTES || budget.remaining < bytes) {
      out.push({ type: 'image', mime, alt: 'image', bytes, tooLarge: true });
    } else {
      budget.remaining -= bytes;
      out.push({ type: 'image', src: `data:${mime};base64,${src.data}`, mime, alt: 'image', bytes });
    }
  }
  return out;
}

export function makeClaudeCodeAdapter(
  projectsDir: string = claudeProjectsDir(),
  maxMessages: number = MAX_SESSION_MESSAGES,
  maxImageBytes: number = MAX_SESSION_IMAGE_BYTES,
): HarnessAdapter {
  const sessionFiles = (): string[] => {
    if (!existsSync(projectsDir)) return [];
    const files: string[] = [];
    for (const entry of readdirSync(projectsDir)) {
      const p = join(projectsDir, entry);
      const st = safeStat(p);
      if (st === null) continue; // broken symlink / vanished between readdir and stat
      if (st.isDirectory()) {
        for (const f of readdirSync(p)) {
          if (f.endsWith('.jsonl')) files.push(join(p, f));
        }
      } else if (st.isFile() && entry.endsWith('.jsonl')) {
        files.push(p);
      }
    }
    return files;
  };

// Round 8: listSessions must not read a multi-GB .jsonl just to extract a
// title. Read only a bounded head (the first events carry the summary / first
// user message) and parse lines from it. A line cut mid-JSON or mid-UTF-8 at
// the byte boundary fails JSON.parse and is skipped — the title is best-effort.
function headEvents(file: string, maxLines: number, maxBytes = 256 * 1024): CcEvent[] {
  let head: Buffer;
  try {
    const n = Math.min(statSync(file).size, maxBytes);
    const fd = openSync(file, 'r');
    try {
      head = Buffer.alloc(n);
      let off = 0;
      while (off < n) {
        const r = readSync(fd, head, off, n - off, off);
        if (r === 0) break;
        off += r;
      }
      head = head.subarray(0, off);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  return head
    .toString('utf8')
    .split('\n')
    .slice(0, maxLines)
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

  const titleFor = (file: string): string => {
    const id = file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, '');
    try {
      for (const ev of headEvents(file, 50)) {
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
      const infos: HarnessSessionInfo[] = [];
      for (const file of sessionFiles()) {
        const st = safeStat(file);
        if (st === null) continue; // vanished between sessionFiles() and here
        infos.push({
          id: file.split(/[\\/]/).pop()!.replace(/\.jsonl$/, ''),
          title: titleFor(file),
          updatedAt: new Date(st.mtimeMs).toISOString(),
          isSubagent: false,
        });
      }
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

      // Round 5: cap the number of shaped messages (a single huge/corrupt
      // .jsonl must not be able to OOM the CLI). Events are still scanned in
      // full for the title/model; only the message list is bounded.
      let shapedCount = 0;
      let capWarned = false;
      const noteCap = (): void => {
        // Round 8: hitting the cap silently drops the tail — say so once.
        if (!capWarned) {
          capWarned = true;
          process.stderr.write(`[quire] warning: session ${id} has more than ${maxMessages} messages; only the first ${maxMessages} are published\n`);
        }
      };
      // Round 8: one cumulative image budget for the whole session.
      const imageBudget: ImageBudget = { remaining: maxImageBytes };
      for await (const ev of jsonlEventsStream(file)) {
        if (ev.isSidechain) continue;
        if (ev.type === 'summary' && typeof ev.summary === 'string' && !title) title = ev.summary;
        const atCap = shapedCount >= maxMessages;

        if (ev.type === 'user') {
          const content = ev.message?.content;
          if (Array.isArray(content)) {
            const results = content.filter((b) => b.type === 'tool_result');
            for (const r of results) {
              const part = lastAssistant?.parts.find((p) => p.type === 'tool' && p.callID === r.tool_use_id);
              if (part && part.type === 'tool') {
                part.output = truncateOutput(toolResultText(r));
                // Images the tool returned (e.g. a screenshot) — emit after the
                // tool part so the viewer shows the card, then the image.
                const imgs = imagePartsFromToolResult(r, imageBudget);
                if (imgs.length > 0 && lastAssistant) {
                  const idx = lastAssistant.parts.indexOf(part);
                  lastAssistant.parts.splice(idx + 1, 0, ...imgs);
                }
              }
            }
            // Keep sibling text blocks even when the turn also carries tool
            // results (M28) — only a tool-result-only turn is not chat.
            const texts = content
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string);
          if (texts.length === 0) continue;
          if (atCap) { noteCap(); continue; }
          messages.push({ role: 'user', parts: extractReasoningParts(extractSystemParts(texts.map((t) => ({ type: 'text', text: t })))), time: ev.timestamp });
          shapedCount++;
          lastAssistant = undefined;
        } else if (typeof content === 'string' && content.length > 0) {
          if (atCap) { noteCap(); continue; }
          messages.push({ role: 'user', parts: extractReasoningParts(extractSystemParts([{ type: 'text', text: content }])), time: ev.timestamp });
          shapedCount++;
          lastAssistant = undefined;
        }
        } else if (ev.type === 'assistant') {
          const content = ev.message?.content;
          if (!Array.isArray(content)) continue;
          const parts: ShapedPart[] = [];
          for (const b of content) {
            if (b.type === 'text' && typeof b.text === 'string') parts.push({ type: 'text', text: b.text });
            else if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push({ type: 'reasoning', text: b.thinking });
            else if (b.type === 'tool_use' && typeof b.id === 'string') parts.push({ type: 'tool', callID: b.id, tool: b.name, input: truncateInput(b.input) });
          }
          if (parts.length === 0) continue;
          if (atCap) { noteCap(); continue; }
          const msg: ShapedMessage = { role: 'assistant', parts: extractReasoningParts(extractSystemParts(parts)), time: ev.timestamp };
          messages.push(msg);
          shapedCount++;
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
