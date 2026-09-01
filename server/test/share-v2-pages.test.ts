import { describe, expect, it } from 'vitest';
import {
  MAX_PAGE_BYTES,
  MAX_RAIL_USER_ENTRIES,
  SHARE_PROTOCOL,
  type ShareMessageV1,
  type SharePageV1,
} from '@quire/protocol';
import { prepareContent, type PreparedContent, type ShapedMessage, type ShapedSession } from '../src/redact/prepare.js';
import { buildRailEntries, buildViewerPages } from '../src/share-v2/pages.js';
import fixture from './fixtures/tool-heavy-session.json' with { type: 'json' };

// Minimal PreparedContent for partitioner tests — buildViewerPages only reads
// `prepared.messages`, so redaction fields are irrelevant here.
function prepared(messages: ShapedMessage[]): PreparedContent {
  return { messages, summary: {}, bytes: 0, messageCount: messages.length };
}

function textMsg(role: 'user' | 'assistant', i: number): ShapedMessage {
  return { role, time: '2026-09-01T00:00:00.000Z', parts: [{ type: 'text', text: `message ${i}` }] };
}

describe('buildViewerPages', () => {
  it('splits a 120-message chunk into 3 pages of 50/50/20', () => {
    const messages = Array.from({ length: 120 }, (_, i) => textMsg(i % 2 ? 'assistant' : 'user', i));
    const { pages, nextPageSeq } = buildViewerPages({
      shareId: 'share-1',
      chunkSeq: 2,
      prepared: prepared(messages),
      startPageSeq: 7,
      startMsgSeq: 100,
    });
    expect(pages.map((p) => p.messages.length)).toEqual([50, 50, 20]);
    expect(pages.map((p) => p.seq)).toEqual([7, 8, 9]);
    expect(nextPageSeq).toBe(10);
    for (const p of pages) {
      expect(p.protocol).toBe(SHARE_PROTOCOL);
      expect(p.shareId).toBe('share-1');
    }
    for (const m of pages.flatMap((p) => p.messages)) expect(m.chunkSeq).toBe(2);
  });

  it('assigns global message seq from startMsgSeq across the page boundary', () => {
    const messages = Array.from({ length: 120 }, (_, i) => textMsg('user', i));
    const { pages } = buildViewerPages({ shareId: 's', chunkSeq: 0, prepared: prepared(messages), startPageSeq: 0, startMsgSeq: 100 });
    expect(pages[0]!.messages[0]!.seq).toBe(100);
    expect(pages[0]!.messages[49]!.seq).toBe(149); // the 50th message
    expect(pages[1]!.messages[0]!.seq).toBe(150);
    expect(pages[2]!.messages[19]!.seq).toBe(219);
  });

  it('emits a single oversized message as a one-message page', () => {
    const big: ShapedMessage = { role: 'assistant', parts: [{ type: 'tool', tool: 'bash', output: 'x'.repeat(5 * 1024 * 1024) }] };
    const { pages, nextPageSeq } = buildViewerPages({ shareId: 's', chunkSeq: 0, prepared: prepared([big]), startPageSeq: 3, startMsgSeq: 0 });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.seq).toBe(3);
    expect(pages[0]!.messages).toHaveLength(1);
    expect(pages[0]!.messages[0]!.seq).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(pages[0]), 'utf8')).toBeGreaterThan(MAX_PAGE_BYTES);
    expect(nextPageSeq).toBe(4);
  });

  it('splits on the byte bound before the message-count bound', () => {
    // Three ~2 MiB messages: any two together exceed 4 MiB, so each gets its own page.
    const big = (i: number): ShapedMessage => ({ role: 'assistant', parts: [{ type: 'tool', tool: 'bash', output: `m${i}`.padEnd(2 * 1024 * 1024, 'x') }] });
    const { pages } = buildViewerPages({ shareId: 's', chunkSeq: 0, prepared: prepared([big(0), big(1), big(2)]), startPageSeq: 0, startMsgSeq: 0 });
    expect(pages.map((p) => p.messages.length)).toEqual([1, 1, 1]);
    expect(pages.map((p) => p.messages[0]!.seq)).toEqual([0, 1, 2]);
  });

  it('maps time undefined to null and parts 1:1', () => {
    const msg: ShapedMessage = { role: 'user', parts: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'hi' }] };
    const { pages } = buildViewerPages({ shareId: 's', chunkSeq: 0, prepared: prepared([msg]), startPageSeq: 0, startMsgSeq: 0 });
    expect(pages[0]!.messages[0]).toEqual({ chunkSeq: 0, seq: 0, role: 'user', time: null, parts: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'hi' }] });
  });

  it('is deterministic: two calls produce byte-identical pages', () => {
    const messages = Array.from({ length: 120 }, (_, i) => textMsg(i % 2 ? 'assistant' : 'user', i));
    const a = buildViewerPages({ shareId: 's', chunkSeq: 0, prepared: prepared(messages), startPageSeq: 0, startMsgSeq: 0 });
    const b = buildViewerPages({ shareId: 's', chunkSeq: 0, prepared: prepared(messages), startPageSeq: 0, startMsgSeq: 0 });
    expect(a.pages.length).toBe(b.pages.length);
    for (let i = 0; i < a.pages.length; i++) {
      expect(JSON.stringify(a.pages[i])).toBe(JSON.stringify(b.pages[i]));
    }
  });
});

describe('buildRailEntries', () => {
  const page = (seq: number, messages: ShareMessageV1[]): SharePageV1 => ({ protocol: SHARE_PROTOCOL, shareId: 's', seq, messages });

  it('returns only user messages in global order with v1-matching previews', () => {
    const pages = [
      page(0, [
        { chunkSeq: 0, seq: 0, role: 'user', time: null, parts: [{ type: 'text', text: '' }, { type: 'text', text: '  hello\n  world  ' }] },
        { chunkSeq: 0, seq: 1, role: 'assistant', time: null, parts: [{ type: 'text', text: 'assistant text must not appear' }] },
        { chunkSeq: 0, seq: 2, role: 'user', time: null, parts: [{ type: 'tool', tool: 'bash', output: 'no text part' }] },
      ]),
      page(1, [
        { chunkSeq: 0, seq: 3, role: 'user', time: null, parts: [{ type: 'text', text: 'a'.repeat(100) }] },
        { chunkSeq: 0, seq: 4, role: 'user', time: null, parts: [{ type: 'text', text: 'a b '.repeat(30) }] },
      ]),
    ];
    const entries = buildRailEntries(pages, MAX_RAIL_USER_ENTRIES);
    expect(entries).toEqual([
      { chunkSeq: 0, seq: 0, preview: 'hello world' }, // first non-empty text part, whitespace-normalized
      { chunkSeq: 0, seq: 2, preview: '' }, // no text part -> empty preview
      { chunkSeq: 0, seq: 3, preview: 'a'.repeat(80) }, // truncated to 80
      { chunkSeq: 0, seq: 4, preview: Array.from({ length: 20 }, () => 'a b').join(' ') }, // left(80) THEN normalize, like v1 SQL
    ]);
  });

  it('drops entries beyond the cap (2500 user messages -> exactly 2000)', () => {
    const messages = Array.from({ length: 2500 }, (_, i) => ({ role: 'user' as const, parts: [{ type: 'text' as const, text: `q${i}` }] }));
    const { pages } = buildViewerPages({ shareId: 's', chunkSeq: 0, prepared: prepared(messages), startPageSeq: 0, startMsgSeq: 0 });
    expect(pages).toHaveLength(50);
    const entries = buildRailEntries(pages, MAX_RAIL_USER_ENTRIES);
    expect(entries).toHaveLength(MAX_RAIL_USER_ENTRIES);
    expect(entries[0]).toEqual({ chunkSeq: 0, seq: 0, preview: 'q0' });
    expect(entries[1999]).toEqual({ chunkSeq: 0, seq: 1999, preview: 'q1999' });
  });
});

describe('tool-heavy fixture through prepareContent + buildViewerPages', () => {
  const session = fixture as ShapedSession;

  it('keeps every legitimate page well under MAX_PAGE_BYTES', () => {
    const preparedContent = prepareContent(session, 'normal');
    // The fixture is redaction-clean: no rule may fire on it, so the size
    // assertion measures real content, not redaction artifacts.
    expect(Object.keys(preparedContent.summary)).toHaveLength(0);
    expect(preparedContent.messageCount).toBe(session.messages.length);
    const { pages, nextPageSeq } = buildViewerPages({ shareId: 'share-fixture', chunkSeq: 0, prepared: preparedContent, startPageSeq: 0, startMsgSeq: 0 });
    expect(pages.length).toBeGreaterThan(1);
    expect(nextPageSeq).toBe(pages.length);
    expect(pages.reduce((n, p) => n + p.messages.length, 0)).toBe(session.messages.length);
    const largest = Math.max(...pages.map((p) => Buffer.byteLength(JSON.stringify(p), 'utf8')));
    expect(largest).toBeLessThan(MAX_PAGE_BYTES / 2);
  });
});
