import { ShareError, type PageResponse } from './api';
import { createV2DataSource } from './share-v2/data-source';
import { parseContentKeyFragment } from './share-v2/crypto';

/**
 * The data source behind useMessages. A URL whose fragment carries a 32-byte
 * content key is a sealed v2 share (blobs are fetched and decrypted in the
 * browser); anything else gets a local error source — the missing-key page —
 * with zero network calls.
 */
export interface ShareDataSource {
  loadFirst(): Promise<PageResponse | ShareError>;
  loadNext(cursor: string): Promise<PageResponse | ShareError>;
  unlock(password: string): Promise<void>;
}

/**
 * Select a sealed-share reader or a network-free missing-key error source.
 *
 * @param shareId - Public share identifier from the URL path.
 * @param fragment - Content-key fragment without its leading hash.
 * @returns Reader using the decoded key, or an error source for incomplete links.
 */
export function createDataSource(shareId: string, fragment: string): ShareDataSource {
  const key = parseContentKeyFragment(fragment);
  if (key) return createV2DataSource(shareId, key);
  const err = new ShareError(0, 'error', 'This link is missing its content key. Ask the owner for the full share URL, including the part after the #.');
  return {
    /**
     * Report the missing content key without making a request.
     *
     * @returns Error explaining how to obtain the complete link.
     */
    loadFirst: async () => err,
    /**
     * Reject pagination for a link that has no usable content key.
     *
     * @returns The same missing-key error as the initial load.
     */
    loadNext: async () => err,
    /** Reject unlocking because a password cannot replace the missing content key. */
    unlock: async () => { throw err; },
  };
}
