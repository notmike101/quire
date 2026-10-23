import { ref } from 'vue';
import { ShareError, type MessageIdentity, type ShareMeta, type ShareMessage, type RailUserEntry } from '../api';
import type { ShareDataSource } from '../share-data-source';

export type LoadState = 'loading' | 'ready' | 'needs_password' | 'expired' | 'not_found' | 'error';

/**
 * Manage transcript pagination, access states, and password submission.
 *
 * @param source - Share transport and decryption implementation.
 * @returns Reactive viewer state and actions for loading or unlocking the share.
 */
export function useMessages(source: ShareDataSource) {
  const state = ref<LoadState>('loading');
  const meta = ref<ShareMeta | null>(null);
  const messages = ref<ShareMessage[]>([]);
  // Full-share user-message index for the rail (identity + preview), fetched once on
  // the first page. The rail renders one tick per entry, so all ticks are
  // present even though the messages themselves lazy-load.
  const userIndex = ref<RailUserEntry[]>([]);
  const loadingMore = ref(false);
  const errorMessage = ref('');
  const passwordError = ref('');

  let nextCursor: string | null = null;
  let exhausted = false;

  /** Replace the transcript with its first page and map failures to viewer states. */
  async function loadFirst(): Promise<void> {
    state.value = 'loading';
    passwordError.value = '';
    const page = await source.loadFirst();
    if (page instanceof ShareError) {
      if (page.code === 'needs_password') { state.value = 'needs_password'; return; }
      if (page.code === 'expired') { state.value = 'expired'; return; }
      if (page.code === 'not_found') { state.value = 'not_found'; return; }
      errorMessage.value =
        page.code === 'rate_limited' ? 'Too many requests. Wait a minute and reload.' : page.message;
      state.value = 'error';
      return;
    }
    meta.value = page.meta;
    messages.value = page.messages;
    userIndex.value = page.userIndex ?? [];
    nextCursor = page.nextCursor;
    exhausted = page.nextCursor === null;
    state.value = 'ready';
  }

  /** Append the next page unless pagination is exhausted or already in progress. */
  async function loadMore(): Promise<void> {
    if (exhausted || loadingMore.value || nextCursor === null) return;
    loadingMore.value = true;
    const page = await source.loadNext(nextCursor);
    if (page instanceof ShareError) {
      errorMessage.value = page.message;
    } else {
      messages.value = [...messages.value, ...page.messages];
      nextCursor = page.nextCursor;
      exhausted = page.nextCursor === null;
    }
    loadingMore.value = false;
  }

  /**
   * Fetch intervening pages until a rail target is loaded or loading cannot continue.
   *
   * @param target - Composite identity of the message to reveal.
   */
  async function ensureLoadedThrough(target: MessageIdentity): Promise<void> {
    while (
      !messages.value.some((m) => m.chunkSeq === target.chunkSeq && m.seq === target.seq) &&
      nextCursor !== null &&
      !exhausted
    ) {
      const page = await source.loadNext(nextCursor);
      if (page instanceof ShareError) break;
      messages.value = [...messages.value, ...page.messages];
      nextCursor = page.nextCursor;
      exhausted = page.nextCursor === null;
    }
  }

  /**
   * Unlock the share and reload it, exposing a reader-friendly error on failure.
   *
   * @param password - Password entered in the access gate.
   */
  async function submitPassword(password: string): Promise<void> {
    passwordError.value = '';
    try {
      await source.unlock(password);
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
