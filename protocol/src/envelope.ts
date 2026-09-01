import { SHARE_PROTOCOL, type BlobKind } from './model.js';
export const ENVELOPE_MAGIC = new Uint8Array([0x51, 0x53, 0x48, 0x52]); // "QSHR"
export const ENVELOPE_VERSION = 1;
export const NONCE_BYTES = 12;
const enc = new TextEncoder();
export function blobAad(shareId: string, kind: BlobKind, seq: number): Uint8Array {
  return enc.encode(`${SHARE_PROTOCOL}\u0000${shareId}\u0000${kind}\u0000${seq}`);
}
// stored bytes: [4 magic][1 version][12 nonce][ciphertext+tag]
export function layoutBlob(nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + 1 + nonce.length + ciphertext.length);
  out.set(ENVELOPE_MAGIC, 0);
  out[4] = ENVELOPE_VERSION;
  out.set(nonce, 5);
  out.set(ciphertext, 5 + nonce.length);
  return out;
}
export function parseBlob(blob: Uint8Array): { nonce: Uint8Array; ciphertext: Uint8Array } {
  if (blob.length < 4 + 1 + NONCE_BYTES + 16) throw new Error('blob too short');
  for (let i = 0; i < 4; i++) if (blob[i] !== ENVELOPE_MAGIC[i]) throw new Error('bad magic');
  if (blob[4] !== ENVELOPE_VERSION) throw new Error('bad version');
  return { nonce: blob.slice(5, 5 + NONCE_BYTES), ciphertext: blob.slice(5 + NONCE_BYTES) };
}
