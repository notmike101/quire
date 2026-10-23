import { SHARE_PROTOCOL, type BlobKind } from './model.js';
export const ENVELOPE_MAGIC = new Uint8Array([0x51, 0x53, 0x48, 0x52]); // "QSHR"
export const ENVELOPE_VERSION = 1;
export const NONCE_BYTES = 12;
const enc = new TextEncoder();
/**
 * Encode authenticated metadata binding a blob to its share, kind, and sequence.
 *
 * @param shareId - Identifier of the share that owns the encrypted blob.
 * @param kind - Protocol blob category.
 * @param seq - Sequence number within that category.
 * @returns UTF-8 additional authenticated data for encryption or decryption.
 */
export function blobAad(shareId: string, kind: BlobKind, seq: number): Uint8Array {
  return enc.encode(`${SHARE_PROTOCOL}\u0000${shareId}\u0000${kind}\u0000${seq}`);
}
/**
 * Pack a nonce and authenticated ciphertext into the versioned storage envelope.
 *
 * @param nonce - Encryption nonce, expected to contain NONCE_BYTES bytes.
 * @param ciphertext - Encrypted payload including its authentication tag.
 * @returns Bytes laid out as magic, version, nonce, and ciphertext with tag.
 */
export function layoutBlob(nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + 1 + nonce.length + ciphertext.length);
  out.set(ENVELOPE_MAGIC, 0);
  out[4] = ENVELOPE_VERSION;
  out.set(nonce, 5);
  out.set(ciphertext, 5 + nonce.length);
  return out;
}
/**
 * Validate an envelope header and extract its nonce and authenticated ciphertext.
 *
 * @param blob - Stored envelope bytes to decode.
 * @returns Copies of the nonce and ciphertext, including the authentication tag.
 * @throws {Error} If the envelope is too short or has unsupported magic or version.
 */
export function parseBlob(blob: Uint8Array): { nonce: Uint8Array; ciphertext: Uint8Array } {
  if (blob.length < 4 + 1 + NONCE_BYTES + 16) throw new Error('blob too short');
  for (let i = 0; i < 4; i++) if (blob[i] !== ENVELOPE_MAGIC[i]) throw new Error('bad magic');
  if (blob[4] !== ENVELOPE_VERSION) throw new Error('bad version');
  return { nonce: blob.slice(5, 5 + NONCE_BYTES), ciphertext: blob.slice(5 + NONCE_BYTES) };
}
