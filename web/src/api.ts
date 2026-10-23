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

/**
 * Build the DOM anchor for a message's composite identity.
 *
 * @param identity - Position of the message within the share.
 * @param identity.chunkSeq - Chunk containing the message.
 * @param identity.seq - Message sequence within that chunk.
 * @returns Stable anchor shared by the transcript and message rail.
 */
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

/**
 * A user message in the full-share rail index, with its jump target and tooltip
 * preview. Present only on the first page.
 */
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

/** An API failure with the HTTP status and machine-readable share error code. */
export class ShareError extends Error {
  /**
   * Preserve a share API failure for viewer state handling.
   *
   * @param status - HTTP response status.
   * @param code - Error code used to select a viewer state.
   * @param message - Human-readable failure description.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
