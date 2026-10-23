import { parseShareIndexSegment, parseShareManifest, parseSharePage, type BlobKind, type ShareManifestV1 } from '@quire/protocol';
import { ShareError, type PageResponse, type ShareMeta } from '../api';
import type { ShareDataSource } from '../share-data-source';
import { openShareBlob } from './crypto';

// Decrypt/parse failures (corrupt blob, wrong key) surface as this generic
// error — never the underlying crypto/parser message, which could echo
// content or key material.
const GENERIC_ERROR = 'Something went wrong loading this share.';

/**
 * Preserve API errors while hiding details from crypto and parser failures.
 *
 * @param err - Failure raised while loading a sealed share.
 * @returns Viewer-safe share error.
 */
function toError(err: unknown): ShareError {
  return err instanceof ShareError ? err : new ShareError(0, 'http', GENERIC_ERROR);
}

// The server's error code wins; a non-JSON body falls back to the status so
// the composable's state machine (needs_password / expired / not_found)
// still works.
/**
 * Decode a server error, falling back to HTTP status for non-JSON responses.
 *
 * @param res - Unsuccessful fetch response.
 * @returns Error with a code suitable for the viewer's access states.
 */
async function httpError(res: Response): Promise<ShareError> {
  let code = 'http';
  let message = `HTTP ${res.status}`;
  try {
    const json = (await res.json()) as { error?: { code?: string; message?: string } };
    if (json?.error?.code) code = json.error.code;
    if (json?.error?.message) message = json.error.message;
  } catch {
    // non-JSON error body — use the status fallback below
  }
  if (code === 'http') {
    if (res.status === 404) code = 'not_found';
    else if (res.status === 410) code = 'expired';
    else if (res.status === 401) code = 'needs_password';
  }
  return new ShareError(res.status, code, message);
}

// ShareManifestV1's model/provider are optional; ShareMeta's are nullable.
/**
 * Normalize optional manifest fields to the viewer's nullable metadata shape.
 *
 * @param m - Validated decrypted manifest.
 * @returns Metadata consumed by the transcript header.
 */
function toMeta(m: ShareManifestV1): ShareMeta {
  return {
    title: m.title,
    model: m.model ?? null,
    provider: m.provider ?? null,
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
    messageCount: m.messageCount,
    redactions: m.redactions,
  };
}

// ShareMessageV1/RailUserEntryV1 are structurally identical to the web
// ShareMessage/RailUserEntry shapes, so pages and index entries map 1:1.
/**
 * Create a public share reader that fetches and decrypts sealed blobs locally.
 *
 * @param shareId - Public identifier used in requests and authenticated blob data.
 * @param key - Content key decoded from the URL fragment.
 * @returns Data source for bootstrap, pagination, and password unlock.
 */
export function createV2DataSource(shareId: string, key: Uint8Array): ShareDataSource {
  let meta: ShareMeta | null = null;
  let pageCount = 0;

  const base = `/api/v2/public/shares/${shareId}`;

  /**
   * Fetch and decrypt one blob bound to this share and its sequence.
   *
   * @param kind - Manifest, index, or message-page blob category.
   * @param seq - Sequence number within the category.
   * @returns Decrypted JSON ready for protocol validation.
   */
  async function fetchBlob(kind: BlobKind, seq: number): Promise<unknown> {
    const res = await fetch(`${base}/blobs/${kind}/${seq}`);
    if (!res.ok) throw await httpError(res);
    return openShareBlob(key, await res.arrayBuffer(), shareId, kind, seq);
  }

  return {
    /**
     * Check access and load the manifest, rail index, and first message page.
     *
     * @returns Initial page with metadata and rail entries, or a viewer-safe error.
     */
    async loadFirst(): Promise<PageResponse | ShareError> {
      try {
        const res = await fetch(`${base}/bootstrap`);
        if (!res.ok) return await httpError(res);
        const [manifestBlob, indexBlob, page0Blob] = await Promise.all([
          fetchBlob('manifest', 0),
          fetchBlob('index', 0),
          fetchBlob('page', 0),
        ]);
        const manifest = parseShareManifest(manifestBlob);
        const index = parseShareIndexSegment(indexBlob);
        const page = parseSharePage(page0Blob);
        meta = toMeta(manifest);
        pageCount = manifest.pageCount;
        return {
          meta,
          messages: page.messages,
          userIndex: index.entries,
          nextCursor: manifest.pageCount > 1 ? '1' : null,
        };
      } catch (err) {
        return toError(err);
      }
    },

    /**
     * Fetch a subsequent message page using metadata from the initial load.
     *
     * @param cursor - Decimal page sequence returned by a previous load.
     * @returns Requested page and continuation cursor, or a viewer-safe error.
     */
    async loadNext(cursor: string): Promise<PageResponse | ShareError> {
      try {
        if (!meta) return new ShareError(0, 'http', GENERIC_ERROR);
        const seq = Number(cursor);
        if (!Number.isInteger(seq) || seq < 0) return new ShareError(0, 'http', GENERIC_ERROR);
        const page = parseSharePage(await fetchBlob('page', seq));
        return {
          meta,
          messages: page.messages,
          userIndex: [],
          nextCursor: seq + 1 < pageCount ? String(seq + 1) : null,
        };
      } catch (err) {
        return toError(err);
      }
    },

    /**
     * Request the access cookie needed to read a password-protected share.
     *
     * @param password - Reader-supplied share password.
     */
    async unlock(password: string): Promise<void> {
      const res = await fetch(`${base}/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw await httpError(res);
    },
  };
}
