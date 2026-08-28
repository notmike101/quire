import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../src/App.vue';

class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const PAGE = {
  meta: {
    title: 'Test Session',
    model: 'gpt-x',
    provider: 'openai',
    createdAt: '2026-08-20T00:00:00.000Z',
    expiresAt: null,
    messageCount: 2,
    redactions: { "api-key": 1 },
  },
  messages: [
    { seq: 1, role: 'user', time: null, parts: [{ type: 'text', text: 'hello from user' }] },
    { seq: 2, role: 'assistant', time: null, parts: [{ type: 'text', text: 'hi there' }] },
  ],
  nextCursor: null,
};

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  window.history.pushState({}, '', '/chats/testtoken');
});

afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('renders a loaded share with header, badge, and messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify(PAGE),
    })));
    const w = mount(App);
    await flushPromises();
    expect(w.text()).toContain('Test Session');
    expect(w.text()).toContain('gpt-x');
    expect(w.text()).toContain('1 redacted');
    expect(w.html()).toContain('hello from user');
  });

  it('shows the password gate when the share is protected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401,
      text: async () => JSON.stringify({ error: { code: 'needs_password', message: 'This share is password protected' } }),
    })));
    const w = mount(App);
    await flushPromises();
    expect(w.text()).toContain('Password required');
  });

  it('renders the message rail with one tick per user message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify(PAGE),
    })));
    const w = mount(App);
    await flushPromises();
    // PAGE has one user message (seq 1) and one assistant message.
    expect(w.find('.rail-col').exists()).toBe(true);
    expect(w.findAll('.rail-tick')).toHaveLength(1);
    // The user message is wrapped in a jump target the rail can resolve.
    expect(w.find('#msg-1').exists()).toBe(true);
  });

  it('omits the rail when the share has no user messages', async () => {
    const assistantOnly = { ...PAGE, messages: [
      { seq: 1, role: 'assistant', time: null, parts: [{ type: 'text', text: 'hi there' }] },
    ] };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify(assistantOnly),
    })));
    const w = mount(App);
    await flushPromises();
    expect(w.find('.rail-col').exists()).toBe(false);
    expect(w.findAll('.rail-tick')).toHaveLength(0);
  });
});
