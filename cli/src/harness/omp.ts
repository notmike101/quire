import { lstat, readFile } from 'node:fs/promises';
import type { HarnessAdapter, ShapedImage, ShapedMessage, ShapedPart, ShapedSession } from './types.js';
import { MAX_SESSION_MESSAGES, truncateInput, truncateOutput, truncatePartText } from '../shape.js';
import { embedLocalMarkdownImages, isImageMime, MAX_IMAGE_BYTES, MAX_SESSION_IMAGE_BYTES, type ImageBudget } from '../image.js';

export const OMP_MAX_HTML_BYTES = 32 * 1024 * 1024;
export const OMP_MAX_SESSION_DATA_BYTES = 20 * 1024 * 1024;

export interface OmpHeader {
  type: 'session';
  id: string;
  timestamp?: string;
  cwd?: string;
  title?: string;
  additionalDirectories?: string[];
}

export interface OmpEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

export interface OmpSessionData {
  header: OmpHeader;
  entries: OmpEntry[];
  leafId: string | null;
}

export interface OmpAdapterOptions {
  maxHtmlBytes?: number;
  maxSessionDataBytes?: number;
  maxMessages?: number;
  maxImageBytes?: number;
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const ATTR_RE = /([^\s=]+)\s*=\s*(["'])(.*?)\2/g;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function scriptAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(raw)) !== null) attrs.set(match[1]!.toLowerCase(), match[3]!);
  return attrs;
}

function validateSessionData(value: unknown): OmpSessionData {
  if (!value || typeof value !== 'object') throw new Error('OMP export has an invalid payload');
  const raw = value as Record<string, unknown>;
  const header = raw.header;
  if (!header || typeof header !== 'object') throw new Error('OMP export has an invalid session header');
  const h = header as Record<string, unknown>;
  if (h.type !== 'session' || typeof h.id !== 'string' || h.id.length === 0) {
    throw new Error('OMP export has an invalid session header');
  }
  if (!Array.isArray(raw.entries)) throw new Error('OMP export has invalid entries');
  if (raw.leafId !== null && typeof raw.leafId !== 'string') throw new Error('OMP export has an invalid leaf');
  for (const entry of raw.entries) {
    if (!entry || typeof entry !== 'object') throw new Error('OMP export has an invalid entry');
    const e = entry as Record<string, unknown>;
    if (typeof e.type !== 'string' || typeof e.id !== 'string' || e.id.length === 0) {
      throw new Error('OMP export has an invalid entry');
    }
    if (e.parentId !== null && typeof e.parentId !== 'string') throw new Error('OMP export has an invalid entry parent');
  }
  return value as OmpSessionData;
}

export function extractOmpSessionData(
  html: string,
  options: Pick<OmpAdapterOptions, 'maxHtmlBytes' | 'maxSessionDataBytes'> = {},
): OmpSessionData {
  const maxHtmlBytes = options.maxHtmlBytes ?? OMP_MAX_HTML_BYTES;
  const maxSessionDataBytes = options.maxSessionDataBytes ?? OMP_MAX_SESSION_DATA_BYTES;
  if (Buffer.byteLength(html) > maxHtmlBytes) throw new Error('OMP export HTML is too large');

  const bodies: string[] = [];
  SCRIPT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_RE.exec(html)) !== null) {
    const attrs = scriptAttributes(match[1]!);
    if (attrs.get('id') === 'session-data' && attrs.get('type') === 'application/json') bodies.push(match[2]!);
  }
  if (bodies.length === 0) throw new Error('OMP export is missing the session-data script');
  if (bodies.length !== 1) throw new Error('OMP export must contain exactly one session-data script');

  const encoded = bodies[0]!.replace(/\s+/g, '');
  if (encoded.length === 0 || !BASE64_RE.test(encoded)) throw new Error('OMP export session data is not valid base64');
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length > maxSessionDataBytes) throw new Error('OMP export session data is too large');
  let value: unknown;
  try {
    value = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('OMP export session data is invalid JSON');
  }
  return validateSessionData(value);
}

export function activeOmpBranch(data: OmpSessionData): OmpEntry[] {
  if (data.leafId === null) {
    if (data.entries.length === 0) return [];
    throw new Error('OMP export is missing its active leaf');
  }
  const byId = new Map<string, OmpEntry>();
  for (const entry of data.entries) {
    if (byId.has(entry.id)) throw new Error('OMP export contains a duplicate entry id');
    byId.set(entry.id, entry);
  }
  const branch: OmpEntry[] = [];
  const seen = new Set<string>();
  let id: string | null = data.leafId;
  while (id !== null) {
    if (seen.has(id)) throw new Error('OMP export active branch contains a cycle');
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) {
      if (id === data.leafId) throw new Error('OMP export active leaf is missing');
      throw new Error('OMP export active branch parent is missing');
    }
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}

function messageTime(message: Record<string, unknown>, entry: OmpEntry): string | undefined {
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return new Date(message.timestamp).toISOString();
  }
  if (typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp))) return entry.timestamp;
  return undefined;
}

function imagePart(raw: Record<string, unknown>, budget: ImageBudget): ShapedPart | null {
  if (typeof raw.data !== 'string' || typeof raw.mimeType !== 'string' || !isImageMime(raw.mimeType)) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data)) return null;
  const bytes = Buffer.byteLength(raw.data, 'base64');
  if (bytes > MAX_IMAGE_BYTES || budget.remaining < bytes) {
    return { type: 'image', mime: raw.mimeType, bytes, tooLarge: true };
  }
  budget.remaining -= bytes;
  return { type: 'image', src: `data:${raw.mimeType};base64,${raw.data}`, mime: raw.mimeType, bytes };
}

function visibleParts(content: unknown, roots: string[], budget: ImageBudget): ShapedPart[] {
  const rawParts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const parts: ShapedPart[] = [];
  for (const raw of rawParts) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as Record<string, unknown>;
    if (part.type === 'text' && typeof part.text === 'string') {
      const embedded = embedLocalMarkdownImages(truncatePartText(part.text), roots, budget);
      parts.push({ type: 'text', text: embedded.text }, ...embedded.images);
    } else if (part.type === 'image') {
      const shaped = imagePart(part, budget);
      if (shaped) parts.push(shaped);
    }
  }
  return parts;
}

export function shapeOmpBranch(
  branch: OmpEntry[],
  header: OmpHeader,
  options: { maxMessages: number; maxImageBytes: number },
): ShapedMessage[] {
  const roots = [header.cwd, ...(header.additionalDirectories ?? [])]
    .filter((root): root is string => typeof root === 'string' && root.length > 0);
  const budget: ImageBudget = { remaining: options.maxImageBytes };
  const messages: ShapedMessage[] = [];
  const calls = new Map<string, ShapedPart>();
  let warned = false;
  const push = (message: ShapedMessage): void => {
    if (message.parts.length === 0) return;
    if (messages.length >= options.maxMessages) {
      if (!warned) {
        process.stderr.write(`[quire] warning: OMP session has more than ${options.maxMessages} messages; only the first ${options.maxMessages} are published\n`);
        warned = true;
      }
      return;
    }
    messages.push(message);
  };

  for (const entry of branch) {
    if (entry.type === 'message') {
      if (!entry.message || typeof entry.message !== 'object') continue;
      const raw = entry.message as Record<string, unknown>;
      const time = messageTime(raw, entry);
      if (raw.role === 'user') {
        if (raw.synthetic === true || raw.steering === true || raw.attribution === 'agent') continue;
        push({ role: 'user', ...(time ? { time } : {}), parts: visibleParts(raw.content, roots, budget) });
      } else if (raw.role === 'assistant' && Array.isArray(raw.content)) {
        const parts: ShapedPart[] = [];
        for (const item of raw.content) {
          if (!item || typeof item !== 'object') continue;
          const content = item as Record<string, unknown>;
          if (content.type === 'text' && typeof content.text === 'string') {
            const embedded = embedLocalMarkdownImages(truncatePartText(content.text), roots, budget);
            parts.push({ type: 'text', text: embedded.text }, ...embedded.images);
          } else if (content.type === 'thinking' && typeof content.thinking === 'string') {
            parts.push({ type: 'reasoning', text: truncatePartText(content.thinking) });
          } else if (content.type === 'image') {
            const shaped = imagePart(content, budget);
            if (shaped) parts.push(shaped);
          } else if (content.type === 'toolCall' && typeof content.id === 'string' && typeof content.name === 'string') {
            const tool: ShapedPart = {
              type: 'tool', callID: content.id, tool: content.name,
              input: truncateInput(content.arguments),
            };
            parts.push(tool);
            calls.set(content.id, tool);
          }
        }
        push({ role: 'assistant', ...(time ? { time } : {}), parts });
      } else if (raw.role === 'toolResult' && typeof raw.toolCallId === 'string') {
        const tool = calls.get(raw.toolCallId);
        if (!tool) continue;
        const resultParts = visibleParts(raw.content, roots, budget);
        const output = resultParts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
        if (output) tool.output = truncateOutput(output);
        const images = resultParts.filter((part): part is ShapedImage & { type: 'image' } => part.type === 'image');
        if (images.length > 0) tool.images = images.map(({ type: _type, ...image }) => image);
        tool.status = raw.isError === true ? 'error' : 'completed';
      }
    } else if (entry.type === 'custom_message' && entry.display === true) {
      const text = typeof entry.content === 'string'
        ? entry.content
        : Array.isArray(entry.content)
          ? entry.content.filter((part): part is { type: 'text'; text: string } => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string').map((part) => part.text).join('\n')
          : '';
      if (text) push({ role: 'assistant', ...(entry.timestamp ? { time: entry.timestamp } : {}), parts: [{ type: 'system', text: truncatePartText(text) }] });
    } else if (entry.type === 'reset_boundary') {
      push({ role: 'assistant', ...(entry.timestamp ? { time: entry.timestamp } : {}), parts: [{ type: 'system', text: 'Conversation cleared' }] });
    }
  }
  return messages;
}

export function makeOmpAdapter(options: OmpAdapterOptions = {}): HarnessAdapter {
  const maxHtmlBytes = options.maxHtmlBytes ?? OMP_MAX_HTML_BYTES;
  const maxSessionDataBytes = options.maxSessionDataBytes ?? OMP_MAX_SESSION_DATA_BYTES;
  const maxMessages = options.maxMessages ?? MAX_SESSION_MESSAGES;
  const maxImageBytes = options.maxImageBytes ?? MAX_SESSION_IMAGE_BYTES;
  return {
    name: 'omp',
    preserveDirectLoadError: true,
    async listSessions() {
      return [];
    },
    async resolveCurrent() {
      throw new Error('OMP --current is unsupported; run /share in OMP so it can supply the exact export path');
    },
    async loadSession(exportPath: string): Promise<ShapedSession> {
      let info;
      try {
        info = await lstat(exportPath);
      } catch {
        throw new Error('OMP export file is missing or unreadable');
      }
      if (!info.isFile() || info.isSymbolicLink() || info.size > maxHtmlBytes) throw new Error('invalid OMP export file');
      const data = extractOmpSessionData(await readFile(exportPath, 'utf8'), { maxHtmlBytes, maxSessionDataBytes });
      const branch = activeOmpBranch(data);
      const ordinary = branch
        .filter((entry) => entry.type === 'message' && entry.message && typeof entry.message === 'object')
        .map((entry) => entry.message as Record<string, unknown>)
        .find((message) => message.role === 'assistant' &&
          ((typeof message.model === 'string' && message.model.length > 0) ||
            (typeof message.provider === 'string' && message.provider.length > 0)));
      return {
        sessionId: data.header.id,
        title: data.header.title ?? data.header.id,
        ...(typeof ordinary?.model === 'string' && ordinary.model.length > 0 ? { model: ordinary.model } : {}),
        ...(typeof ordinary?.provider === 'string' && ordinary.provider.length > 0 ? { provider: ordinary.provider } : {}),
        messages: shapeOmpBranch(branch, data.header, { maxMessages, maxImageBytes }),
      };
    },
  };
}
