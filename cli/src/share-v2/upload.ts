import { SHARE_PROTOCOL } from '@quire/protocol';
import { QuireApiError, type QuireApi } from '../api.js';
import { chunkMessages } from '../chunk.js';
import type { ShapedMessage, ShapedSession } from '../harness/types.js';
import { buildShareUrl, contentKeyToBase64url, generateContentKey, generateUploadRequestId } from './key.js';

export interface PublishV2Options {
  preset: string;
  password?: string;
  expiresAt?: string;
  /** Base URL the share URL is built from (the key fragment is appended locally). */
  baseUrl: string;
  /** Test hook: overrides the greedy packer (same convention as v1's PublishDeps.chunker). */
  chunker?: (messages: ShapedMessage[]) => ShapedMessage[][];
}

export interface PublishV2Result {
  url: string;
  shareId: string;
  messageCount: number;
  bytes: number;
  redactions: Record<string, number>;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

/** Network failures and 5xx are retryable; 4xx (conflict, not found, validation) are not. */
function isRetryable(err: unknown): boolean {
  if (err instanceof QuireApiError) return err.status === 0 || err.status >= 500;
  return err instanceof TypeError; // fetch network failure
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
}

/**
 * Publishes a shaped session as a v2 sealed share:
 * create (chunk 0) -> chunk PUTs (1..N-1, retried by digest) -> finalize.
 * The content key is generated once and held in memory only; the server
 * seals with it and never stores it, and the key fragment is appended to the
 * returned URL locally, so the server never sees the fragment.
 */
export async function publishV2(api: QuireApi, session: ShapedSession, opts: PublishV2Options): Promise<PublishV2Result> {
  const key = generateContentKey();
  const contentKey = contentKeyToBase64url(key);
  const uploadRequestId = generateUploadRequestId();
  const chunker = opts.chunker ?? chunkMessages;
  const chunks = chunker(session.messages);
  const sourceChunkCount = chunks.length;

  const created = await api.createV2Share({
    protocol: SHARE_PROTOCOL,
    uploadRequestId,
    preset: opts.preset,
    ...(opts.password !== undefined ? { password: opts.password } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    sourceChunkCount,
    contentKey,
    // The CLI does not modify the shaped message shape: chunk 0 goes out as-is,
    // and the server assigns each message its global seq from the running count.
    session: { ...session, messages: chunks[0]! },
  });
  const { shareId, uploadToken } = created;

  for (let seq = 1; seq < sourceChunkCount; seq++) {
    // Built once per chunk and reused on retry: the server digests the raw
    // request bytes, so a stable body is what makes the retry idempotent.
    const body = { protocol: SHARE_PROTOCOL, contentKey, messages: chunks[seq] };
    await withRetries(() => api.uploadV2Chunk(shareId, seq, body, uploadToken));
  }

  const finalized = await api.finalizeV2Share(shareId, { protocol: SHARE_PROTOCOL, contentKey }, uploadToken);
  if (finalized.shareId !== shareId || finalized.publicPath !== `/chats/${shareId}`) {
    throw new Error(
      `server finalized a different share (got shareId=${finalized.shareId} publicPath=${finalized.publicPath}, expected shareId=${shareId})`,
    );
  }
  return {
    url: buildShareUrl(opts.baseUrl, shareId, key),
    shareId,
    messageCount: finalized.messageCount,
    bytes: finalized.bytes,
    redactions: finalized.redactions,
  };
}
