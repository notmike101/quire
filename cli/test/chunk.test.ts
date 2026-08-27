import { describe, it, expect } from 'vitest';
import { chunkMessages, CHUNK_TARGET_BYTES } from '../src/chunk.js';
import type { ShapedMessage } from '../src/harness/types.js';

function msg(text: string): ShapedMessage {
  return { role: 'user', parts: [{ type: 'text', text }] };
}

describe('chunkMessages', () => {
  it('returns [] for empty input', () => {
    expect(chunkMessages([])).toEqual([]);
  });

  it('keeps a small session in one chunk', () => {
    const chunks = chunkMessages([msg('a'), msg('b')], 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it('packs greedily to <= maxBytes and preserves order', () => {
    // Each message serializes to ~120 bytes; with maxBytes=500 we expect ~4 per chunk.
    const messages = Array.from({ length: 10 }, (_, i) => msg(`message number ${i} padding padding padding`));
    const chunks = chunkMessages(messages, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(JSON.stringify(c).length).toBeLessThanOrEqual(500);
    }
    // order preserved across chunks
    const flat = chunks.flat();
    expect(flat).toHaveLength(10);
    expect(flat[0]!.parts[0]!.text).toBe(messages[0]!.parts[0]!.text);
    expect(flat[9]!.parts[0]!.text).toBe(messages[9]!.parts[0]!.text);
  });

  it('a single message over maxBytes gets its own chunk', () => {
    const big = [msg('x'.repeat(1000))];
    const chunks = chunkMessages(big, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });

  it('CHUNK_TARGET_BYTES is under the 20 MB cap', () => {
    expect(CHUNK_TARGET_BYTES).toBeLessThan(20 * 1024 * 1024);
    expect(CHUNK_TARGET_BYTES).toBeGreaterThan(18 * 1024 * 1024);
  });
});
