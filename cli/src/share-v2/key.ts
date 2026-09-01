import { randomUUID, webcrypto } from 'node:crypto';

/**
 * AES-256-GCM content key: 32 random bytes. Generated once per share and held
 * in memory only — never logged, never written to disk. Only its base64url
 * form travels in the request body (the server seals with it, never stores it).
 */
export function generateContentKey(): Uint8Array {
  const key = new Uint8Array(32);
  webcrypto.getRandomValues(key);
  return key;
}

/** base64url without padding (43 chars for 32 bytes) — the wire form the server validates. */
export function contentKeyToBase64url(key: Uint8Array): string {
  return Buffer.from(key).toString('base64url');
}

/** A fresh UUID per upload; the server keys upload idempotency on it. */
export function generateUploadRequestId(): string {
  return randomUUID();
}

/**
 * The user-facing share URL. The content key is appended as a URL fragment
 * locally — fragments are never sent to the server, so the server never sees
 * the key.
 */
export function buildShareUrl(baseUrl: string, publicId: string, key: Uint8Array): string {
  return `${baseUrl}/chats/${publicId}#${contentKeyToBase64url(key)}`;
}
