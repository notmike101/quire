import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import UserMessage from '../src/components/UserMessage.vue';
import ToolCard from '../src/components/ToolCard.vue';
import ReasoningBlock from '../src/components/ReasoningBlock.vue';
import ImagePart from '../src/components/ImagePart.vue';
import AssistantMessage from '../src/components/AssistantMessage.vue';
import SystemNotice from '../src/components/SystemNotice.vue';
import MessageRail from '../src/components/MessageRail.vue';
import { renderMarkdown, isSafeHref } from '../src/markdown';
import type { ShareMessage, SharePart, RailUserEntry } from '../src/api';

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

  it('drops javascript: links (Round 4)', async () => {
    const html = await renderMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<a ');
    // The label is still rendered as plain text.
    expect(html).toContain('click me');
  });

  it('drops data: and vbscript: links (Round 4)', async () => {
    const html1 = await renderMarkdown('[x](data:text/html,<script>alert(1)</script>)');
    expect(html1).not.toContain('href="data:');
    expect(html1).not.toContain('<a ');
    const html2 = await renderMarkdown('[x](vbscript:msgbox(1))');
    expect(html2).not.toContain('href="vbscript:');
    expect(html2).not.toContain('<a ');
  });

  it('keeps http/https/mailto/relative links (Round 4)', async () => {
    expect(await renderMarkdown('[a](https://example.com)')).toContain('href="https://example.com"');
    expect(await renderMarkdown('[a](http://example.com)')).toContain('href="http://example.com"');
    expect(await renderMarkdown('[a](mailto:x@example.com)')).toContain('href="mailto:x@example.com"');
    expect(await renderMarkdown('[a](/relative/path)')).toContain('href="/relative/path"');
    expect(await renderMarkdown('[a](#fragment)')).toContain('href="#fragment"');
  });

  it('drops obfuscated javascript: links (entity-encoded colon) (Round 4)', async () => {
    const html = await renderMarkdown('[x](javascript&#58;alert(1))');
    expect(html).not.toContain('<a ');
    expect(html.toLowerCase()).not.toContain('href="javascript');
  });

  it('emits no stray </a> when a link is dropped (Round 7)', async () => {
    // ftp: is allowed by markdown-it's normalizeLink but rejected by isSafeHref,
    // so the renderer drops the link. The matching </a> must be dropped too —
    // a dangling end tag is malformed markup.
    const html = await renderMarkdown('[x](ftp://example.com/f)');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('</a>');
    expect(html).toContain('x');
    // A kept link still renders its full <a>…</a> pair alongside a dropped one.
    const mixed = await renderMarkdown('[a](https://ok.example) and [b](ftp://nope.example)');
    expect(mixed.match(/<a /g) ?? []).toHaveLength(1);
    expect(mixed.match(/<\/a>/g) ?? []).toHaveLength(1);
  });

  it('drops non-data/non-asset markdown image srcs in the viewer (Round 7)', async () => {
    // An external image beacon must not become an <img> in the viewer — only
    // the CSP header used to block it. The alt text is kept as plain text.
    const html = await renderMarkdown('![x](https://evil.example/t.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('https://evil.example/t.png');
    expect(html).toContain('x');
    // A data: image (the embedded session images) is kept.
    const data = await renderMarkdown('![y](data:image/png;base64,iVBORw0KGgo=)');
    expect(data).toContain('<img');
    expect(data).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });
});

describe('isSafeHref (Round 5 guard hardening)', () => {
  it('rejects C0-control-prefixed javascript: (the trim() bypass)', () => {
    // trim() does not strip C0 controls, so the old regex saw no `scheme:`
    // prefix and classified these as "relative" (allowed). The browser strips a
    // leading C0 control before parsing, so a raw one WOULD execute as
    // javascript: — the guard must reject it on its own.
    for (const code of [1, 2, 7, 0x0e, 0x1f]) {
      expect(isSafeHref(String.fromCharCode(code) + 'javascript:alert(1)')).toBe(false);
    }
  });

  it('rejects C1/DEL control-prefixed schemes too', () => {
    expect(isSafeHref(String.fromCharCode(0x7f) + 'javascript:alert(1)')).toBe(false);
    expect(isSafeHref(String.fromCharCode(0x80) + 'javascript:alert(1)')).toBe(false);
    expect(isSafeHref(String.fromCharCode(0x9f) + 'javascript:alert(1)')).toBe(false);
  });

  it('still allows http/https/mailto and same-origin relative URLs', () => {
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('http://example.com')).toBe(true);
    expect(isSafeHref('mailto:x@example.com')).toBe(true);
    expect(isSafeHref('/relative/path')).toBe(true);
    expect(isSafeHref('./rel/path')).toBe(true);
    expect(isSafeHref('#fragment')).toBe(true);
    expect(isSafeHref('?q=1')).toBe(true);
  });

  it('still rejects other executable schemes and empty', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>')).toBe(false);
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeHref('file:///etc/passwd')).toBe(false);
    expect(isSafeHref('')).toBe(false);
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

  it('does not render an attached image with a non-data-URI src (Chain A)', async () => {
    const w = mount(ToolCard, {
      props: {
        part: {
          ...part,
          images: [{ src: 'https://evil.example/x.png', mime: 'image/png', alt: 'x', bytes: 10 }],
        },
      },
    });
    await w.find('button').trigger('click');
    expect(w.find('img').exists()).toBe(false);
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

  it('does not render an <img> for a non-data-URI src (Chain A)', () => {
    for (const src of [
      'https://evil.example/x.png',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'file:///etc/passwd',
    ]) {
      const w = mount(ImagePart, { props: { part: { type: 'image', src, mime: 'image/png', alt: 'x' } } });
      expect(w.find('img').exists()).toBe(false);
    }
  });

  it('rejects svg+xml data URIs (SMIL can execute script; never a screenshot)', () => {
    const svg = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==';
    const w = mount(ImagePart, { props: { part: { type: 'image', src: svg, mime: 'image/svg+xml', alt: 'x' } } });
    expect(w.find('img').exists()).toBe(false);
    // concrete raster types are still accepted
    const png = mount(ImagePart, { props: { part: { type: 'image', src: 'data:image/png;base64,AAA', mime: 'image/png', alt: 'x' } } });
    expect(png.find('img').exists()).toBe(true);
  });
});

// Build a full-share user index (seq + preview) plus the matching loaded
// messages. `loadedCount` controls how many user messages are actually in the
// DOM (the rest are in the index but not yet loaded — the lazy-load case).
function railFixture(userTexts: string[], loadedCount = userTexts.length) {
  const userIndex: RailUserEntry[] = [];
  const messages: ShareMessage[] = [];
  let seq = 1;
  for (const text of userTexts) {
    userIndex.push({ seq, preview: text.replace(/\s+/g, ' ').trim().slice(0, 80) });
    messages.push({ chunkSeq: 0, seq: seq++, role: 'user', time: null, parts: [{ type: 'text', text }] });
    messages.push({ chunkSeq: 0, seq: seq++, role: 'assistant', time: null, parts: [{ type: 'text', text: 'assistant reply' }] });
  }
  // Only the first `loadedCount` user messages (and their assistant replies) are
  // "loaded" — the rail still shows a tick for every entry in userIndex.
  const loaded = messages.slice(0, loadedCount * 2);
  return { userIndex, messages: loaded };
}

function railProps(fixture: ReturnType<typeof railFixture>, ensure?: (seq: number) => Promise<void>) {
  return {
    userIndex: fixture.userIndex,
    messages: fixture.messages,
    ensureLoadedThrough: ensure ?? (async () => {}),
  };
}

describe('MessageRail', () => {
  beforeEach(() => {
    ioCapture = [];
    vi.stubGlobal('IntersectionObserver', CapturingIntersectionObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders one tick per user message in the full-share index, even when not all are loaded', () => {
    const fixture = railFixture(['a', 'b', 'c'], 1); // only the first is loaded
    const w = mount(MessageRail, { props: railProps(fixture) });
    expect(w.findAll('.rail-tick')).toHaveLength(3);
  });

  it('shows the server-provided preview in the tooltip on hover', async () => {
    const fixture = railFixture(['x'.repeat(120)]);
    const w = mount(MessageRail, { props: railProps(fixture) });
    // The tooltip is rendered on hover (v-if on tipVisible).
    await (w.findAll('.rail-tick')[0] as any).trigger('mouseenter');
    await flushPromises();
    const tip = w.find('.rail-tip');
    expect(tip.exists()).toBe(true);
    expect(tip.text()).toContain('x'.repeat(80));
  });

  it('falls back to a generic label when the preview is empty', async () => {
    const fixture = railFixture(['ignored']);
    fixture.userIndex[0]!.preview = '';
    const w = mount(MessageRail, { props: railProps(fixture) });
    await (w.findAll('.rail-tick')[0] as any).trigger('mouseenter');
    await flushPromises();
    const tip = w.find('.rail-tip');
    expect(tip.exists()).toBe(true);
    expect(tip.text()).toContain('user message');
  });

  it('clicking a loaded tick scrolls to the matching user message', async () => {
    const fixture = railFixture(['first', 'second', 'third']);
    const userSeqs = fixture.userIndex.map((e) => e.seq);
    for (const seq of userSeqs) {
      document.body.insertAdjacentHTML('beforeend', `<div id="msg-${seq}"></div>`);
    }
    let scrolled: Element | null = null;
    let opts: ScrollToOptions | undefined;
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, o?: ScrollToOptions) {
      scrolled = this;
      opts = o;
    };
    const w = mount(MessageRail, { props: railProps(fixture) });
    const tick2 = w.findAll('.rail-tick')[1] as any;
    await tick2.trigger('click');
    const scrolledEl = scrolled as unknown as Element;
    expect(scrolledEl.id).toBe(`msg-${userSeqs[1]}`);
    expect(opts).toEqual({ behavior: 'smooth', block: 'start' });
    Element.prototype.scrollIntoView = orig;
    w.unmount();
    for (const seq of userSeqs) document.getElementById(`msg-${seq}`)?.remove();
  });

  it('clicking an unloaded tick loads up to it before scrolling', async () => {
    const fixture = railFixture(['first', 'second', 'third'], 1); // only #1 loaded
    const userSeqs = fixture.userIndex.map((e) => e.seq);
    // Only the first message's anchor exists initially.
    document.body.insertAdjacentHTML('beforeend', `<div id="msg-${userSeqs[0]}"></div>`);
    const ensureCalls: number[] = [];
    const ensure = vi.fn(async (seq: number) => {
      ensureCalls.push(seq);
      // Simulate the page loading: add the anchor for the target message.
      document.body.insertAdjacentHTML('beforeend', `<div id="msg-${seq}"></div>`);
    });
    let scrolled: Element | null = null;
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled = this;
    };
    const w = mount(MessageRail, { props: railProps(fixture, ensure) });
    const tick3 = w.findAll('.rail-tick')[2] as any;
    await tick3.trigger('click');
    await flushPromises();
    expect(ensure).toHaveBeenCalledWith(userSeqs[2]);
    expect(ensureCalls).toEqual([userSeqs[2]]);
    expect((scrolled as unknown as Element).id).toBe(`msg-${userSeqs[2]}`);
    Element.prototype.scrollIntoView = orig;
    w.unmount();
    for (const seq of userSeqs) document.getElementById(`msg-${seq}`)?.remove();
  });

  it('marks the tick active when its message enters the observer band', async () => {
    const fixture = railFixture(['first', 'second', 'third']);
    const userSeqs = fixture.userIndex.map((e) => e.seq);
    for (const seq of userSeqs) {
      document.body.insertAdjacentHTML('beforeend', `<div id="msg-${seq}"></div>`);
    }
    const w = mount(MessageRail, { props: railProps(fixture) });
    await flushPromises();
    const ticks = w.findAll('.rail-tick');
    expect(ioCapture.length).toBeGreaterThan(0);
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

  it('renders nothing when the user index is empty', () => {
    const w = mount(MessageRail, {
      props: railProps({ userIndex: [], messages: [] }),
    });
    expect(w.find('.rail-tick').exists()).toBe(false);
    expect(w.find('.rail-col').exists()).toBe(false);
  });
});
