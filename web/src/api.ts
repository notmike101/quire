export interface ShareImage {
  src?: string; // data: URI; absent when tooLarge
  mime?: string;
  alt?: string;
  bytes?: number;
  tooLarge?: boolean;
}

export interface SharePart {
  type: 'text' | 'tool' | 'reasoning' | 'system' | 'image';
  text?: string;
  callID?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: string;
  // tool parts: images the agent viewed, rendered inside the tool card's
  // collapsible body (Read attachments, screenshot tool output, etc.).
  images?: ShareImage[];
  // standalone image parts (type: 'image'): the agent's deliberate markdown
  // screenshots in text parts — rendered expanded, outside any tool card.
  src?: string;
  mime?: string;
  alt?: string;
  bytes?: number;
  tooLarge?: boolean;
}

export interface MessageIdentity {
  chunkSeq: number;
  seq: number;
}

export function messageAnchorId({ chunkSeq, seq }: MessageIdentity): string {
  return `msg-${chunkSeq}-${seq}`;
}

export interface ShareMessage extends MessageIdentity {
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

/** A user message in the full-share rail index: its composite jump target and
 * short preview for the hover tooltip. Present only on the first page. */
export interface RailUserEntry extends MessageIdentity {
  preview: string;
}

export interface PageResponse {
  meta: ShareMeta;
  messages: ShareMessage[];
  /** Full-share user-message index for the rail (first page only). */
  userIndex?: RailUserEntry[];
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
