import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { Blob as NodeBlob } from 'node:buffer';
import { SHARE_PROTOCOL } from '@quire/protocol';
import App from '../src/App.vue';
import { mockFetch, seal, TEST_FRAGMENT, TEST_KEY, type V2Route } from './v2-helpers';

// jsdom's Blob lacks .stream() and corrupts bytes through undici's Response;
// the v2 gunzip path (share-v2/crypto.ts) needs a spec-compliant Blob.
globalThis.Blob = NodeBlob as typeof Blob;

class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const SHARE_ID = 'testtoken';

const META = {
  title: 'Test Session',
  model: 'gpt-x',
  provider: 'openai',
  createdAt: '2026-08-20T00:00:00.000Z',
  expiresAt: null,
  messageCount: 2,
  redactions: { 'api-key': 1 },
};

const MESSAGES = [
  { chunkSeq: 0, seq: 1, role: 'user', time: null, parts: [{ type: 'text', text: 'hello from user' }] },
  { chunkSeq: 0, seq: 2, role: 'assistant', time: null, parts: [{ type: 'text', text: 'hi there' }] },
];
const USER_INDEX = [{ chunkSeq: 0, seq: 1, preview: 'hello from user' }];

async function v2Routes(messages: object[], userIndex: object[]): Promise<Record<string, V2Route>> {
  const base = `/api/v2/public/shares/${SHARE_ID}`;
  return {
    [`${base}/bootstrap`]: { status: 200, body: {} },
    [`${base}/blobs/manifest/0`]: { status: 200, blob: await seal(SHARE_ID, TEST_KEY, 'manifest', 0, { protocol: SHARE_PROTOCOL, shareId: SHARE_ID, ...META, pageCount: 1 }) },
    [`${base}/blobs/index/0`]: { status: 200, blob: await seal(SHARE_ID, TEST_KEY, 'index', 0, { protocol: SHARE_PROTOCOL, shareId: SHARE_ID, seq: 0, entries: userIndex }) },
    [`${base}/blobs/page/0`]: { status: 200, blob: await seal(SHARE_ID, TEST_KEY, 'page', 0, { protocol: SHARE_PROTOCOL, shareId: SHARE_ID, seq: 0, messages }) },
  };
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  window.history.pushState({}, '', `/chats/${SHARE_ID}#${TEST_FRAGMENT}`);
});

afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('renders a loaded share with header, badge, and messages', async () => {
    mockFetch(await v2Routes(MESSAGES, USER_INDEX));
    const w = mount(App);
    await flushPromises();
    await vi.waitFor(() => {
      expect(w.text()).toContain('Test Session');
    });
    expect(w.text()).toContain('gpt-x');
    expect(w.text()).toContain('1 redacted');
    expect(w.html()).toContain('hello from user');
  });

  it('shows the password gate when the share is protected', async () => {
    mockFetch({
      [`/api/v2/public/shares/${SHARE_ID}/bootstrap`]: { status: 401, body: { error: { code: 'needs_password', message: 'This share is password protected' } } },
    });
    const w = mount(App);
    await flushPromises();
    expect(w.text()).toContain('Password required');
  });

  it('shows the missing-key error when the URL has no content-key fragment', async () => {
    window.history.pushState({}, '', `/chats/${SHARE_ID}`);
    const fetchMock = mockFetch({});
    const w = mount(App);
    await flushPromises();
    expect(w.text()).toContain('This link is missing its content key.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the message rail with one tick per user message', async () => {
    mockFetch(await v2Routes(MESSAGES, USER_INDEX));
    const w = mount(App);
    await flushPromises();
    // MESSAGES has one user message (seq 1) and one assistant message.
    await vi.waitFor(() => {
      expect(w.find('.rail-col').exists()).toBe(true);
    });
    expect(w.findAll('.rail-tick')).toHaveLength(1);
    // The user message is wrapped in a jump target the rail can resolve.
    expect(w.find('#msg-0-1').exists()).toBe(true);
  });

  it('renders distinct anchors for duplicate seq values across chunks', async () => {
    const chunkedMessages = [
      { chunkSeq: 0, seq: 1, role: 'user', time: null, parts: [{ type: 'text', text: 'first chunk' }] },
      { chunkSeq: 1, seq: 1, role: 'user', time: null, parts: [{ type: 'text', text: 'later chunk' }] },
    ];
    const chunkedIndex = [
      { chunkSeq: 0, seq: 1, preview: 'first chunk' },
      { chunkSeq: 1, seq: 1, preview: 'later chunk' },
    ];
    mockFetch(await v2Routes(chunkedMessages, chunkedIndex));
    const w = mount(App);
    await flushPromises();
    await vi.waitFor(() => {
      expect(w.findAll('.msg-target')).toHaveLength(2);
    });
    expect(w.find('#msg-0-1').exists()).toBe(true);
    expect(w.find('#msg-1-1').exists()).toBe(true);
    expect(w.findAll('.rail-tick')).toHaveLength(2);
  });

  it('omits the rail when the share has no user messages', async () => {
    const assistantOnly = [{ chunkSeq: 0, seq: 1, role: 'assistant', time: null, parts: [{ type: 'text', text: 'hi there' }] }];
    mockFetch(await v2Routes(assistantOnly, []));
    const w = mount(App);
    await flushPromises();
    await vi.waitFor(() => {
      expect(w.text()).toContain('hi there');
    });
    expect(w.find('.rail-col').exists()).toBe(false);
    expect(w.findAll('.rail-tick')).toHaveLength(0);
  });
});
