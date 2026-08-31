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

  /**
   * Round 9 (C-F6): the origin (scheme + host + port) of the configured
   * server — no userinfo, no path. User-facing URLs are built from this so a
   * `https://user:pass@host/` base URL never leaks credentials into printed
   * output.
   */
  get origin(): string {
    try {
      return new URL(this.baseUrl).origin;
    } catch {
      return this.baseUrl;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      // Round 9 (C-F6b): Node's fetch() throws "Request cannot be constructed
      // from a URL that includes credentials" for a baseUrl like
      // http://user:pass@host — a pattern that is valid in curl/browsers.
      // Quire authenticates with the Bearer API key, so userinfo is not an
      // auth mechanism here: strip it so such a base URL degrades to a plain
      // request instead of crashing with a raw TypeError.
      const u = new URL(`${this.baseUrl}${path}`);
      u.username = '';
      u.password = '';
      res = await fetch(u, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Round 9 (C-F1): never follow a server redirect. With 'manual' a 3xx
        // comes back unfollowed (res.ok false) and is refused below — a
        // followed redirect could point the bearer key at an attacker host.
        redirect: 'manual',
        // Round 9 (C-F8): bound the request; an unresponsive server must not
        // hang the CLI (an agent would block on it indefinitely).
        signal: AbortSignal.timeout(300_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new QuireApiError(0, 'timeout', 'request timed out after 5 minutes');
      }
      // Round 9 (C-F6b): a misconfigured server URL must produce an actionable
      // error, not a raw TypeError from URL/fetch internals.
      // Round 10 (R10-CLI-1): echo `this.origin`, not `this.baseUrl` — a base
      // URL like `https://user:pass@host ` (trailing space) passes `new URL()`
      // in loadCliConfig but makes the `${baseUrl}${path}` concat below throw
      // "Invalid URL", and printing the raw baseUrl would leak the userinfo
      // (credentials) into stderr, which the harness may capture into its own
      // session log. `origin` strips userinfo (and degrades to baseUrl if the
      // URL is unparseable, i.e. has no userinfo to leak).
      if (err instanceof TypeError && err.message.includes('Invalid URL')) {
        throw new QuireApiError(0, 'invalid_url', `invalid server URL: ${this.origin}`);
      }
      throw err;
    }
    // Round 9 (C-F1): a redirect response is a failure, not a navigation.
    if (res.status >= 300 && res.status < 400) {
      throw new QuireApiError(
        res.status,
        'redirect',
        `server redirected to ${res.headers.get('location') ?? 'an unknown location'}; refusing to follow`,
      );
    }
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
    opts: { preset?: string; password?: string; expiresAt?: string; expectedChunks?: number } = {},
  ): Promise<CreateResponse> {
    return this.request('POST', '/api/chats', { session, ...opts });
  }

  createChunk(
    token: string,
    body: { uploadId: string; chunkSeq: number; messages: unknown[] },
  ): Promise<{ ok: boolean; messageCount: number; bytes: number; summary: Record<string, number> }> {
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
