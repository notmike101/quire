import {
  MAX_MESSAGES_PER_PAGE,
  MAX_PAGE_BYTES,
  SHARE_PROTOCOL,
  type RailUserEntryV1,
  type ShareMessageV1,
  type SharePageV1,
  type SharePartV1,
} from '@quire/protocol';
import type { PreparedContent, ShapedMessage, ShapedPart } from '../redact/prepare.js';

// ShapedPart and SharePartV1 are structurally identical (the v2 wire format
// mirrors the redacted shape), so the 1:1 mapping is a shallow copy.
/**
 * Copy an already-redacted part into the viewer wire shape.
 *
 * @param part - Prepared message part.
 * @returns A shallow copy with the protocol part shape.
 */
function toPart(part: ShapedPart): SharePartV1 {
  return { ...part };
}

/**
 * Attach chunk and global sequence coordinates to a prepared message.
 *
 * @param message - Already-redacted message.
 * @param chunkSeq - Source chunk containing the message.
 * @param seq - Message sequence across the whole share.
 * @returns The viewer message with normalized time and copied parts.
 */
function toMessage(message: ShapedMessage, chunkSeq: number, seq: number): ShareMessageV1 {
  return { chunkSeq, seq, role: message.role, time: message.time ?? null, parts: message.parts.map(toPart) };
}

/**
 * Measure the exact UTF-8 size of a candidate page's JSON.
 *
 * @param shareId - Public identifier embedded in the page.
 * @param seq - Page sequence embedded in the page.
 * @param messages - Messages proposed for the page.
 * @returns Serialized page size in bytes.
 */
function pageBytes(shareId: string, seq: number, messages: ShareMessageV1[]): number {
  return Buffer.byteLength(JSON.stringify({ protocol: SHARE_PROTOCOL, shareId, seq, messages }), 'utf8');
}

/**
 * Partitions one source chunk's ALREADY-REDACTED PreparedContent into viewer
 * pages, bounded by MAX_MESSAGES_PER_PAGE and MAX_PAGE_BYTES (serialized JSON)
 * — whichever is hit first. It does not redact (prepareContent's job) and does
 * not persist (the store seals the pages).
 *
 * Message `seq` is the global index across the whole share: `startMsgSeq` is
 * the share's messageCount before this chunk, so the global index runs
 * 0..N-1 across all chunks. Page `seq` runs `startPageSeq`, `startPageSeq+1`,
 * …; `nextPageSeq` = `startPageSeq + pages.length`.
 *
 * @param input - Prepared chunk and starting viewer coordinates.
 * @param input.shareId - Public share identifier embedded in each page.
 * @param input.chunkSeq - Source chunk sequence assigned to its messages.
 * @param input.prepared - Already-redacted chunk content.
 * @param input.startPageSeq - First available global page sequence.
 * @param input.startMsgSeq - First available global message sequence.
 * @returns Viewer pages and the next unused page sequence.
 */
export function buildViewerPages(input: {
  shareId: string;
  chunkSeq: number;
  prepared: PreparedContent;
  startPageSeq: number;
  startMsgSeq: number;
}): { pages: SharePageV1[]; nextPageSeq: number } {
  const { shareId, chunkSeq, prepared, startPageSeq, startMsgSeq } = input;
  const pages: SharePageV1[] = [];
  let current: ShareMessageV1[] = [];
  let pageSeq = startPageSeq;
  /** Flush a non-empty page and advance the page sequence. */
  const emit = (): void => {
    if (current.length === 0) return;
    pages.push({ protocol: SHARE_PROTOCOL, shareId, seq: pageSeq++, messages: current });
    current = [];
  };
  for (let i = 0; i < prepared.messages.length; i++) {
    const message = toMessage(prepared.messages[i]!, chunkSeq, startMsgSeq + i);
    // A fresh page takes its first message unconditionally: a single message
    // whose own serialized size exceeds MAX_PAGE_BYTES is still emitted as a
    // one-message page (the 20 MB request cap bounds it).
    const overBound = current.length > 0 && (current.length >= MAX_MESSAGES_PER_PAGE || pageBytes(shareId, pageSeq, [...current, message]) > MAX_PAGE_BYTES);
    if (overBound) {
      emit();
      current = [message];
    } else {
      current.push(message);
    }
  }
  emit();
  return { pages, nextPageSeq: startPageSeq + pages.length };
}

/**
 * Builds the user-message rail index from the full set of decrypted pages in
 * page order. The preview matches v1's SQL projection: the first non-empty
 * text part, left(80), then whitespace-normalized. Entries
 * beyond `cap` are dropped.
 *
 * @param pages - Decrypted viewer pages in page order.
 * @param cap - Maximum number of user-message entries to retain.
 * @returns User-message coordinates and normalized text previews.
 */
export function buildRailEntries(pages: SharePageV1[], cap: number): RailUserEntryV1[] {
  const entries: RailUserEntryV1[] = [];
  for (const page of pages) {
    for (const message of page.messages) {
      if (message.role !== 'user') continue;
      const text = message.parts.find((p) => p.type === 'text' && (p.text ?? '') !== '')?.text ?? '';
      entries.push({ chunkSeq: message.chunkSeq, seq: message.seq, preview: text.slice(0, 80).replace(/\s+/g, ' ').trim() });
      if (entries.length >= cap) return entries;
    }
  }
  return entries;
}
