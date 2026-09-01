export const SHARE_PROTOCOL = 'quire-share-v1';

export type BlobKind = 'manifest' | 'index' | 'page';

export const MAX_MESSAGES_PER_PAGE = 50;
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const MAX_RAIL_USER_ENTRIES = 2000;
export const MAX_DECOMPRESSED_BLOB_BYTES = 32 * 1024 * 1024;
export const MAX_SHARE_BYTES = 1024 * 1024 * 1024;

export interface ShareImageV1 {
  src?: string;
  mime?: string;
  alt?: string;
  bytes?: number;
  tooLarge?: boolean;
}

export interface SharePartV1 {
  type: 'text' | 'tool' | 'reasoning' | 'system' | 'image';
  text?: string;
  callID?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: string;
  images?: ShareImageV1[];
  src?: string;
  mime?: string;
  alt?: string;
  bytes?: number;
  tooLarge?: boolean;
}

export interface ShareMessageV1 {
  chunkSeq: number;
  seq: number;
  role: 'user' | 'assistant';
  time: string | null;
  parts: SharePartV1[];
}

export interface SharePageV1 {
  protocol: typeof SHARE_PROTOCOL;
  shareId: string;
  seq: number;
  messages: ShareMessageV1[];
}

export interface ShareManifestV1 {
  protocol: typeof SHARE_PROTOCOL;
  shareId: string;
  title: string;
  model?: string;
  provider?: string;
  createdAt: string;
  expiresAt: string | null;
  messageCount: number;
  redactions: Record<string, number>;
  pageCount: number;
}

export interface RailUserEntryV1 {
  chunkSeq: number;
  seq: number;
  preview: string;
}

export interface ShareIndexSegmentV1 {
  protocol: typeof SHARE_PROTOCOL;
  shareId: string;
  seq: number;
  entries: RailUserEntryV1[];
}
