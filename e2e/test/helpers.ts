import { expect, type APIRequestContext } from '@playwright/test';

export const API_KEY = 'e2e-test-key-0000000000000000000000';

/** Matches the server's openai-key rule (\bsk-[A-Za-z0-9]{20,}\b) and no earlier rule. */
export const OPENAI_KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

/** A shaped session that satisfies shapedSessionSchema (strict) byte-for-byte. */
export function smallSession(messageCount: number, opts: { secret?: boolean } = {}): object {
  const messages: object[] = [];
  for (let i = 0; i < messageCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const text =
      i === 0 && opts.secret ? `Use this key: ${OPENAI_KEY} for the API` : `Message ${i + 1}`;
    messages.push({
      role,
      time: new Date(Date.UTC(2026, 0, 1, 12, i)).toISOString(),
      parts: [{ type: 'text', text }],
    });
  }
  return {
    sessionId: 'sess_e2e',
    title: 'E2E Session',
    model: 'test-model',
    provider: 'test-provider',
    messages,
  };
}

export interface CreateShareOptions {
  password?: string;
  expiresAt?: string;
  messageCount?: number;
  secret?: boolean;
}

export async function createShare(
  request: APIRequestContext,
  options: CreateShareOptions = {},
): Promise<{ token: string; url: string; messageCount: number }> {
  const { password, expiresAt, messageCount = 2, secret = false } = options;
  const res = await request.post('/api/chats', {
    headers: { authorization: `Bearer ${API_KEY}` },
    data: {
      session: smallSession(messageCount, { secret }),
      ...(password !== undefined ? { password } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
  });
  expect(res.status()).toBe(201);
  return await res.json();
}

/** A session whose user message is a `system` part (harness-injected reminder). */
export function systemNoticeSession(): object {
  return {
    sessionId: 'sess_system',
    title: 'System Notice Session',
    model: 'test-model',
    messages: [
      {
        role: 'user',
        time: new Date(Date.UTC(2026, 0, 1, 12, 0)).toISOString(),
        parts: [{ type: 'system', text: 'Continue working toward the active session goal.\n\nhidden objective body' }],
      },
      {
        role: 'assistant',
        time: new Date(Date.UTC(2026, 0, 1, 12, 1)).toISOString(),
        parts: [{ type: 'text', text: 'acknowledged' }],
      },
    ],
  };
}

export async function createSystemNoticeShare(request: APIRequestContext): Promise<{ token: string; url: string }> {
  const res = await request.post('/api/chats', {
    headers: { authorization: `Bearer ${API_KEY}` },
    data: { session: systemNoticeSession() },
  });
  expect(res.status()).toBe(201);
  return await res.json();
}

/** A session whose assistant message has a `reasoning` part (think block). */
export function reasoningSession(): object {
  return {
    sessionId: 'sess_reasoning',
    title: 'Reasoning Session',
    model: 'test-model',
    messages: [
      {
        role: 'user',
        time: new Date(Date.UTC(2026, 0, 1, 12, 0)).toISOString(),
        parts: [{ type: 'text', text: 'what is 2+2?' }],
      },
      {
        role: 'assistant',
        time: new Date(Date.UTC(2026, 0, 1, 12, 1)).toISOString(),
        parts: [
          { type: 'reasoning', text: 'let me think about this carefully step by step' },
          { type: 'text', text: 'The answer is 4.' },
        ],
      },
    ],
  };
}

export async function createReasoningShare(request: APIRequestContext): Promise<{ token: string; url: string }> {
  const res = await request.post('/api/chats', {
    headers: { authorization: `Bearer ${API_KEY}` },
    data: { session: reasoningSession() },
  });
  expect(res.status()).toBe(201);
  return await res.json();
}

/** A tiny 1×1 red-pixel PNG as a data URI (small enough to embed in a share). */
export const TINY_PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A session whose assistant message has an `image` part (embedded data URI). */
export function imageSession(): object {
  return {
    sessionId: 'sess_image',
    title: 'Image Session',
    model: 'test-model',
    messages: [
      {
        role: 'user',
        time: new Date(Date.UTC(2026, 0, 1, 12, 0)).toISOString(),
        parts: [{ type: 'text', text: 'show me the screenshot' }],
      },
      {
        role: 'assistant',
        time: new Date(Date.UTC(2026, 0, 1, 12, 1)).toISOString(),
        parts: [
          { type: 'text', text: 'Here it is.' },
          {
            type: 'image',
            src: TINY_PNG_DATA_URI,
            mime: 'image/png',
            alt: 'screenshot',
            bytes: 70,
          },
        ],
      },
    ],
  };
}

export async function createImageShare(request: APIRequestContext): Promise<{ token: string; url: string }> {
  const res = await request.post('/api/chats', {
    headers: { authorization: `Bearer ${API_KEY}` },
    data: { session: imageSession() },
  });
  expect(res.status()).toBe(201);
  return await res.json();
}

export async function createChunkedShare(
  request: APIRequestContext,
  opts: { perChunk?: number } = {},
): Promise<{ token: string; uploadId: string }> {
  const perChunk = opts.perChunk ?? 3;
  const mkChunk = (chunkSeq: number): object => {
    const messages: object[] = [];
    for (let i = 0; i < perChunk; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        time: new Date(Date.UTC(2026, 0, 1, 12, i)).toISOString(),
        parts: [{ type: 'text', text: `chunk${chunkSeq} message ${i + 1}` }],
      });
    }
    return messages;
  };
  const first = await request.post('/api/chats', {
    headers: { authorization: `Bearer ${API_KEY}` },
    data: { session: { sessionId: 'sess_chunked', title: 'Chunked E2E', model: 'test-model', messages: mkChunk(0) }, preset: 'strict' },
  });
  expect(first.status()).toBe(201);
  const firstBody = await first.json();
  const second = await request.post(`/api/chats/${firstBody.token}/chunks`, {
    headers: { authorization: `Bearer ${API_KEY}` },
    data: { uploadId: firstBody.uploadId, chunkSeq: 1, messages: mkChunk(1) },
  });
  expect(second.status()).toBe(200);
  return { token: firstBody.token, uploadId: firstBody.uploadId };
}
