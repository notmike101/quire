import type { ShapedMessage } from './harness/types.js';

/** Per-request cap is 20 MB (server MAX_UPLOAD_BYTES). Target slightly under so the
 *  JSON envelope (session header + create/chunk wrapper) still fits under the cap. */
export const CHUNK_TARGET_BYTES = 19 * 1024 * 1024;

/**
 * Greedily pack messages into chunks whose serialized size is <= maxBytes.
 * Order is preserved. A single message larger than maxBytes gets its own chunk
 * (it will 413 server-side; such a message is pathological). Empty input -> [].
 */
export function chunkMessages(messages: ShapedMessage[], maxBytes: number = CHUNK_TARGET_BYTES): ShapedMessage[][] {
  if (messages.length === 0) return [];
  const chunks: ShapedMessage[][] = [];
  let current: ShapedMessage[] = [];
  let size = 0;
  for (const m of messages) {
    const mSize = Buffer.byteLength(JSON.stringify(m));
    // If the current chunk is empty, start it with this message even if it alone
    // exceeds maxBytes (avoids an infinite loop on a pathological single message).
    if (current.length > 0 && size + mSize > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(m);
    size += mSize;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
