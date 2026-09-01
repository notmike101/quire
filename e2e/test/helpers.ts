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

/**
 * A session whose assistant message has a tool part with an attached image
 * (a Read-attachment image). The viewer must render the image inside the tool
 * card's collapsible body, hidden by default and visible on expand.
 */
export function toolImageSession(): object {
  return {
    sessionId: 'sess_tool_image',
    title: 'Tool Image Session',
    model: 'test-model',
    messages: [
      {
        role: 'user',
        time: new Date(Date.UTC(2026, 0, 1, 12, 0)).toISOString(),
        parts: [{ type: 'text', text: 'read the file' }],
      },
      {
        role: 'assistant',
        time: new Date(Date.UTC(2026, 0, 1, 12, 1)).toISOString(),
        parts: [
          { type: 'text', text: 'Here is what the file shows.' },
          {
            type: 'tool',
            tool: 'Read',
            status: 'completed',
            input: { file_path: '/tmp/example.png' },
            output: '[Attached image/png: Read image]',
            images: [{ src: TINY_PNG_DATA_URI, mime: 'image/png', alt: 'Read image', bytes: 70 }],
          },
        ],
      },
    ],
  };
}

export async function createToolImageShare(request: APIRequestContext): Promise<{ token: string; url: string }> {
  const res = await request.post('/api/chats', {
    headers: { authorization: `Bearer ${API_KEY}` },
    data: { session: toolImageSession() },
  });
  expect(res.status()).toBe(201);
  return await res.json();
}

/**
 * A long session with `userTurns` user messages, each followed by an assistant
 * reply of varied length (some short, some with tool chips + code) so the page
 * is genuinely tall. Used to exercise the message rail's viewport anchoring and
 * overflow behavior.
 */
export function longSession(userTurns: number): object {
  const messages: object[] = [];
  for (let i = 0; i < userTurns; i++) {
    messages.push({
      role: 'user',
      time: new Date(Date.UTC(2026, 0, 1, 12, i)).toISOString(),
      parts: [{ type: 'text', text: `User turn number ${i + 1}: please do something specific and detailed about topic ${i}.` }],
    });
    // Vary assistant length: short, medium, or long (with a code block).
    const len = i % 3;
    const parts: object[] = [{ type: 'text', text: `Assistant reply to turn ${i + 1}.` }];
    if (len >= 1) {
      parts.push({ type: 'text', text: 'Here is some context to make this reply longer so the page scrolls.' });
    }
    if (len === 2) {
      parts.push({ type: 'text', text: '```ts\nconst x = ' + i + ';\nconsole.log(x);\n```' });
    }
    messages.push({
      role: 'assistant',
      time: new Date(Date.UTC(2026, 0, 1, 12, i, 30)).toISOString(),
      parts,
    });
  }
  return {
    sessionId: 'sess_long',
    title: 'Long Session',
    model: 'test-model',
    provider: 'test-provider',
    messages,
  };
}

export async function createLongShare(
  request: APIRequestContext,
  userTurns: number,
): Promise<{ token: string; url: string }> {
  const res = await request.post('/api/chats', {
    headers: { authorization: `Bearer ${API_KEY}` },
    data: { session: longSession(userTurns) },
  });
  expect(res.status()).toBe(201);
  return await res.json();
}

// Chain F: one secret per redaction rule. `raw` is the full secret that must
// never reach the DOM; `text` wraps it in prose so the rule fires in context.
// For `connection-string` the scheme+host legitimately survive (only the
// credential is redacted), so the test asserts on `needle` (the credential)
// rather than `raw`.
export const RULE_SECRETS: { label: string; text: string; raw: string; needle?: string }[] = [
  {
    label: 'private-key',
    raw: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxF9zUlKb2fElpXQf7U00mJVKoHq7q\n-----END RSA PRIVATE KEY-----',
    text: 'here: -----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxF9zUlKb2fElpXQf7U00mJVKoHq7q\n-----END RSA PRIVATE KEY-----',
  },
  {
    label: 'jwt',
    raw: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXw',
    text: 'jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXw',
  },
  {
    label: 'aws-access-key',
    raw: 'AKIAIOSFODNN7EXAMPLE',
    text: 'aws: AKIAIOSFODNN7EXAMPLE',
  },
  {
    // Round 2: the 40-char base64 secret access key (the credential half).
    label: 'aws-secret-key',
    raw: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    text: 'aws secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  {
    // Round 2: Google API key (AIza + 33 base64url chars).
    label: 'google-api-key',
    raw: 'AIzaSyA1234567890abcdefghijklmnopqrst',
    text: 'google: AIzaSyA1234567890abcdefghijklmnopqrst',
  },
  {
    // Round 2: Anthropic key (sk-ant- prefix) — was only covered in unit tests.
    label: 'anthropic-key',
    raw: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
    text: 'anthropic: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
  },
  {
    // Round 2: a keyword-less 32-hex token (bare-token's pure-hex branch).
    label: 'bare-token',
    raw: 'c8f5e0a1b2c3d4e5f60718293a4b5c6d',
    text: 'use c8f5e0a1b2c3d4e5f60718293a4b5c6d here',
  },
  {
    label: 'connection-string',
    raw: 'postgres://user:secretpw@db.example.com/app',
    text: 'dsn: postgres://user:secretpw@db.example.com/app',
    needle: 'secretpw',
  },
  {
    label: 'bearer-token',
    raw: 'ghp_LIVESECRET0123456789ABCDEF',
    text: 'auth: Bearer ghp_LIVESECRET0123456789ABCDEF',
  },
  {
    label: 'generic-secret',
    raw: 'abcd1234efgh5678',
    text: 'cfg: api_key=abcd1234efgh5678',
  },
  {
    label: 'private-ip',
    raw: '10.0.0.5',
    text: 'host 10.0.0.5 seen',
  },
  {
    label: 'local-path',
    raw: '/home/user/.ssh/id_rsa',
    text: 'file /home/user/.ssh/id_rsa read',
  },
];

export async function createRuleShare(
  request: APIRequestContext,
  entry: { label: string; text: string },
): Promise<{ token: string }> {
  const res = await request.post('/api/chats', {
    headers: { authorization: `Bearer ${API_KEY}` },
    data: {
      session: {
        sessionId: `sess_rule_${entry.label}`,
        title: `Rule ${entry.label}`,
        model: 'test-model',
        messages: [
          {
            role: 'user',
            time: new Date(Date.UTC(2026, 0, 1, 12, 0)).toISOString(),
            parts: [{ type: 'text', text: entry.text }],
          },
        ],
      },
      preset: 'strict',
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { token: body.token };
}

/**
 * Round 8 (D5): a session whose assistant message carries XSS payloads in a
 * text part — executable-scheme links, a protocol-relative link, a
 * backslash-authority link (four literal backslashes in the markdown source
 * survive markdown-it's destination un-escaping as two), a data: link,
 * /assets/ traversal image srcs, and raw HTML script/img tags. The viewer must
 * render none of them as live elements.
 * Round 9 (D3): adds the scheme-hiding variants the fixture previously omitted —
 * a mixed-case executable scheme (browser schemes are case-insensitive), a
 * percent-encoded colon (the browser does NOT decode %3a to a scheme, so it can
 * only ever resolve as a relative URL), a C0-control-prefixed scheme (markdown-it
 * percent-encodes the control char before the renderer, so the raw form is only
 * reachable via the isSafeHref unit tests), and an svg data image (svg+xml can
 * carry SMIL and is never a screenshot).
 */
export function xssSession(): object {
  const payload = [
    '[xss link](javascript:alert(1))',
    '[xss proto-rel](//evil.example/x)',
    '[xss backslash](\\\\\\\\evil.example/x)',
    '[xss data](data:text/html,<script>alert(1)</script>)',
    '[xss js-case](JaVaScRiPt:alert(1))',
    '[xss js-pct](javascript%3aalert(1))',
    '[xss ctrl](' + String.fromCharCode(1) + 'javascript:alert(1))',
    '![xss img](javascript:alert(1))',
    '![xss traverse](/assets/../../api/chats)',
    '![xss pct](/assets/%2e%2e/secret)',
    '![xss svg](data:image/svg+xml;base64,PHN2Zz4=)',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
  ].join('\n\n');
  return {
    sessionId: 'sess_xss',
    title: 'XSS Session',
    model: 'test-model',
    messages: [
      {
        role: 'user',
        time: new Date(Date.UTC(2026, 0, 1, 12, 0)).toISOString(),
        parts: [{ type: 'text', text: 'render this' }],
      },
      {
        role: 'assistant',
        time: new Date(Date.UTC(2026, 0, 1, 12, 1)).toISOString(),
        parts: [{ type: 'text', text: payload }],
      },
    ],
  };
}

export async function createXssShare(request: APIRequestContext): Promise<{ token: string; url: string }> {
  const res = await request.post('/api/chats', {
    headers: { authorization: `Bearer ${API_KEY}` },
    data: { session: xssSession() },
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
    // Round 7: the server bounds chunkSeq to the share's declared budget
    // (owner.ts: `chunkSeq >= share.expectedChunks` → 400). A two-chunk share
    // must declare expectedChunks: 2, or the chunkSeq: 1 POST below is rejected.
    data: { session: { sessionId: 'sess_chunked', title: 'Chunked E2E', model: 'test-model', messages: mkChunk(0) }, preset: 'strict', expectedChunks: 2 },
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

// ---- v2 (sealed shares) ----

/** The wire protocol string the v2 owner API requires on every body. */
export const V2_PROTOCOL = 'quire-share-v1';

export interface CreateV2ShareOptions {
  password?: string;
  expiresAt?: string;
  messageCount?: number;
  secret?: boolean;
}

/**
 * Publishes a synthetic v2 sealed share directly through the owner v2 API
 * (create with chunk 0 -> finalize) using a freshly generated 32-byte content
 * key that the test keeps. The key is appended to the returned URL only as a
 * fragment — fragments are never transmitted, so the public endpoints never
 * see it.
 */
export async function createV2Share(
  request: APIRequestContext,
  options: CreateV2ShareOptions = {},
): Promise<{ shareId: string; url: string; contentKey: string; messageCount: number }> {
  const { password, expiresAt, messageCount = 2, secret = false } = options;
  const contentKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const created = await request.post('/api/v2/shares', {
    headers: { authorization: `Bearer ${API_KEY}` },
    data: {
      protocol: V2_PROTOCOL,
      uploadRequestId: crypto.randomUUID(),
      preset: 'strict',
      ...(password !== undefined ? { password } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      sourceChunkCount: 1,
      contentKey,
      session: smallSession(messageCount, { secret }),
    },
  });
  expect(created.status()).toBe(201);
  const createBody = await created.json();
  const finalized = await request.post(`/api/v2/shares/${createBody.shareId}/finalize`, {
    headers: { authorization: `Bearer ${API_KEY}`, 'x-upload-token': createBody.uploadToken },
    data: { protocol: V2_PROTOCOL, contentKey },
  });
  expect(finalized.status()).toBe(200);
  const finalBody = await finalized.json();
  return {
    shareId: createBody.shareId,
    url: `/chats/${createBody.shareId}#${contentKey}`,
    contentKey,
    messageCount: finalBody.messageCount,
  };
}
