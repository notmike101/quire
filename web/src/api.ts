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
