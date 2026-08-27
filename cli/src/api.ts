import { loadCliConfig } from './config.js';

export class QuireApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PreviewResponse {
  messages: unknown[];
  summary: Record<string, number>;
  bytes: number;
  messageCount: number;
}

export interface CreateResponse {
  token: string;
  url: string;
  uploadId: string;
  chunkCount: number;
  summary: Record<string, number>;
  bytes: number;
  messageCount: number;
}

export interface ShareMeta {
  token: string;
  title: string;
  createdAt: string;
  expiresAt: string | null;
  hasPassword: boolean;
  revoked: boolean;
  messageCount: number;
  preset: string;
}

export class QuireApi {
  readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: { serverUrl: string; apiKey: string } = loadCliConfig()) {
    this.baseUrl = config.serverUrl;
    this.apiKey = config.apiKey;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON error body: fall through with a generic message
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new QuireApiError(res.status, err?.code ?? 'http', err?.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }

  preview(session: unknown, preset: string): Promise<PreviewResponse> {
    return this.request('POST', '/api/chats/preview', { session, preset });
  }

  create(
    session: unknown,
    opts: { preset?: string; password?: string; expiresAt?: string } = {},
  ): Promise<CreateResponse> {
    return this.request('POST', '/api/chats', { session, ...opts });
  }

  createChunk(
    token: string,
    body: { uploadId: string; chunkSeq: number; messages: unknown[] },
  ): Promise<{ ok: boolean; messageCount: number; bytes: number }> {
    return this.request('POST', `/api/chats/${token}/chunks`, body);
  }

  list(): Promise<{ shares: ShareMeta[] }> {
    return this.request('GET', '/api/chats');
  }

  get(token: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/chats/${token}`);
  }

  patch(token: string, body: { password?: string | null; expiresAt?: string | null; revoke?: boolean }): Promise<{ ok: boolean }> {
    return this.request('PATCH', `/api/chats/${token}`, body);
  }

  revoke(token: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/api/chats/${token}`);
  }
}
