export interface ShapedImage {
  src?: string; // data: URI (e.g. "data:image/jpeg;base64,…"); absent when tooLarge
  mime?: string; // "image/jpeg" | "image/png" | …
  alt?: string; // short label, e.g. "Read image" or "cactus_v3.png"
  bytes?: number; // original file size in bytes
  tooLarge?: boolean; // true when the image exceeded the embed cap (no src)
}

export interface ShapedPart {
  type: 'text' | 'tool' | 'reasoning' | 'system' | 'image';
  text?: string;
  callID?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: string;
  // tool parts: images the agent viewed, rendered inside the tool card's
  // collapsible body (Read attachments, screenshot tool output, etc.).
  images?: ShapedImage[];
  // standalone image parts (type: 'image'): the agent's deliberate markdown
  // screenshots in text parts — rendered expanded, outside any tool card.
  src?: string;
  mime?: string;
  alt?: string;
  bytes?: number;
  tooLarge?: boolean;
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
  name: 'zcode' | 'claude-code' | 'codex' | 'omp';
  listSessions(): Promise<HarnessSessionInfo[]>;
  resolveCurrent(): Promise<HarnessSessionInfo>;
  loadSession(id: string): Promise<ShapedSession>;
}
