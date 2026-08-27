export interface ShapedPart {
  type: 'text' | 'tool' | 'reasoning' | 'system';
  text?: string;
  callID?: string;
  tool?: string;
  status?: string;
  input?: unknown;
  output?: string;
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
