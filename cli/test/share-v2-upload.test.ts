import { describe, it, expect, vi, afterEach } from 'vitest';
import { SHARE_PROTOCOL } from '@quire/protocol';
import { QuireApiError, type V2ChunkResponse, type V2CreateResponse, type V2FinalizeResponse } from '../src/api.js';
import {
  buildShareUrl,
  contentKeyToBase64url,
  generateContentKey,
  generateUploadRequestId,
} from '../src/share-v2/key.js';
import { publishV2 } from '../src/share-v2/upload.js';
import type { ShapedMessage, ShapedSession } from '../src/harness/types.js';

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function msg(i: number): ShapedMessage {
  return { role: i % 2 === 0 ? 'user' : 'assistant', parts: [{ type: 'text', text: `message ${i}` }] };
}

function makeSession(n: number): ShapedSession {
  return { sessionId: 's-1', title: 'demo', messages: Array.from({ length: n }, (_, i) => msg(i)) };
}

// Same convention as the v1 publish tests: inject a chunker that forces the
// chunked path without a 19 MB fixture.
const threeWayChunker = (messages: ShapedMessage[]): ShapedMessage[][] =>
  [messages.slice(0, 2), messages.slice(2, 4), messages.slice(4, 6)];

function makeApi() {
  const calls: string[] = [];
  const create = vi.fn(async (body: unknown): Promise<V2CreateResponse> => {
    calls.push('create');
    return {
      shareId: 'pub-1',
      uploadToken: 'tok-1',
      acceptedSourceChunk: 0,
      redactions: { 'aws-access-key': 1 },
      messageCount: 2,
      bytes: 100,
    };
  });
  const chunk = vi.fn(async (shareId: string, seq: number, _body: unknown, _token: string): Promise<V2ChunkResponse> => {
    calls.push(`chunk:${seq}`);
    return { acceptedSourceChunk: seq, redactions: { 'generic-secret': 1 }, messageCount: 2 + seq * 2, bytes: 100 + seq * 50 };
  });
  const finalize = vi.fn(async (shareId: string, _body: unknown, _token: string): Promise<V2FinalizeResponse> => {
    calls.push('finalize');
    return { shareId, publicPath: `/chats/${shareId}`, messageCount: 6, pageCount: 2, bytes: 300, redactions: { 'aws-access-key': 1, 'generic-secret': 2 } };
  });
  return {
    api: { createV2Share: create, uploadV2Chunk: chunk, finalizeV2Share: finalize } as never,
    calls,
    create,
    chunk,
    finalize,
  };
}

describe('share-v2 key', () => {
  it('generateContentKey returns 32 random bytes', () => {
    const a = generateContentKey();
    const b = generateContentKey();
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.byteLength).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('contentKeyToBase64url encodes 32 bytes as 43 unpadded base64url chars', () => {
    const key = generateContentKey();
    const enc = contentKeyToBase64url(key);
    expect(enc).toMatch(KEY_RE);
    expect(Buffer.from(enc, 'base64url')).toEqual(Buffer.from(key));
  });

  it('generateUploadRequestId returns a UUID', () => {
    expect(generateUploadRequestId()).toMatch(UUID_RE);
  });

  it('buildShareUrl appends the key as a URL fragment', () => {
    const key = generateContentKey();
    expect(buildShareUrl('https://srv.example.com', 'pub-1', key)).toBe(
      `https://srv.example.com/chats/pub-1#${contentKeyToBase64url(key)}`,
    );
  });
});

describe('publishV2', () => {
  afterEach(() => vi.restoreAllMocks());

  it('issues create + 2 chunk PUTs + finalize in order for a 3-chunk session', async () => {
    const { api, calls, create, chunk, finalize } = makeApi();
    const result = await publishV2(api, makeSession(6), {
      preset: 'strict',
      password: 'pw',
      expiresAt: '2026-10-01T00:00:00Z',
      baseUrl: 'https://srv.example.com',
      chunker: threeWayChunker,
    });
    expect(calls).toEqual(['create', 'chunk:1', 'chunk:2', 'finalize']);

    const createBody = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(createBody.protocol).toBe(SHARE_PROTOCOL);
    expect(createBody.uploadRequestId).toMatch(UUID_RE);
    expect(createBody.preset).toBe('strict');
    expect(createBody.password).toBe('pw');
    expect(createBody.expiresAt).toBe('2026-10-01T00:00:00Z');
    expect(createBody.sourceChunkCount).toBe(3);
    expect(createBody.contentKey).toMatch(KEY_RE);
    // The CLI does not modify the shaped message shape: chunk 0 is sent as-is.
    expect(createBody.session).toEqual({ sessionId: 's-1', title: 'demo', messages: [msg(0), msg(1)] });

    const [cs, cseq, cbody, ctok] = chunk.mock.calls[0] as [string, number, unknown, string];
    expect([cs, cseq, ctok]).toEqual(['pub-1', 1, 'tok-1']);
    expect(cbody).toEqual({ protocol: SHARE_PROTOCOL, contentKey: createBody.contentKey, messages: [msg(2), msg(3)] });
    const [cs2, cseq2, cbody2, ctok2] = chunk.mock.calls[1] as [string, number, unknown, string];
    expect([cs2, cseq2, ctok2]).toEqual(['pub-1', 2, 'tok-1']);
    expect(cbody2).toEqual({ protocol: SHARE_PROTOCOL, contentKey: createBody.contentKey, messages: [msg(4), msg(5)] });

    expect(finalize.mock.calls[0]).toEqual([
      'pub-1',
      { protocol: SHARE_PROTOCOL, contentKey: createBody.contentKey },
      'tok-1',
    ]);

    expect(result).toEqual({
      url: `https://srv.example.com/chats/pub-1#${createBody.contentKey}`,
      shareId: 'pub-1',
      messageCount: 6,
      bytes: 300,
      redactions: { 'aws-access-key': 1, 'generic-secret': 2 },
    });
  });

  it('omits password and expiresAt from the create body when unset', async () => {
    const { api, create } = makeApi();
    await publishV2(api, makeSession(2), { preset: 'normal', baseUrl: 'https://srv.example.com', chunker: (m) => [m] });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.preset).toBe('normal');
    expect(body.sourceChunkCount).toBe(1);
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('expiresAt');
  });

  it('retries a failed chunk with the same body', async () => {
    const { api, calls, chunk } = makeApi();
    let attempts = 0;
    chunk.mockImplementation(async (shareId: string, seq: number, _body: unknown, _token: string) => {
      attempts += 1;
      calls.push(`chunk:${seq}`);
      if (attempts === 1) throw new QuireApiError(503, 'http', 'server unavailable');
      return { acceptedSourceChunk: seq, redactions: {}, messageCount: 2, bytes: 100 };
    });
    const result = await publishV2(api, makeSession(6), {
      preset: 'strict',
      baseUrl: 'https://srv.example.com',
      chunker: threeWayChunker,
    });
    expect(calls).toEqual(['create', 'chunk:1', 'chunk:1', 'chunk:2', 'finalize']);
    // Same body object on the retry -> identical serialized bytes -> the
    // server's byte-exact digest is stable, so the retry is idempotent.
    expect(chunk.mock.calls[1]![2]).toBe(chunk.mock.calls[0]![2]);
    expect(result.shareId).toBe('pub-1');
  });

  it('does not retry a 4xx chunk failure', async () => {
    const { api, chunk } = makeApi();
    chunk.mockImplementation(async () => {
      throw new QuireApiError(409, 'upload_conflict', 'conflict');
    });
    await expect(
      publishV2(api, makeSession(6), { preset: 'strict', baseUrl: 'https://srv.example.com', chunker: threeWayChunker }),
    ).rejects.toMatchObject({ status: 409, code: 'upload_conflict' });
    expect(chunk).toHaveBeenCalledTimes(1);
  });

  it('returns a URL ending with #<base64url(key)>', async () => {
    const { api, create } = makeApi();
    const result = await publishV2(api, makeSession(6), {
      preset: 'strict',
      baseUrl: 'https://srv.example.com',
      chunker: threeWayChunker,
    });
    const contentKey = (create.mock.calls[0]![0] as Record<string, unknown>).contentKey as string;
    expect(result.url).toBe(`https://srv.example.com/chats/pub-1#${contentKey}`);
    expect(result.url).toMatch(/#[A-Za-z0-9_-]{43}$/);
  });

  it('never passes the content key to a logging call', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const { api, create } = makeApi();
    await publishV2(api, makeSession(6), {
      preset: 'strict',
      baseUrl: 'https://srv.example.com',
      chunker: threeWayChunker,
    });
    const contentKey = (create.mock.calls[0]![0] as Record<string, unknown>).contentKey as string;
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(contentKey);
      }
    }
  });

  it('rejects when the finalize response names a different share', async () => {
    const { api, finalize } = makeApi();
    finalize.mockImplementation(async () => ({
      shareId: 'other',
      publicPath: '/chats/other',
      messageCount: 6,
      pageCount: 2,
      bytes: 300,
      redactions: {},
    }));
    await expect(
      publishV2(api, makeSession(2), { preset: 'strict', baseUrl: 'https://srv.example.com', chunker: (m) => [m] }),
    ).rejects.toThrow(/different share/);
  });
});
