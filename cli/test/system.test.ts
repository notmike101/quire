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

  it('splits a mixed part into text + system + text in order', () => {
    const text = 'Real user text here.\n<system-reminder>\nreminder body\n</system-reminder>\nTrailing text.';
    const segs = splitSystemText(text);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'system', 'text']);
    expect(segs[0]!.text).toBe('Real user text here.\n');
    expect(segs[1]!.text).toBe('\nreminder body\n');
    expect(segs[2]!.text).toBe('\nTrailing text.');
  });

  it('handles multiple reminder blocks in one part', () => {
    const text = '<system-reminder>a</system-reminder>middle<system-reminder>b</system-reminder>';
    const segs = splitSystemText(text);
    expect(segs.map((s) => s.kind)).toEqual(['system', 'text', 'system']);
    expect(segs[0]!.text).toBe('a');
    expect(segs[1]!.text).toBe('middle');
    expect(segs[2]!.text).toBe('b');
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

  it('splits a mixed part into text and system parts in order', () => {
    const part: ShapedPart = { type: 'text', text: 'user said hi\n<system-reminder>\nnote\n</system-reminder>' };
    expect(extractSystemParts([part])).toEqual([
      { type: 'text', text: 'user said hi\n' },
      { type: 'system', text: '\nnote\n' },
    ]);
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

  it('splits a mixed part into text + reasoning + text in order', () => {
    const text = 'Preamble.\n' + T_OPEN + 'real thinking here' + T_CLOSE + '\nTrailing.';
    const segs = splitThinkText(text);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'reasoning', 'text']);
    expect(segs[0]!.text).toBe('Preamble.\n');
    expect(segs[1]!.text).toBe('real thinking here');
    expect(segs[2]!.text).toBe('\nTrailing.');
  });

  it('handles multiple think blocks, dropping empty ones', () => {
    const text = 'a' + T_OPEN + 'x' + T_CLOSE + 'b' + T_OPEN + ' ' + T_CLOSE + 'c';
    const segs = splitThinkText(text);
    // The second block is whitespace-only and dropped, so 'b' and 'c' stay
    // separate text segments.
    expect(segs.map((s) => s.kind)).toEqual(['text', 'reasoning', 'text', 'text']);
    expect(segs[0]!.text).toBe('a');
    expect(segs[1]!.text).toBe('x');
    expect(segs[2]!.text).toBe('b');
    expect(segs[3]!.text).toBe('c');
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
});
