export interface ShapedPart {
  type: 'text' | 'tool' | 'reasoning' | 'system' | 'image';
  text?: string;
  callID?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: string;
  // image parts (type: 'image'):
  src?: string; // data: URI (e.g. "data:image/jpeg;base64,…"); absent when tooLarge
  mime?: string; // "image/jpeg" | "image/png" | …
  alt?: string; // short label, e.g. "Read image" or "cactus_v3.png"
  bytes?: number; // original file size in bytes
  tooLarge?: boolean; // true when the image exceeded the embed cap (no src)
  collapsed?: boolean; // render collapsed by default (Read-attachment images)
}

export interface ShapedMessage {
  role: 'user' | 'assistant';
  time?: string;
  parts: ShapedPart[];
}

export interface ShapedSession {
  sessionId: string;
  title: string;
  model?: string;
  provider?: string;
  messages: ShapedMessage[];
}

export interface HarnessSessionInfo {
  id: string;
  title: string;
  updatedAt: string; // ISO 8601
  isSubagent: boolean;
}

export interface HarnessAdapter {
  name: 'zcode' | 'claude-code';
  listSessions(): Promise<HarnessSessionInfo[]>;
  resolveCurrent(): Promise<HarnessSessionInfo>;
  loadSession(id: string): Promise<ShapedSession>;
}
