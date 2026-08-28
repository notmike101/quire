import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import UserMessage from '../src/components/UserMessage.vue';
import ToolCard from '../src/components/ToolCard.vue';
import ReasoningBlock from '../src/components/ReasoningBlock.vue';
import ImagePart from '../src/components/ImagePart.vue';
import AssistantMessage from '../src/components/AssistantMessage.vue';
import SystemNotice from '../src/components/SystemNotice.vue';
import MessageRail from '../src/components/MessageRail.vue';
import { renderMarkdown } from '../src/markdown';
import type { ShareMessage, SharePart } from '../src/api';

// Capturing IntersectionObserver: records every constructed instance so a
// test can fire its callback against real (stubbed) entries.
let ioCapture: unknown[] = [];
class CapturingIntersectionObserver {
  readonly cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    ioCapture.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

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

  it('renders attached images inside the collapsible body', async () => {
    const dataUri = 'data:image/png;base64,AAA';
    const w = mount(ToolCard, {
      props: {
        part: {
          ...part,
          images: [{ src: dataUri, mime: 'image/png', alt: 'Read image', bytes: 68 }],
        },
      },
    });
    // Collapsed by default: the image count badge shows, the <img> does not.
    expect(w.text()).toContain('1 image');
    expect(w.find('img').exists()).toBe(false);
    // Expanding reveals the image.
    await w.find('button').trigger('click');
    const img = w.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe(dataUri);
    expect(img.attributes('alt')).toBe('Read image');
  });

  it('shows a placeholder for tooLarge attached images', async () => {
    const w = mount(ToolCard, {
      props: {
        part: {
          ...part,
          images: [{ mime: 'image/png', alt: 'big', bytes: 3_000_000, tooLarge: true }],
        },
      },
    });
    await w.find('button').trigger('click');
    expect(w.find('img').exists()).toBe(false);
    expect(w.text()).toContain('image too large to embed');
    expect(w.text()).toContain('2.9 MB');
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

  it('renders an image part as an <img> with the data URI', async () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo';
    const message: ShareMessage = {
      chunkSeq: 0,
      seq: 4,
      role: 'assistant',
      time: null,
      parts: [{ type: 'image', src: dataUri, mime: 'image/png', alt: 'screenshot', bytes: 68 }],
    };
    const w = mount(AssistantMessage, { props: { message } });
    await flushPromises();
    const img = w.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe(dataUri);
    expect(img.attributes('alt')).toBe('screenshot');
  });
});

describe('ImagePart', () => {
  it('renders an <img> when src is present', () => {
    const w = mount(ImagePart, { props: { part: { type: 'image', src: 'data:image/png;base64,AAA', mime: 'image/png', alt: 'shot' } } });
    const img = w.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('data:image/png;base64,AAA');
  });

  it('renders a placeholder chip when tooLarge (no src)', () => {
    const w = mount(ImagePart, { props: { part: { type: 'image', mime: 'image/png', alt: 'big', bytes: 3_000_000, tooLarge: true } } });
    expect(w.find('img').exists()).toBe(false);
    expect(w.text()).toContain('image too large to embed');
    expect(w.text()).toContain('2.9 MB');
  });
});

function railMessages(userTexts: string[], withSystemOnly = false): ShareMessage[] {
  const msgs: ShareMessage[] = [];
  let seq = 1;
  for (const text of userTexts) {
    msgs.push({
      chunkSeq: 0,
      seq: seq++,
      role: 'user',
      time: null,
      parts: withSystemOnly
        ? [{ type: 'system', text: 'Continue working toward the active session goal.' }]
        : [{ type: 'text', text }],
    });
    msgs.push({
      chunkSeq: 0,
      seq: seq++,
      role: 'assistant',
      time: null,
      parts: [{ type: 'text', text: 'assistant reply' }],
    });
  }
  return msgs;
}

describe('MessageRail', () => {
  beforeEach(() => {
    ioCapture = [];
    vi.stubGlobal('IntersectionObserver', CapturingIntersectionObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders one tick per user message, not per assistant message', () => {
    const w = mount(MessageRail, { props: { messages: railMessages(['a', 'b', 'c']) } });
    expect(w.findAll('.rail-tick')).toHaveLength(3);
  });

  it('truncates the preview to 80 chars and collapses whitespace', () => {
    const long = 'x'.repeat(120);
    const w = mount(MessageRail, { props: { messages: railMessages([long]) } });
    const tip = w.find('.rail-tip');
    expect(tip.text()).toContain('x'.repeat(80) + '…');
    expect(tip.text()).not.toContain('x'.repeat(81));
    // Whitespace collapsed: "a   b" -> "a b"
    const w2 = mount(MessageRail, { props: { messages: railMessages(['a   b\n\nc']) } });
    expect(w2.find('.rail-tip').text()).toContain('a b c');
  });

  it('falls back to a generic label when the user message has no text part', () => {
    const w = mount(MessageRail, { props: { messages: railMessages(['ignored'], true) } });
    expect(w.find('.rail-tip').text()).toContain('user message');
  });

  it('clicking a tick scrolls to the matching user message', async () => {
    const msgs = railMessages(['first', 'second', 'third']);
    const userSeqs = msgs.filter((m) => m.role === 'user').map((m) => m.seq);
    for (const seq of userSeqs) {
      document.body.insertAdjacentHTML('beforeend', `<div id="msg-${seq}"></div>`);
    }
    // jsdom does not implement scrollIntoView; capture the element (the `this`
    // of the call) and the options argument.
    let scrolled: Element | null = null;
    let opts: ScrollToOptions | undefined;
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, o?: ScrollToOptions) {
      scrolled = this;
      opts = o;
    };
    const w = mount(MessageRail, { props: { messages: msgs } });
    const tick2 = w.findAll('.rail-tick')[1] as any;
    await tick2.trigger('click');
    // The scrolled element is the second user message's jump target.
    const scrolledEl = scrolled as unknown as Element;
    expect(scrolledEl.id).toBe(`msg-${userSeqs[1]}`);
    expect(opts).toEqual({ behavior: 'smooth', block: 'start' });
    Element.prototype.scrollIntoView = orig;
    w.unmount();
    for (const seq of userSeqs) document.getElementById(`msg-${seq}`)?.remove();
  });

  it('marks the tick active when its message enters the observer band', async () => {
    const msgs = railMessages(['first', 'second', 'third']);
    const userSeqs = msgs.filter((m) => m.role === 'user').map((m) => m.seq);
    for (const seq of userSeqs) {
      document.body.insertAdjacentHTML('beforeend', `<div id="msg-${seq}"></div>`);
    }
    const w = mount(MessageRail, { props: { messages: msgs } });
    await flushPromises();
    const ticks = w.findAll('.rail-tick');
    expect(ioCapture.length).toBeGreaterThan(0);
    // Fire the observer callback for the third user message.
    const entry = {
      isIntersecting: true,
      target: document.getElementById(`msg-${userSeqs[2]}`),
    } as unknown as IntersectionObserverEntry;
    const io = ioCapture[ioCapture.length - 1] as { cb: IntersectionObserverCallback };
    io.cb([entry], {} as unknown as IntersectionObserver);
    await flushPromises();
    expect((ticks[2] as any).classes()).toContain('active');
    expect((ticks[0] as any).classes()).not.toContain('active');
    w.unmount();
    for (const seq of userSeqs) document.getElementById(`msg-${seq}`)?.remove();
  });

  it('renders nothing when there are no user messages', () => {
    const w = mount(MessageRail, {
      props: { messages: [{ chunkSeq: 0, seq: 1, role: 'assistant', time: null, parts: [{ type: 'text', text: 'hi' }] }] },
    });
    expect(w.find('.rail-tick').exists()).toBe(false);
    expect(w.find('.rail-col').exists()).toBe(false);
  });
});
