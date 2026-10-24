<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useMessages } from './composables/useMessages';
import { messageAnchorId, type ShareMessage, type SharePart } from './api';
import { createDataSource } from './share-data-source';
import UserMessage from './components/UserMessage.vue';
import AssistantMessage from './components/AssistantMessage.vue';
import PasswordGate from './components/PasswordGate.vue';
import ExpiredPage from './components/ExpiredPage.vue';
import NotFoundPage from './components/NotFoundPage.vue';
import ErrorPage from './components/ErrorPage.vue';
import LoadingSkeleton from './components/LoadingSkeleton.vue';
import MessageRail from './components/MessageRail.vue';

const shareId = window.location.pathname.split('/').filter(Boolean).pop() ?? '';
const fragment = window.location.hash.replace(/^#/, '');
const { state, meta, messages, userIndex, loadingMore, errorMessage, passwordError, loadFirst, loadMore, ensureLoadedThrough, submitPassword } =
  useMessages(createDataSource(shareId, fragment));

// Assistant message boundaries are harness storage details, not activity boundaries.
// Pages append immutable source messages. Retain completed runs so their parts
// identity does not retrigger AssistantMessage's Markdown/Shiki watcher.
let groupedSource: ShareMessage[] = [];
const displayMessages = computed<ShareMessage[]>((previous) => {
  const source = messages.value;
  const appended = previous !== undefined && groupedSource.length <= source.length
    && groupedSource.every((message, i) => message === source[i]);
  const out: ShareMessage[] = appended ? [...previous] : [];
  for (let i = appended ? groupedSource.length : 0; i < source.length; i++) {
    const message = source[i]!;
    let last = out[out.length - 1];
    if (last?.role === 'assistant' && message.role === 'assistant') {
      // Copy the trailing run once before extending it; never mutate prior props.
      if (last === previous?.[previous.length - 1]) {
        last = { ...last, parts: [...last.parts] };
        out[out.length - 1] = last;
      }
      for (const part of message.parts) last.parts.push(part);
    } else {
      out.push(message.role === 'assistant' ? { ...message, parts: [...message.parts] } : message);
    }
  }
  groupedSource = source;
  return out;
});

const sentinel = ref<HTMLElement | null>(null);
const observer = new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting)) void loadMore();
  },
  { rootMargin: '400px' },
);

// The sentinel only exists once the share is ready; attach after render.
watch(state, async (s) => {
  if (s === 'ready') {
    await nextTick();
    if (sentinel.value) observer.observe(sentinel.value);
  }
});

onMounted(() => void loadFirst());
onBeforeUnmount(() => observer.disconnect());

/**
 * Format share timestamps using the reader's locale.
 *
 * @param iso - ISO timestamp from share metadata.
 * @returns Date with year, abbreviated month, and day.
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Select the parts that belong in a user-message bubble.
 *
 * @param message - User message to render.
 * @returns Text and system parts, excluding tool, reasoning, and image parts.
 */
function userParts(message: ShareMessage): SharePart[] {
  // Text and system parts render in the bubble column; tool/reasoning parts
  // don't appear on user messages in practice, but filter to be safe.
  return message.parts.filter((p) => p.type === 'text' || p.type === 'system');
}
</script>

<template>
  <div class="app-shell">
    <template v-if="state === 'loading'">
      <LoadingSkeleton />
    </template>
    <template v-else-if="state === 'needs_password'">
      <PasswordGate :error="passwordError" @unlock="submitPassword" />
    </template>
    <template v-else-if="state === 'expired'">
      <ExpiredPage />
    </template>
    <template v-else-if="state === 'not_found'">
      <NotFoundPage />
    </template>
    <template v-else-if="state === 'error'">
      <ErrorPage :message="errorMessage" />
    </template>
    <template v-else>
      <header class="share-header">
        <h1 class="share-title">{{ meta?.title ?? 'Shared session' }}</h1>
        <div class="share-meta">
          <span v-if="meta?.model" class="meta-chip">
            {{ meta.model }}
          </span>
          <span v-if="meta?.provider">{{ meta.provider }}</span>
          <span>{{ formatDate(meta?.createdAt ?? new Date().toISOString()) }}</span>
          <span v-if="meta?.expiresAt" class="meta-expires">
            expires {{ formatDate(meta.expiresAt) }}
          </span>
          <span
            v-if="Object.values(meta?.redactions ?? {}).reduce((a, b) => a + b, 0) > 0"
            class="meta-redacted"
          >{{ Object.values(meta?.redactions ?? {}).reduce((a, b) => a + b, 0) }} redacted</span>
        </div>
      </header>
      <div class="content-wrap">
        <MessageRail :user-index="userIndex" :messages="messages" :ensure-loaded-through="ensureLoadedThrough" />
        <main class="msg-col">
          <template v-for="message in displayMessages" :key="messageAnchorId(message)">
            <div v-if="message.role === 'user'" :id="messageAnchorId(message)" class="msg-target">
              <UserMessage :parts="userParts(message)" />
            </div>
            <AssistantMessage v-else :message="message" />
          </template>
        <div v-if="loadingMore" class="feed-note">Loading more…</div>
        <div v-else-if="messages.length === 0" class="feed-note feed-note-empty">
          This session has no shareable messages.
        </div>
        <div ref="sentinel" class="sentinel" />
        </main>
      </div>
    </template>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  background-color: var(--color-white);
  color: var(--color-neutral-900);
}
@media (prefers-color-scheme: dark) {
  .app-shell {
    background-color: var(--color-neutral-950);
    color: var(--color-neutral-100);
  }
}
.share-header {
  margin-inline: auto;
  width: 100%;
  max-width: 760px;
  padding-inline: 1rem;
  padding-block-end: 1.5rem;
  padding-top: 2.5rem;
}
.share-title {
  font-size: 1.25rem;
  line-height: calc(1.75 / 1.25);
  font-weight: 600;
}
.share-meta {
  margin-top: 0.5rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  line-height: var(--lh-xs);
  color: var(--color-neutral-500);
}
@media (prefers-color-scheme: dark) {
  .share-meta {
    color: var(--color-neutral-400);
  }
}
.meta-chip {
  border-radius: 2147483647px;
  border: 1px solid var(--color-neutral-200);
  padding-inline: 0.5rem;
  padding-block: 0.125rem;
}
@media (prefers-color-scheme: dark) {
  .meta-chip {
    border-color: var(--color-neutral-800);
  }
}
.meta-expires {
  color: var(--color-amber-600);
}
@media (prefers-color-scheme: dark) {
  .meta-expires {
    color: var(--color-amber-400);
  }
}
.meta-redacted {
  border-radius: 2147483647px;
  background-color: var(--color-amber-100);
  padding-inline: 0.5rem;
  padding-block: 0.125rem;
  color: var(--color-amber-700);
}
@media (prefers-color-scheme: dark) {
  .meta-redacted {
    background-color: #7b330666;
    color: var(--color-amber-300);
  }
  @supports (color: color-mix(in lab, red, red)) {
    .meta-redacted {
      background-color: color-mix(in oklab, var(--color-amber-900) 40%, transparent);
    }
  }
}
.content-wrap {
  margin-inline: auto;
  display: flex;
  width: 100%;
  max-width: 800px;
  align-items: stretch;
}
.msg-col {
  min-width: 0;
  flex: 1;
  padding-inline: 1rem;
  padding-bottom: 4rem;
}
.feed-note {
  padding-block: 1rem;
  text-align: center;
  font-size: 0.875rem;
  line-height: var(--lh-sm);
  color: var(--color-neutral-400);
}
.feed-note-empty {
  padding-block: 4rem;
}
@media (prefers-color-scheme: dark) {
  .feed-note {
    color: var(--color-neutral-500);
  }
}
.sentinel {
  height: 0.25rem;
}
</style>
