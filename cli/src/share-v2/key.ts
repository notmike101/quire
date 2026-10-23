import { randomUUID, webcrypto } from 'node:crypto';

/**
 * AES-256-GCM content key: 32 random bytes. Generated once per share and held
 * in memory only — never logged, never written to disk. Only its base64url
 * form travels in the request body (the server seals with it, never stores it).
 *
 * @returns Fresh 32-byte content key.
 */
export function generateContentKey(): Uint8Array {
  const key = new Uint8Array(32);
  webcrypto.getRandomValues(key);
  return key;
}

/**
 * Encode a content key in the unpadded base64url wire format.
 *
 * @param key - Raw content-key bytes.
 * @returns Base64url key, 43 characters for a 32-byte key.
 */
export function contentKeyToBase64url(key: Uint8Array): string {
  return Buffer.from(key).toString('base64url');
}

/**
 * Generate an identifier for server-side upload idempotency.
 *
 * @returns Fresh random UUID.
 */
export function generateUploadRequestId(): string {
  return randomUUID();
}

/**
 * Build the public share URL with the content key in a local URL fragment.
 * Browsers do not send this fragment when fetching the share.
 *
 * @param baseUrl - Public server origin.
 * @param publicId - Finalized share identifier.
 * @param key - Content key required to decrypt the share.
 * @returns Share URL containing the encoded key fragment.
 */
export function buildShareUrl(baseUrl: string, publicId: string, key: Uint8Array): string {
  return `${baseUrl}/chats/${publicId}#${contentKeyToBase64url(key)}`;
}
