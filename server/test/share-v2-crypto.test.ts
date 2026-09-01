import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { sealBlob, openBlob } from '../src/share-v2/crypto.js';
import { ENVELOPE_MAGIC, blobAad, parseBlob, type BlobKind } from '@quire/protocol';

const KINDS: BlobKind[] = ['manifest', 'index', 'page'];
const SHARE_ID = 'share-1';

// One realistic value per kind, mirroring the protocol models.
const VALUES: Record<BlobKind, unknown> = {
  manifest: {
    protocol: 'quire-share-v1',
    shareId: SHARE_ID,
    title: 'a session',
    createdAt: '2026-09-01T00:00:00.000Z',
    expiresAt: null,
    messageCount: 3,
    redactions: { cliArg: 1 },
    pageCount: 1,
  },
  index: {
    protocol: 'quire-share-v1',
    shareId: SHARE_ID,
    seq: 0,
    entries: [{ chunkSeq: 0, seq: 1, preview: 'hello world' }],
  },
  page: {
    protocol: 'quire-share-v1',
    shareId: SHARE_ID,
    seq: 0,
    messages: [
      {
        chunkSeq: 0,
        seq: 1,
        role: 'user',
        time: null,
        parts: [{ type: 'text', text: 'hello world' }],
      },
    ],
  },
};

describe('sealBlob / openBlob', () => {
  it('round-trips a value for each kind', async () => {
    const k = randomBytes(32);
    for (const kind of KINDS) {
      const blob = await sealBlob(k, SHARE_ID, kind, 0, VALUES[kind]);
      expect(await openBlob(k, blob, SHARE_ID, kind, 0)).toEqual(VALUES[kind]);
    }
  });

  it('produces a fresh nonce per seal (envelopes differ)', async () => {
    const k = randomBytes(32);
    const a = await sealBlob(k, SHARE_ID, 'page', 0, VALUES.page);
    const b = await sealBlob(k, SHARE_ID, 'page', 0, VALUES.page);
    expect(a).not.toEqual(b);
  });

  it('envelope starts with the QSHR magic', async () => {
    const blob = await sealBlob(randomBytes(32), SHARE_ID, 'page', 0, { a: 1 });
    expect(blob.slice(0, 4)).toEqual(ENVELOPE_MAGIC);
  });

  it('encrypts a gzip-compressed plaintext', async () => {
    const k = randomBytes(32);
    const value = { text: 'x'.repeat(10_000) };
    const blob = await sealBlob(k, SHARE_ID, 'page', 0, value);
    const { nonce, ciphertext } = parseBlob(blob);
    const imported = await globalThis.crypto.subtle.importKey('raw', k, { name: 'AES-GCM' }, false, ['decrypt']);
    const plain = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: blobAad(SHARE_ID, 'page', 0) },
        imported,
        ciphertext,
      ),
    );
    // gzip magic 0x1f 0x8b
    expect(plain[0]).toBe(0x1f);
    expect(plain[1]).toBe(0x8b);
    expect(JSON.parse(gunzipSync(Buffer.from(plain)).toString('utf8'))).toEqual(value);
  });

  it('fails to decrypt with a wrong key', async () => {
    const blob = await sealBlob(randomBytes(32), SHARE_ID, 'page', 0, { a: 1 });
    await expect(openBlob(randomBytes(32), blob, SHARE_ID, 'page', 0)).rejects.toThrow();
  });

  it('fails to decrypt with a wrong shareId (AAD mismatch)', async () => {
    const k = randomBytes(32);
    const blob = await sealBlob(k, SHARE_ID, 'page', 0, { a: 1 });
    await expect(openBlob(k, blob, 'other-share', 'page', 0)).rejects.toThrow();
  });

  it('fails to decrypt with a wrong kind (AAD mismatch)', async () => {
    const k = randomBytes(32);
    const blob = await sealBlob(k, SHARE_ID, 'page', 0, { a: 1 });
    await expect(openBlob(k, blob, SHARE_ID, 'index', 0)).rejects.toThrow();
  });

  it('fails to decrypt with a wrong seq (AAD mismatch)', async () => {
    const k = randomBytes(32);
    const blob = await sealBlob(k, SHARE_ID, 'page', 0, { a: 1 });
    await expect(openBlob(k, blob, SHARE_ID, 'page', 1)).rejects.toThrow();
  });

  it('fails when one ciphertext byte is tampered (GCM tag)', async () => {
    const k = randomBytes(32);
    const blob = await sealBlob(k, SHARE_ID, 'page', 0, { a: 1 });
    const tampered = blob.slice();
    tampered[tampered.length - 1]! ^= 0xff; // flip a byte in the auth tag
    await expect(openBlob(k, tampered, SHARE_ID, 'page', 0)).rejects.toThrow();
  });
});
