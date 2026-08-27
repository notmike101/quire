import { describe, it, expect } from 'vitest';
import { splitSystemText, systemLabel, extractSystemParts } from '../src/system.js';
import type { ShapedPart } from '../src/harness/types.js';

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
});
