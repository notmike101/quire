import { parseShareIndexSegment, parseShareManifest, parseSharePage, type BlobKind, type ShareManifestV1 } from '@quire/protocol';
import { ShareError, type PageResponse, type ShareMeta } from '../api';
import type { ShareDataSource } from '../share-data-source';
import { openShareBlob } from './crypto';

// Decrypt/parse failures (corrupt blob, wrong key) surface as this generic
// error — never the underlying crypto/parser message, which could echo
// content or key material.
const GENERIC_ERROR = 'Something went wrong loading this share.';

function toError(err: unknown): ShareError {
  return err instanceof ShareError ? err : new ShareError(0, 'http', GENERIC_ERROR);
}

// Mirrors v1's api.ts error mapping: the server's error code wins; a
// non-JSON body falls back to the status so the composable's state machine
// (needs_password / expired / not_found) still works.
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
export function createV2DataSource(shareId: string, key: Uint8Array): ShareDataSource {
  let meta: ShareMeta | null = null;
  let pageCount = 0;

  const base = `/api/v2/public/shares/${shareId}`;

  async function fetchBlob(kind: BlobKind, seq: number): Promise<unknown> {
    const res = await fetch(`${base}/blobs/${kind}/${seq}`);
    if (!res.ok) throw await httpError(res);
    return openShareBlob(key, await res.arrayBuffer(), shareId, kind, seq);
  }

  return {
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
