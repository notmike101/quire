import {
  MAX_MESSAGES_PER_PAGE,
  MAX_RAIL_USER_ENTRIES,
  SHARE_PROTOCOL,
  type RailUserEntryV1,
  type ShareIndexSegmentV1,
  type ShareManifestV1,
  type ShareMessageV1,
  type SharePageV1,
} from './model.js';

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function fail(where: string, field: string): never {
  throw new ProtocolError(`${where}: invalid ${field}`);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function messageFields(m: unknown, where: string): ShareMessageV1 {
  if (typeof m !== 'object' || m === null) fail(where, 'message');
  const rec = m as Record<string, unknown>;
  const parts = rec.parts;
  if (!Array.isArray(parts)) fail(where, 'parts');
  return {
    chunkSeq: isNonNegInt(rec.chunkSeq) ? rec.chunkSeq : fail(where, 'chunkSeq'),
    seq: isNonNegInt(rec.seq) ? rec.seq : fail(where, 'seq'),
    role: rec.role === 'user' || rec.role === 'assistant' ? rec.role : fail(where, 'role'),
    time: rec.time === null || typeof rec.time === 'string' ? rec.time : fail(where, 'time'),
    parts,
  };
}

function entryFields(e: unknown, where: string): RailUserEntryV1 {
  if (typeof e !== 'object' || e === null) fail(where, 'entry');
  const rec = e as Record<string, unknown>;
  return {
    chunkSeq: isNonNegInt(rec.chunkSeq) ? rec.chunkSeq : fail(where, 'chunkSeq'),
    seq: isNonNegInt(rec.seq) ? rec.seq : fail(where, 'seq'),
    preview: typeof rec.preview === 'string' ? rec.preview : fail(where, 'preview'),
  };
}

export function parseSharePage(v: unknown): SharePageV1 {
  if (typeof v !== 'object' || v === null) fail('page', 'root');
  const root = v as Record<string, unknown>;
  if (root.protocol !== SHARE_PROTOCOL) fail('page', 'protocol');
  const shareId = typeof root.shareId === 'string' ? root.shareId : fail('page', 'shareId');
  if (shareId.length > 64) fail('page', 'shareId');
  const seq = isNonNegInt(root.seq) ? root.seq : fail('page', 'seq');
  const messages = root.messages;
  if (!Array.isArray(messages)) fail('page', 'messages');
  if (messages.length < 1 || messages.length > MAX_MESSAGES_PER_PAGE) fail('page', 'messages.length');
  return {
    protocol: SHARE_PROTOCOL,
    shareId,
    seq,
    messages: messages.map((m, i) => messageFields(m, `page.messages[${i}]`)),
  };
}

export function parseShareManifest(v: unknown): ShareManifestV1 {
  if (typeof v !== 'object' || v === null) fail('manifest', 'root');
  const root = v as Record<string, unknown>;
  if (root.protocol !== SHARE_PROTOCOL) fail('manifest', 'protocol');
  const shareId = typeof root.shareId === 'string' ? root.shareId : fail('manifest', 'shareId');
  if (shareId.length > 64) fail('manifest', 'shareId');
  const redactions = root.redactions;
  if (typeof redactions !== 'object' || redactions === null || Array.isArray(redactions)) fail('manifest', 'redactions');
  for (const [key, count] of Object.entries(redactions)) {
    if (!isNonNegInt(count)) fail('manifest', `redactions.${key}`);
  }
  return {
    protocol: SHARE_PROTOCOL,
    shareId,
    title: typeof root.title === 'string' ? root.title : fail('manifest', 'title'),
    model: root.model === undefined || typeof root.model === 'string' ? root.model : fail('manifest', 'model'),
    provider: root.provider === undefined || typeof root.provider === 'string' ? root.provider : fail('manifest', 'provider'),
    createdAt: typeof root.createdAt === 'string' ? root.createdAt : fail('manifest', 'createdAt'),
    expiresAt: root.expiresAt === null || typeof root.expiresAt === 'string' ? root.expiresAt : fail('manifest', 'expiresAt'),
    messageCount: isNonNegInt(root.messageCount) ? root.messageCount : fail('manifest', 'messageCount'),
    redactions: redactions as Record<string, number>,
    pageCount: isNonNegInt(root.pageCount) ? root.pageCount : fail('manifest', 'pageCount'),
  };
}

export function parseShareIndexSegment(v: unknown): ShareIndexSegmentV1 {
  if (typeof v !== 'object' || v === null) fail('index', 'root');
  const root = v as Record<string, unknown>;
  if (root.protocol !== SHARE_PROTOCOL) fail('index', 'protocol');
  const shareId = typeof root.shareId === 'string' ? root.shareId : fail('index', 'shareId');
  if (shareId.length > 64) fail('index', 'shareId');
  const seq = isNonNegInt(root.seq) ? root.seq : fail('index', 'seq');
  const entries = root.entries;
  if (!Array.isArray(entries)) fail('index', 'entries');
  if (entries.length > MAX_RAIL_USER_ENTRIES) fail('index', 'entries.length');
  return {
    protocol: SHARE_PROTOCOL,
    shareId,
    seq,
    entries: entries.map((e, i) => entryFields(e, `index.entries[${i}]`)),
  };
}
