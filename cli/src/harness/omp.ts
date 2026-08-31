import { lstat, readFile } from 'node:fs/promises';
import type { HarnessAdapter, ShapedMessage, ShapedSession } from './types.js';
import { MAX_SESSION_MESSAGES } from '../shape.js';
import { MAX_SESSION_IMAGE_BYTES } from '../image.js';

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

function shapeOmpBranch(_branch: OmpEntry[], _header: OmpHeader): ShapedMessage[] {
  return [];
}

export function makeOmpAdapter(options: OmpAdapterOptions = {}): HarnessAdapter {
  const maxHtmlBytes = options.maxHtmlBytes ?? OMP_MAX_HTML_BYTES;
  const maxSessionDataBytes = options.maxSessionDataBytes ?? OMP_MAX_SESSION_DATA_BYTES;
  const maxMessages = options.maxMessages ?? MAX_SESSION_MESSAGES;
  const maxImageBytes = options.maxImageBytes ?? MAX_SESSION_IMAGE_BYTES;
  void maxMessages;
  void maxImageBytes;

  return {
    name: 'omp',
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
      return {
        sessionId: data.header.id,
        title: data.header.title ?? data.header.id,
        messages: shapeOmpBranch(branch, data.header),
      };
    },
  };
}
