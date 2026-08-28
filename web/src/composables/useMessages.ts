import { ref } from 'vue';
import { shareApi, ShareError, type ShareMeta, type ShareMessage, type RailUserEntry } from '../api';

export type LoadState = 'loading' | 'ready' | 'needs_password' | 'expired' | 'not_found' | 'error';

const PAGE_SIZE = 50;

export function useMessages(token: string) {
  const api = shareApi(token);
  const state = ref<LoadState>('loading');
  const meta = ref<ShareMeta | null>(null);
  const messages = ref<ShareMessage[]>([]);
  // Full-share user-message index for the rail (seq + preview), fetched once on
  // the first page. The rail renders one tick per entry, so all ticks are
  // present even though the messages themselves lazy-load.
  const userIndex = ref<RailUserEntry[]>([]);
  const loadingMore = ref(false);
  const errorMessage = ref('');
  const passwordError = ref('');

  let nextCursor: string | null = null;
  let exhausted = false;

  async function loadFirst(): Promise<void> {
    state.value = 'loading';
    passwordError.value = '';
    try {
      const page = await api.page(PAGE_SIZE);
      meta.value = page.meta;
      messages.value = page.messages;
      userIndex.value = page.userIndex ?? [];
      nextCursor = page.nextCursor;
      exhausted = page.nextCursor === null;
      state.value = 'ready';
    } catch (err) {
      if (err instanceof ShareError) {
        if (err.code === 'needs_password') { state.value = 'needs_password'; return; }
        if (err.code === 'expired') { state.value = 'expired'; return; }
        if (err.code === 'not_found') { state.value = 'not_found'; return; }
        errorMessage.value =
          err.code === 'rate_limited' ? 'Too many requests. Wait a minute and reload.' : err.message;
      } else {
        errorMessage.value = 'Something went wrong loading this share.';
      }
      state.value = 'error';
    }
  }

  async function loadMore(): Promise<void> {
    if (exhausted || loadingMore.value || nextCursor === null) return;
    loadingMore.value = true;
    try {
      const page = await api.page(PAGE_SIZE, nextCursor);
      messages.value = [...messages.value, ...page.messages];
      nextCursor = page.nextCursor;
      exhausted = page.nextCursor === null;
    } catch (err) {
      errorMessage.value = err instanceof ShareError ? err.message : 'Failed to load more messages.';
    } finally {
      loadingMore.value = false;
    }
  }

  // Load pages until the message with the given seq is present (or the share is
  // exhausted). Used by the rail: clicking a tick whose message hasn't loaded
  // yet fetches the intervening pages first, then the caller scrolls to it.
  async function ensureLoadedThrough(seq: number): Promise<void> {
    while (
      !messages.value.some((m) => m.seq === seq) &&
      nextCursor !== null &&
      !exhausted
    ) {
      const page = await api.page(PAGE_SIZE, nextCursor);
      messages.value = [...messages.value, ...page.messages];
      nextCursor = page.nextCursor;
      exhausted = page.nextCursor === null;
    }
  }

  async function submitPassword(password: string): Promise<void> {
    passwordError.value = '';
    try {
      await api.unlock(password);
      await loadFirst();
    } catch (err) {
      if (err instanceof ShareError && err.code === 'bad_password') {
        passwordError.value = 'Wrong password.';
      } else if (err instanceof ShareError && err.code === 'rate_limited') {
        passwordError.value = 'Too many attempts. Try again in a few minutes.';
      } else if (err instanceof ShareError) {
        passwordError.value = err.message;
      } else {
        passwordError.value = 'Unlock failed. Check your connection and try again.';
      }
    }
  }

  return { state, meta, messages, userIndex, loadingMore, errorMessage, passwordError, loadFirst, loadMore, ensureLoadedThrough, submitPassword };
}
