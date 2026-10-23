import { loadCliConfig } from './config.js';

/** HTTP or protocol failure returned by the configured Quire server. */
export class QuireApiError extends Error {
  /**
   * Preserve the server's status and machine-readable error code.
   *
   * @param status - HTTP status, or zero for a local request failure.
   * @param code - Stable error category.
   * @param message - Human-readable failure detail.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Owner-facing share shape (v2 only): no content key, no upload token. */
export interface ShareMeta {
  id: string;
  publicId: string;
  title: string | null;
  preset: string;
  expiresAt: string | null;
  messageCount: number;
  bytes: number;
  redactions: Record<string, number>;
  createdAt: string;
  state: string;
  format: 'v2';
}

export interface V2CreateResponse {
  shareId: string;
  uploadToken: string;
  acceptedSourceChunk: number;
  redactions: Record<string, number>;
  messageCount: number;
  bytes: number;
}

export interface V2ChunkResponse {
  acceptedSourceChunk: number;
  redactions: Record<string, number>;
  messageCount: number;
  bytes: number;
}

export interface V2FinalizeResponse {
  shareId: string;
  publicPath: string;
  messageCount: number;
  pageCount: number;
  bytes: number;
  redactions: Record<string, number>;
}

/** Authenticated client for uploading sealed shares and managing owned shares. */
export class QuireApi {
  readonly baseUrl: string;
  private readonly apiKey: string;

  /**
   * Configure the server endpoint and bearer credential.
   *
   * @param config - Explicit connection settings, defaulting to CLI configuration.
   * @param config.serverUrl - Base URL of the configured Quire server.
   * @param config.apiKey - Bearer credential authorizing owner API requests.
   */
  constructor(config: { serverUrl: string; apiKey: string } = loadCliConfig()) {
    this.baseUrl = config.serverUrl;
    this.apiKey = config.apiKey;
  }

  /**
   * Round 9 (C-F6): the origin (scheme + host + port) of the configured
   * server — no userinfo, no path. User-facing URLs are built from this so a
   * `https://user:pass@host/` base URL never leaks credentials into printed
   * output.
   *
   * @returns Credential-free origin, or the original value if it is not a URL.
   */
  get origin(): string {
    try {
      return new URL(this.baseUrl).origin;
    } catch {
      return this.baseUrl;
    }
  }

  /**
   * Serialize a JSON request and send it through the authenticated transport.
   *
   * @param method - HTTP method.
   * @param path - API path relative to the configured server URL.
   * @param body - Optional JSON-serializable payload.
   * @returns Parsed response payload.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.requestRaw(method, path, body === undefined ? undefined : JSON.stringify(body));
  }

  /**
   * Low-level variant taking the request body pre-serialized. The v2
   * chunk/finalize methods use it so the exact bytes sent are the bytes the
   * server digests: a retried chunk re-sends the same serialized body
   * (byte-exact idempotency).
   *
   * @param method - HTTP method.
   * @param path - API path relative to the configured server URL.
   * @param rawBody - Exact serialized JSON bytes, or undefined for no body.
   * @param headers - Additional request headers such as the upload token.
   * @returns Parsed response payload.
   */
  private async requestRaw<T>(method: string, path: string, rawBody: string | undefined, headers: Record<string, string> = {}): Promise<T> {
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
          ...(rawBody !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: rawBody,
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

  // v2 sealed shares (OMP-inspired sharing migration). The body is serialized
  // once per call; the orchestrator reuses the same body object on retry, so
  // the serialized bytes — and the server's byte-exact digest — are stable.
  /**
   * Create a sealed share with its first source chunk.
   *
   * @param body - Creation metadata, content key, and initial messages.
   * @returns Upload credentials and accepted-chunk statistics.
   */
  createV2Share(body: unknown): Promise<V2CreateResponse> {
    return this.requestRaw('POST', '/api/v2/shares', JSON.stringify(body));
  }

  /**
   * Upload one numbered source chunk.
   *
   * @param shareId - Share identifier returned by creation.
   * @param seq - Zero-based source chunk sequence.
   * @param body - Content key and messages for this chunk.
   * @param uploadToken - Credential scoped to the in-progress upload.
   * @returns Accepted chunk and cumulative storage statistics.
   */
  uploadV2Chunk(shareId: string, seq: number, body: unknown, uploadToken: string): Promise<V2ChunkResponse> {
    return this.requestRaw('PUT', `/api/v2/shares/${shareId}/source-chunks/${seq}`, JSON.stringify(body), {
      'x-upload-token': uploadToken,
    });
  }

  /**
   * Finalize an upload into a publicly readable sealed share.
   *
   * @param shareId - Identifier of the upload to finalize.
   * @param body - Finalization settings and content key.
   * @param uploadToken - Credential scoped to the in-progress upload.
   * @returns Public path and final share statistics.
   */
  finalizeV2Share(shareId: string, body: unknown, uploadToken: string): Promise<V2FinalizeResponse> {
    return this.requestRaw('POST', `/api/v2/shares/${shareId}/finalize`, JSON.stringify(body), {
      'x-upload-token': uploadToken,
    });
  }

  /**
   * List metadata for the authenticated owner's shares.
   *
   * @returns Owned shares without their content keys or upload credentials.
   */
  list(): Promise<{ shares: ShareMeta[] }> {
    return this.request('GET', '/api/chats');
  }

  /**
   * Fetch owner-visible details for a share.
   *
   * @param token - Share identifier accepted by the owner API.
   * @returns Share details returned by the server.
   */
  get(token: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/chats/${token}`);
  }

  /**
   * Update a share's title or expiry.
   *
   * @param token - Share identifier accepted by the owner API.
   * @param body - Metadata fields to update; null expiry removes expiration.
   * @param body.title - Replacement share title, when provided.
   * @param body.expiresAt - New ISO expiration, or null to remove expiration.
   * @returns Server acknowledgement.
   */
  patch(token: string, body: { title?: string; expiresAt?: string | null }): Promise<{ ok: boolean }> {
    return this.request('PATCH', `/api/chats/${token}`, body);
  }

  /**
   * Revoke an owned share.
   *
   * @param token - Share identifier accepted by the owner API.
   * @returns Server acknowledgement.
   */
  revoke(token: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/api/chats/${token}`);
  }
}
