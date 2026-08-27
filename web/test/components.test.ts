import { describe, it, expect } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import UserMessage from '../src/components/UserMessage.vue';
import ToolCard from '../src/components/ToolCard.vue';
import ReasoningBlock from '../src/components/ReasoningBlock.vue';
import AssistantMessage from '../src/components/AssistantMessage.vue';
import SystemNotice from '../src/components/SystemNotice.vue';
import { renderMarkdown } from '../src/markdown';
import type { ShareMessage, SharePart } from '../src/api';

describe('renderMarkdown', () => {
  it('renders markdown and highlights fenced code with shiki', async () => {
    const html = await renderMarkdown('Hello **world**\n\n```ts\nconst x = 1;\n```');
    expect(html).toContain('<strong>world</strong>');
    expect(html).toContain('shiki');
  });

  it('escapes raw html from session content', async () => {
    const html = await renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('UserMessage', () => {
  it('renders text parts in a bubble', () => {
    const w = mount(UserMessage, { props: { parts: [{ type: 'text', text: 'hello from user' }] } });
    expect(w.text()).toContain('hello from user');
  });

  it('renders a system part as a collapsed notice, not a bubble', async () => {
    const w = mount(UserMessage, {
      props: {
        parts: [
          { type: 'text', text: 'real user text' },
          { type: 'system', text: 'Continue working toward the active session goal.\nobjective body' },
        ],
      },
    });
    expect(w.text()).toContain('real user text');
    // The notice chip is collapsed by default: its label shows, the body does not.
    expect(w.text()).toContain('goal continuation');
    expect(w.text()).not.toContain('objective body');
    await w.find('button').trigger('click');
    expect(w.text()).toContain('objective body');
  });
});

describe('SystemNotice', () => {
  it('is collapsed by default and expands on click', async () => {
    const w = mount(SystemNotice, { props: { text: 'hidden harness note' } });
    expect(w.text()).not.toContain('hidden harness note');
    await w.find('button').trigger('click');
    expect(w.text()).toContain('hidden harness note');
  });

  it('labels goal-continuation reminders', () => {
    const w = mount(SystemNotice, { props: { text: 'Continue working toward the active session goal.' } });
    expect(w.text()).toContain('goal continuation');
  });

  it('falls back to a generic label', () => {
    const w = mount(SystemNotice, { props: { text: 'some other note' } });
    expect(w.text()).toContain('system reminder');
  });
});

describe('ToolCard', () => {
  const part: SharePart = { type: 'tool', tool: 'Bash', status: 'completed', input: { command: 'ls' }, output: 'file1\nfile2' };

  it('is collapsed by default and expands on click', async () => {
    const w = mount(ToolCard, { props: { part: { ...part } } });
    expect(w.text()).toContain('Bash');
    expect(w.text()).toContain('completed');
    expect(w.text()).not.toContain('file1');
    await w.find('button').trigger('click');
    expect(w.text()).toContain('file1');
  });

  it('shows an error chip for failed tools', () => {
    const w = mount(ToolCard, { props: { part: { ...part, status: 'error' } } });
    expect(w.find('span.rounded-full').classes()).toContain('bg-red-100');
  });
});

describe('ReasoningBlock', () => {
  it('toggles the hidden reasoning text', async () => {
    const w = mount(ReasoningBlock, { props: { text: 'inner monologue' } });
    expect(w.text()).not.toContain('inner monologue');
    await w.find('button').trigger('click');
    expect(w.text()).toContain('inner monologue');
  });
});

describe('AssistantMessage', () => {
  it('renders text parts as markdown and tool parts as cards', async () => {
    const message: ShareMessage = {
      chunkSeq: 0,
      seq: 1,
      role: 'assistant',
      time: null,
      parts: [
        { type: 'text', text: 'Here is some **bold** text.' },
        { type: 'tool', tool: 'Read', status: 'completed', input: { path: '/x' }, output: 'ok' },
      ],
    };
    const w = mount(AssistantMessage, { props: { message } });
    await flushPromises();
    expect(w.html()).toContain('<strong>bold</strong>');
    expect(w.text()).toContain('Read');
  });

  it('renders a system part as a collapsed notice', async () => {
    const message: ShareMessage = {
      chunkSeq: 0,
      seq: 2,
      role: 'assistant',
      time: null,
      parts: [{ type: 'system', text: 'Continue working toward the active session goal.\nhidden body' }],
    };
    const w = mount(AssistantMessage, { props: { message } });
    await flushPromises();
    expect(w.text()).toContain('goal continuation');
    expect(w.text()).not.toContain('hidden body');
  });

  it('renders a reasoning part as a collapsed thinking chip', async () => {
    const message: ShareMessage = {
      chunkSeq: 0,
      seq: 3,
      role: 'assistant',
      time: null,
      parts: [{ type: 'reasoning', text: 'let me think about this carefully' }],
    };
    const w = mount(AssistantMessage, { props: { message } });
    await flushPromises();
    // The chip is collapsed by default: the label shows, the body does not.
    expect(w.text()).toContain('thinking');
    expect(w.text()).not.toContain('let me think about this carefully');
    await w.find('button').trigger('click');
    expect(w.text()).toContain('let me think about this carefully');
  });
});
