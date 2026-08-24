import { redactText, walkStrings } from './redact.js';
import type { Preset } from './rules.js';

export interface ShapedPart {
  type: 'text' | 'tool' | 'reasoning';
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

export interface PreparedContent {
  messages: ShapedMessage[];
  summary: Record<string, number>;
  bytes: number;
  messageCount: number;
}

function redactPart(part: ShapedPart, preset: Preset, add: (counts: Record<string, number>) => void): ShapedPart {
  const red = (s: string): string => {
    const r = redactText(s, preset);
    add(r.counts);
    return r.text;
  };
  const out: ShapedPart = { ...part };
  if (part.text !== undefined) out.text = red(part.text);
  if (part.output !== undefined) out.output = red(part.output);
  if (part.input !== undefined) out.input = walkStrings(part.input, red);
  return out;
}

/** The single authoritative redaction pass. Only the result of this function is persisted. */
export function prepareContent(messages: ShapedMessage[], preset: Preset): PreparedContent {
  const summary: Record<string, number> = {};
  const add = (counts: Record<string, number>): void => {
    for (const [k, v] of Object.entries(counts)) summary[k] = (summary[k] ?? 0) + v;
  };
  const redacted = messages.map((m) => ({ ...m, parts: m.parts.map((p) => redactPart(p, preset, add)) }));
  return {
    messages: redacted,
    summary,
    bytes: Buffer.byteLength(JSON.stringify(redacted)),
    messageCount: redacted.length,
  };
}
