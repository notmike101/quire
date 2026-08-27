import type { ShapedPart } from './harness/types.js';

/**
 * Harness-injected context. The harness (ZCode, Claude Code) prepends
 * `<system-reminder>…</system-reminder>` blocks to user messages — goal
 * continuations, todo nudges, compaction notes. These are not what the user
 * typed; they are runtime metadata. We surface them as a distinct `system`
 * part so the viewer can render them as a muted, collapsible notice instead
 * of a user bubble.
 *
 * The parser is deliberately conservative: only a well-formed, top-level
 * `<system-reminder>` block is treated as system. Nested tags (e.g.
 * `<untrusted_objective>` inside a reminder) are part of the block's content,
 * not separate segments. Text that merely *mentions* the tag (e.g. inside
 * backticks) is left untouched.
 */

export interface SystemSegment {
  kind: 'text' | 'system';
  text: string;
}

const REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;

/**
 * Split a text part into ordered segments. A part that is entirely one
 * reminder block (ignoring surrounding whitespace) yields a single `system`
 * segment. A mixed part yields its real text plus one `system` segment per
 * injected block, in order. A part with no reminder block is returned as a
 * single `text` segment unchanged.
 */
export function splitSystemText(text: string): SystemSegment[] {
  if (!text.includes('<system-reminder>')) return [{ kind: 'text', text }];

  const segments: SystemSegment[] = [];
  let last = 0;
  REMINDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REMINDER_RE.exec(text)) !== null) {
    if (m.index > last) {
      const before = text.slice(last, m.index);
      if (before.trim() !== '') segments.push({ kind: 'text', text: before });
    }
    segments.push({ kind: 'system', text: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const after = text.slice(last);
    if (after.trim() !== '') segments.push({ kind: 'text', text: after });
  }
  // No well-formed block found (e.g. an unclosed tag): treat the whole part
  // as plain text so nothing is silently dropped.
  if (segments.length === 0) return [{ kind: 'text', text }];
  return segments;
}

/**
 * Short, human label for a system block, used as the collapsed chip title.
 * The goal-continuation reminder is the dominant real-world case; everything
 * else falls back to a generic label.
 */
export function systemLabel(block: string): string {
  if (block.includes('active session goal')) return 'goal continuation';
  if (block.includes('TodoWrite')) return 'todo reminder';
  if (block.includes('continued from a previous conversation')) return 'context summary';
  return 'system reminder';
}

/**
 * Rewrite a message's text parts, splitting out harness-injected system
 * blocks. Non-text parts pass through untouched. A text part that yields no
 * system segment is left as-is (same object shape, no new part).
 */
export function extractSystemParts(parts: ShapedPart[]): ShapedPart[] {
  const out: ShapedPart[] = [];
  for (const p of parts) {
    if (p.type !== 'text' || typeof p.text !== 'string') {
      out.push(p);
      continue;
    }
    const segments = splitSystemText(p.text);
    if (segments.length === 1 && segments[0]!.kind === 'text') {
      out.push(p);
      continue;
    }
    for (const seg of segments) {
      out.push(seg.kind === 'system' ? { type: 'system', text: seg.text } : { type: 'text', text: seg.text });
    }
  }
  return out;
}

/**
 * Reasoning-model thinking. The model (ZCode, Claude Code) sometimes emits its
 * thinking as a literal `<think>…</think>` block inside a text part rather than
 * as a structured reasoning part. The viewer's markdown renderer passes the raw
 * tags through, so they show up as visible `think` text in the chat.
 *
 * We split these out into a `reasoning` part so the viewer can render them as a
 * muted, collapsible "thinking…" block. The parser is conservative: only a
 * well-formed `<think>…</think>` block is treated as reasoning. An EMPTY block
 * (whitespace-only content — the dominant real-world case, ~99%) is dropped
 * entirely; it carries no information. A non-empty block becomes a `reasoning`
 * segment. Text that merely *mentions* the tag is left untouched, and an
 * unclosed tag degrades to plain text (nothing is dropped).
 */

export interface ThinkSegment {
  kind: 'text' | 'reasoning';
  text: string;
}

const THINK_RE = /<think>([\s\S]*?)<\/think>/g;

/**
 * Split a text part into ordered segments, extracting well-formed `<think>`
 * blocks. Empty blocks are dropped; non-empty blocks become `reasoning`
 * segments. A part with no well-formed block is returned as a single `text`
 * segment unchanged.
 */
export function splitThinkText(text: string): ThinkSegment[] {
  if (!text.includes('<think>')) return [{ kind: 'text', text }];

  const segments: ThinkSegment[] = [];
  let last = 0;
  THINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = THINK_RE.exec(text)) !== null) {
    if (m.index > last) {
      const before = text.slice(last, m.index);
      if (before.trim() !== '') segments.push({ kind: 'text', text: before });
    }
    const content = m[1]!;
    // Empty (whitespace-only) thinking blocks carry no information — drop them.
    if (content.trim() !== '') segments.push({ kind: 'reasoning', text: content });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const after = text.slice(last);
    if (after.trim() !== '') segments.push({ kind: 'text', text: after });
  }
  // No well-formed block found (e.g. an unclosed tag): treat the whole part as
  // plain text so nothing is silently dropped.
  if (segments.length === 0) return [{ kind: 'text', text }];
  return segments;
}

/**
 * Rewrite a message's text parts, splitting out literal `<think>` blocks into
 * `reasoning` parts. Non-text parts pass through untouched. A text part that
 * yields no reasoning segment is left as-is.
 */
export function extractReasoningParts(parts: ShapedPart[]): ShapedPart[] {
  const out: ShapedPart[] = [];
  for (const p of parts) {
    if (p.type !== 'text' || typeof p.text !== 'string') {
      out.push(p);
      continue;
    }
    // Fast path: no think tag at all → nothing to do, keep the original part.
    if (!p.text.includes('think')) {
      out.push(p);
      continue;
    }
    const segments = splitThinkText(p.text);
    for (const seg of segments) {
      out.push(seg.kind === 'reasoning' ? { type: 'reasoning', text: seg.text } : { type: 'text', text: seg.text });
    }
  }
  return out;
}
