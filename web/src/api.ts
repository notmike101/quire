export interface SharePart {
  type: 'text' | 'tool' | 'reasoning';
  text?: string;
  callID?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: string;
}

export interface ShareMessage {
  chunkSeq: number;
  seq: number;
  role: 'user' | 'assistant';
  time: string | null;
  parts: SharePart[];
}

export interface ShareMeta {
  title: string;
  model: string | null;
  provider: string | null;
  createdAt: string;
  expiresAt: string | null;
  messageCount: number;
  redactions: Record<string, number>;
}

export interface PageResponse {
  meta: ShareMeta;
  messages: ShareMessage[];
  nextCursor: string | null;
}

export class ShareError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function shareApi(token: string) {
  const base = `/api/public/chats/${token}`;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, init);
    const text = await res.text();
    let json: { error?: { code?: string; message?: string } } | null = null;
    try {
      json = JSON.parse(text) as { error?: { code?: string; message?: string } };
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw new ShareError(res.status, json?.error?.code ?? 'http', json?.error?.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }

  function page(limit = 50, cursor?: string): Promise<PageResponse> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) params.set('cursor', cursor);
    return request<PageResponse>(`${base}?${params.toString()}`);
  }

  function unlock(password: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`${base}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  }

  return { page, unlock };
}
