// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { openShareBlob, parseContentKeyFragment } from '../src/share-v2/crypto';
import { MAX_DECOMPRESSED_BLOB_BYTES, blobAad, layoutBlob } from '@quire/protocol';

const SHARE_ID = 'share-abc123';
// Test key 0x00..0x1f — fixed, not a secret; pairs with the committed vector below.
const KEY = new Uint8Array(32).map((_, i) => i);
const WRONG_KEY = new Uint8Array(KEY);
WRONG_KEY[0]! ^= 0xff;
const PAGE = {
  protocol: 'quire-share-v1',
  shareId: SHARE_ID,
  seq: 1,
  messages: [
    { chunkSeq: 0, seq: 1, role: 'user', time: null, parts: [{ type: 'text', text: 'hello world' }] },
    {
      chunkSeq: 0,
      seq: 2,
      role: 'assistant',
      time: '2026-09-01T00:00:00Z',
      parts: [{ type: 'tool', callID: 'c1', tool: 'bash', status: 'done', input: { command: 'ls' }, output: 'ok' }],
    },
  ],
};
// Committed vector: output of the server's sealBlob(KEY, SHARE_ID, 'page', 1, PAGE) (server/src/share-v2/crypto.ts).
const VECTOR =
  '5153485201b8972387f5550f59912bde5df0d38f35e4cf344baa090f1291fbcb73a721c37c7cff7d7bdec4ab1fd925a512c15e0b6f6cc87569faacd9121186d10921d7f1e8c7922f4ff47a37fc3c98247f0f15fcab2001b45e9762608ec394f072615abd685712b1f8a302258707fcce5021f2ef6f47876b09c282768589235d7e9a5da292b679a8d829642edd32956cdd52b14bedd4ae694af4c6705e96ffd5cfed287ae8a7705f267ece4bf246da6d4366a62599d4eb69ce4c49c095df80ffba4dc5d85ca10bdb62d0879937f7b0f3c3db133d0d3514396fe9c9e63e83b470e6e9ae4bfbd83f1dee0fa374c85dbe26ea011d80252cf7063a7bec39194f2ab4f07a6530a514093732';
const VECTOR_BYTES = Buffer.from(VECTOR, 'hex');

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function base64url(raw: Buffer): string {
  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('openShareBlob', () => {
  it('round-trips a page sealed by the server sealBlob', async () => {
    await expect(openShareBlob(KEY, toArrayBuffer(VECTOR_BYTES), SHARE_ID, 'page', 1)).resolves.toEqual(PAGE);
  });

  it('rejects a wrong key', async () => {
    await expect(openShareBlob(WRONG_KEY, toArrayBuffer(VECTOR_BYTES), SHARE_ID, 'page', 1)).rejects.toThrow();
  });

  it('rejects a wrong shareId (AAD mismatch)', async () => {
    await expect(openShareBlob(KEY, toArrayBuffer(VECTOR_BYTES), 'other-share', 'page', 1)).rejects.toThrow();
  });

  it('rejects a wrong kind or seq (AAD mismatch)', async () => {
    await expect(openShareBlob(KEY, toArrayBuffer(VECTOR_BYTES), SHARE_ID, 'index', 1)).rejects.toThrow();
    await expect(openShareBlob(KEY, toArrayBuffer(VECTOR_BYTES), SHARE_ID, 'page', 2)).rejects.toThrow();
  });

  it('rejects a tampered envelope (bad magic)', async () => {
    const tampered = new Uint8Array(VECTOR_BYTES);
    tampered[0] = 0xff;
    await expect(openShareBlob(KEY, toArrayBuffer(tampered), SHARE_ID, 'page', 1)).rejects.toThrow();
  });

  it('rejects an oversize decompressed blob', async () => {
    const key = randomBytes(32);
    const value = { text: 'x'.repeat(MAX_DECOMPRESSED_BLOB_BYTES + 1) };
    const plain = gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
    const nonce = randomBytes(12);
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: new Uint8Array(nonce), additionalData: new Uint8Array(blobAad(SHARE_ID, 'page', 0)) },
        await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'AES-GCM' }, false, ['encrypt']),
        new Uint8Array(plain),
      ),
    );
    const bytes = layoutBlob(nonce, cipher);
    await expect(openShareBlob(key, toArrayBuffer(bytes), SHARE_ID, 'page', 0)).rejects.toThrow('decompressed blob too large');
  });
});

describe('parseContentKeyFragment', () => {
  it('accepts a valid 43-char base64url fragment and returns the 32 raw bytes', () => {
    const raw = randomBytes(32);
    const fragment = base64url(raw);
    expect(fragment).toHaveLength(43);
    expect(parseContentKeyFragment(fragment)).toEqual(new Uint8Array(raw));
  });

  it('rejects wrong lengths', () => {
    const fragment = base64url(randomBytes(32));
    expect(parseContentKeyFragment(fragment.slice(0, 42))).toBeNull();
    expect(parseContentKeyFragment(fragment + 'a')).toBeNull();
  });

  it('rejects non-base64url characters', () => {
    const fragment = base64url(randomBytes(32));
    expect(parseContentKeyFragment('+' + fragment.slice(1))).toBeNull();
    expect(parseContentKeyFragment('=' + fragment.slice(1))).toBeNull();
    expect(parseContentKeyFragment('/' + fragment.slice(1))).toBeNull();
  });
});
