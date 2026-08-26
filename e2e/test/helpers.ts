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
