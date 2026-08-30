import { describe, it, expect } from 'vitest';
import { splitSystemText, systemLabel, extractSystemParts, splitThinkText, extractReasoningParts } from '../src/system.js';
import type { ShapedPart } from '../src/harness/types.js';

// The think tags are built at runtime so the literal markup is never mangled by
// any tool that strips HTML-ish tags from file contents.
const T_OPEN = '<' + 'think' + '>';
const T_CLOSE = '<' + '/' + 'think' + '>';

describe('splitSystemText', () => {
  it('returns a single text segment when there is no reminder block', () => {
    expect(splitSystemText('hello world')).toEqual([{ kind: 'text', text: 'hello world' }]);
  });

  it('treats a mention of the tag in backticks as plain text', () => {
    const text = "I see `<system-reminder>` and `<untrusted_objective>` in the output.";
    expect(splitSystemText(text)).toEqual([{ kind: 'text', text }]);
  });

  it('keeps a well-formed reminder block quoted in backticks as plain text', () => {
    // A user writing about the harness quotes the tag inline; the block is
    // well-formed but backtick-wrapped, so it must NOT become a system part.
    const text = "I'm seeing: `<system-reminder>...</system-reminder>` rendered as chat.";
    const segs = splitSystemText(text);
    // No segment may be a system part; the quoted block stays as text.
    expect(segs.some((s) => s.kind === 'system')).toBe(false);
    // Reassembled, the text is preserved verbatim (nothing dropped).
    expect(segs.map((s) => s.text).join('')).toBe(text);
  });

  it('splits a leading real injection followed by quoted prose', () => {
    // A real harness injection is PREPENDED to the part; any prose (including a
    // quoted mention of the tag) comes AFTER it. The leading block is a system
    // segment; the trailing prose is kept verbatim as one text segment.
    const text =
      '<system-reminder>\nContinue working toward the active session goal.\n</system-reminder>\n' +
      'Quoted: `<system-reminder>...</system-reminder>`';
    const segs = splitSystemText(text);
    expect(segs.map((s) => s.kind)).toEqual(['system', 'text']);
    expect(segs[0]!.text).toContain('active session goal');
    // The trailing quoted mention survives as plain text, verbatim.
    expect(segs[1]!.text).toContain('`<system-reminder>...</system-reminder>`');
  });

  it('splits a pure reminder block into a single system segment', () => {
    const text = '<system-reminder>\nContinue working toward the active session goal.\n</system-reminder>';
    expect(splitSystemText(text)).toEqual([{ kind: 'system', text: '\nContinue working toward the active session goal.\n' }]);
  });

  it('keeps nested tags as part of the system block content', () => {
    const text = '<system-reminder>\n<untrusted_objective>\ndo the thing\n</untrusted_objective>\n</system-reminder>';
    const segs = splitSystemText(text);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe('system');
    expect(segs[0]!.text).toContain('<untrusted_objective>');
    expect(segs[0]!.text).toContain('do the thing');
  });

  it('leaves an embedded reminder (text before the tag) as plain text', () => {
    // A reminder block that is NOT at the start of the part — real user prose
    // comes first — is not an injection. Real harness injections are prepended,
    // never embedded mid-prose. The whole part stays one text segment.
    const text = 'Real user text here.\n<system-reminder>\nreminder body\n</system-reminder>\nTrailing text.';
    expect(splitSystemText(text)).toEqual([{ kind: 'text', text }]);
  });

  it('extracts only the leading block when a second block follows mid-prose', () => {
    // The first block is leading (a real injection); a second block that appears
    // after intervening prose is embedded and is left as plain text.
    const text = '<system-reminder>a</system-reminder>middle<system-reminder>b</system-reminder>';
    const segs = splitSystemText(text);
    expect(segs.map((s) => s.kind)).toEqual(['system', 'text']);
    expect(segs[0]!.text).toBe('a');
    expect(segs[1]!.text).toBe('middle<system-reminder>b</system-reminder>');
  });

  it('leaves a tool output that is source code quoting the tag as plain text', () => {
    // The motivating case: a Read tool output (rendered as a text part) whose
    // content is source code containing the literal tag string — e.g. reading a
    // test file whose fixtures include the tag. The tag is embedded in the code,
    // not at the start of the part, so it is never treated as an injection.
    const text =
      'Result of calling the Read tool:\n' +
      '92\t    const part: ShapedPart = { type: \'text\', text: \'<system-reminder>\ngoal body\n</system-reminder>\' };\n' +
      '93\t    expect(extractSystemParts([part])).toEqual([{ type: \'system\', text: \'\\ngoal body\\n\' }]);';
    expect(splitSystemText(text)).toEqual([{ kind: 'text', text }]);
  });

  it('treats an unclosed reminder tag as plain text (nothing dropped)', () => {
    const text = '<system-reminder>unclosed and never closed';
    expect(splitSystemText(text)).toEqual([{ kind: 'text', text }]);
  });

  it('drops whitespace-only text segments around a block', () => {
    const text = '  <system-reminder>only</system-reminder>  ';
    const segs = splitSystemText(text);
    expect(segs).toEqual([{ kind: 'system', text: 'only' }]);
  });
});

describe('systemLabel', () => {
  it('labels goal-continuation reminders', () => {
    expect(systemLabel('Continue working toward the active session goal.')).toBe('goal continuation');
  });
  it('labels todo reminders', () => {
    expect(systemLabel("The TodoWrite tool hasn't been used recently.")).toBe('todo reminder');
  });
  it('labels compaction summaries', () => {
    expect(systemLabel('This session is being continued from a previous conversation.')).toBe('context summary');
  });
  it('falls back to a generic label', () => {
    expect(systemLabel('some other harness note')).toBe('system reminder');
  });
});

describe('extractSystemParts', () => {
  it('passes non-text parts through untouched', () => {
    const tool: ShapedPart = { type: 'tool', tool: 'Bash', status: 'completed', input: { command: 'ls' }, output: 'ok' };
    const reasoning: ShapedPart = { type: 'reasoning', text: 'hmm' };
    expect(extractSystemParts([tool, reasoning])).toEqual([tool, reasoning]);
  });

  it('leaves a plain text part unchanged', () => {
    const text: ShapedPart = { type: 'text', text: 'just text' };
    expect(extractSystemParts([text])).toEqual([text]);
  });

  it('converts a pure reminder part into a single system part', () => {
    const part: ShapedPart = { type: 'text', text: '<system-reminder>\ngoal body\n</system-reminder>' };
    expect(extractSystemParts([part])).toEqual([{ type: 'system', text: '\ngoal body\n' }]);
  });

  it('splits a leading injection followed by user prose into system + text', () => {
    // A real harness injection is prepended to the user's actual message. The
    // leading block becomes a system part; the trailing prose stays one text part.
    const part: ShapedPart = { type: 'text', text: '<system-reminder>\nnote\n</system-reminder>\nuser said hi' };
    expect(extractSystemParts([part])).toEqual([
      { type: 'system', text: '\nnote\n' },
      { type: 'text', text: '\nuser said hi' },
    ]);
  });

  it('leaves a part with an embedded reminder (text before the tag) as one text part', () => {
    // The tag is not at the start of the part, so it is not an injection. The
    // whole part stays a single text part (one message), not fragments.
    const part: ShapedPart = { type: 'text', text: 'user said hi\n<system-reminder>\nnote\n</system-reminder>' };
    expect(extractSystemParts([part])).toEqual([part]);
  });

  it('preserves the order of multiple parts in a message', () => {
    const parts: ShapedPart[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: '<system-reminder>mid</system-reminder>' },
      { type: 'tool', tool: 'Read', status: 'completed', input: {}, output: 'x' },
      { type: 'text', text: '<system-reminder>tail</system-reminder>' },
    ];
    const out = extractSystemParts(parts);
    expect(out.map((p) => p.type)).toEqual(['text', 'system', 'tool', 'system']);
  });

  it('converts a bare TodoWrite nudge (no wrapper) into a system part', () => {
    const part: ShapedPart = { type: 'text', text: "The TodoWrite tool hasn't been used recently. If you're working on tasks, consider using the TodoWrite tool." };
    expect(extractSystemParts([part])).toEqual([{ type: 'system', text: part.text }]);
  });

  it('converts a bare TodoWrite nudge with an appended todo list into a system part', () => {
    const part: ShapedPart = { type: 'text', text: "The TodoWrite tool hasn't been used recently. Consider using the TodoWrite tool.\n\nHere are the existing contents of your todo list:\n\n[1. [pending] do the thing]" };
    expect(extractSystemParts([part])).toEqual([{ type: 'system', text: part.text }]);
  });

  it('leaves real user text that mentions TodoWrite unchanged', () => {
    const part: ShapedPart = { type: 'text', text: 'I used the TodoWrite tool to track my progress.' };
    expect(extractSystemParts([part])).toEqual([part]);
  });

  it('keeps a part that only quotes the tag in backticks as a single text part', () => {
    // The user's message quotes the tag inline; there is no real injection, so
    // the whole part must stay one text part (one message), not fragments.
    const part: ShapedPart = {
      type: 'text',
      text: "I'm seeing: `<system-reminder>...</system-reminder>` rendered as chat.\n\nFigure this out.",
    };
    expect(extractSystemParts([part])).toEqual([part]);
  });

  it('splits a part with a leading real injection followed by a quoted mention', () => {
    // The real injection is prepended (leading); the quoted mention is trailing
    // prose. Leading block → system part; the quoted mention stays in the text.
    const part: ShapedPart = {
      type: 'text',
      text: '<system-reminder>\ngoal body\n</system-reminder>\nQuoted: `<system-reminder>...</system-reminder>`',
    };
    const out = extractSystemParts([part]);
    expect(out.map((p) => p.type)).toEqual(['system', 'text']);
    expect(out[0]!.text).toContain('goal body');
    expect(out[1]!.text).toContain('`<system-reminder>...</system-reminder>`');
  });

  it('leaves a part that quotes the tag mid-prose (no leading block) as one text part', () => {
    // The tag only appears embedded (after prose), never leading — so there is
    // no real injection and the whole part stays one text part.
    const part: ShapedPart = {
      type: 'text',
      text: 'Quoted: `<system-reminder>...</system-reminder>`\n<system-reminder>\ngoal body\n</system-reminder>',
    };
    expect(extractSystemParts([part])).toEqual([part]);
  });
});

describe('splitThinkText', () => {
  it('returns a single text segment when there is no think block', () => {
    expect(splitThinkText('hello world')).toEqual([{ kind: 'text', text: 'hello world' }]);
  });

  it('treats a mention of the tag in backticks as plain text', () => {
    const text = 'The model emits `think` tags in its output.';
    expect(splitThinkText(text)).toEqual([{ kind: 'text', text }]);
  });

  it('drops an empty think block (the dominant real-world case)', () => {
    const text = T_OPEN + '\n\n' + T_CLOSE + '\n\nHello.';
    expect(splitThinkText(text)).toEqual([{ kind: 'text', text: '\n\nHello.' }]);
  });

  it('converts a non-empty think block into a reasoning segment', () => {
    const text = T_OPEN + '\nLet me think.\n' + T_CLOSE + '\nSome answer.';
    const segs = splitThinkText(text);
    expect(segs).toEqual([
      { kind: 'reasoning', text: '\nLet me think.\n' },
      { kind: 'text', text: '\nSome answer.' },
    ]);
  });

  it('leaves an embedded think block (not at the start) as plain text', () => {
    // A think tag in the middle of prose (e.g. a compaction summary quoting the
    // conversation, or quoted code) is NOT reasoning — the whole part is text.
    const text = 'Preamble.\n' + T_OPEN + 'real thinking here' + T_CLOSE + '\nTrailing.';
    expect(splitThinkText(text)).toEqual([{ kind: 'text', text }]);
  });

  it('extracts multiple consecutive leading think blocks, dropping empty ones', () => {
    const text = T_OPEN + 'x' + T_CLOSE + T_OPEN + ' ' + T_CLOSE + '\nAnswer.';
    const segs = splitThinkText(text);
    // First block is reasoning; second is empty (dropped); then the answer.
    expect(segs.map((s) => s.kind)).toEqual(['reasoning', 'text']);
    expect(segs[0]!.text).toBe('x');
    expect(segs[1]!.text).toBe('\nAnswer.');
  });

  it('treats an unclosed think tag as plain text (nothing dropped)', () => {
    const text = T_OPEN + 'unclosed and never closed';
    expect(splitThinkText(text)).toEqual([{ kind: 'text', text }]);
  });

  it('drops a part that is only an empty think block down to a text fallback', () => {
    // A part that is *only* an empty think block yields no segments; we fall
    // back to the original text so nothing is silently lost.
    const text = T_OPEN + '  \n\n  ' + T_CLOSE;
    expect(splitThinkText(text)).toEqual([{ kind: 'text', text }]);
  });
});

describe('extractReasoningParts', () => {
  it('passes non-text parts through untouched', () => {
    const tool: ShapedPart = { type: 'tool', tool: 'Bash', status: 'completed', input: { command: 'ls' }, output: 'ok' };
    const reasoning: ShapedPart = { type: 'reasoning', text: 'hmm' };
    expect(extractReasoningParts([tool, reasoning])).toEqual([tool, reasoning]);
  });

  it('leaves a plain text part unchanged', () => {
    const text: ShapedPart = { type: 'text', text: 'just text' };
    expect(extractReasoningParts([text])).toEqual([text]);
  });

  it('drops a leading empty think block, keeping the real text', () => {
    const part: ShapedPart = { type: 'text', text: T_OPEN + '\n\n' + T_CLOSE + '\n\nHello.' };
    // The empty block is dropped; the trailing text segment is kept.
    expect(extractReasoningParts([part])).toEqual([{ type: 'text', text: '\n\nHello.' }]);
  });

  it('splits a non-empty think block into reasoning + text parts', () => {
    const part: ShapedPart = { type: 'text', text: T_OPEN + 'I need to check the file.' + T_CLOSE + '\nNow let me read it.' };
    const out = extractReasoningParts([part]);
    expect(out).toEqual([
      { type: 'reasoning', text: 'I need to check the file.' },
      { type: 'text', text: '\nNow let me read it.' },
    ]);
  });

  it('preserves the order of multiple parts in a message', () => {
    const parts: ShapedPart[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: T_OPEN + 'thinking here' + T_CLOSE + 'answer' },
      { type: 'tool', tool: 'Read', status: 'completed', input: {}, output: 'x' },
      { type: 'text', text: 'last' },
    ];
    const out = extractReasoningParts(parts);
    expect(out.map((p) => p.type)).toEqual(['text', 'reasoning', 'text', 'tool', 'text']);
  });

  it('leaves a compaction summary with an embedded think tag as a single text part', () => {
    // The summary quotes the conversation, which included think tags. Those are
    // embedded mid-prose, not leading, so the whole part stays one text part.
    const part: ShapedPart = {
      type: 'text',
      text: 'This session is being continued…\n\n' + T_OPEN + '\n\n' + T_CLOSE + '\n\nSummary:\n1. Primary request…',
    };
    expect(extractReasoningParts([part])).toEqual([part]);
  });

  it('leaves a user message that quotes the think tag unchanged', () => {
    const part: ShapedPart = { type: 'text', text: "I'm still seeing " + T_OPEN + '…' + T_CLOSE + ' blocks' };
    expect(extractReasoningParts([part])).toEqual([part]);
  });

  it('caps a >256 KB plain text part (C-F4)', () => {
    const part: ShapedPart = { type: 'text', text: 'y'.repeat(300 * 1024) };
    const out = extractReasoningParts([part]);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('text');
    expect(out[0]!.text).toContain('[truncated');
    expect(Buffer.byteLength(out[0]!.text!)).toBeLessThan(256 * 1024 + 128);
  });

  it('caps a >256 KB reasoning part (C-F4)', () => {
    const part: ShapedPart = { type: 'reasoning', text: 'z'.repeat(300 * 1024) };
    const out = extractReasoningParts([part]);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('reasoning');
    expect(out[0]!.text).toContain('[truncated');
    expect(Buffer.byteLength(out[0]!.text!)).toBeLessThan(256 * 1024 + 128);
  });

  it('splits a leading think block first, then caps each segment (C-F4)', () => {
    // The block alone is >256 KB: capping before the split would truncate
    // past the closing tag (an unclosed tag degrades to plain text — the
    // wrong shape). Split first, cap the segments after.
    const part: ShapedPart = { type: 'text', text: T_OPEN + 't'.repeat(300 * 1024) + T_CLOSE + '\nHello.' };
    const out = extractReasoningParts([part]);
    expect(out.map((p) => p.type)).toEqual(['reasoning', 'text']);
    expect(out[0]!.text).toContain('[truncated');
    expect(Buffer.byteLength(out[0]!.text!)).toBeLessThan(256 * 1024 + 128);
    expect(out[1]!.text).toBe('\nHello.');
  });
});
