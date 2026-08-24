import { randomBytes } from 'node:crypto';

/** 128-bit crypto-random token, base64url (22 chars). The only identifier in a share URL. */
export function generateShareToken(): string {
  return randomBytes(16).toString('base64url');
}
