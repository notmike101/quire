<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useMessages } from './composables/useMessages';
import type { ShareMessage } from './api';
import UserMessage from './components/UserMessage.vue';
import AssistantMessage from './components/AssistantMessage.vue';
import PasswordGate from './components/PasswordGate.vue';
import ExpiredPage from './components/ExpiredPage.vue';
import NotFoundPage from './components/NotFoundPage.vue';
import ErrorPage from './components/ErrorPage.vue';
import LoadingSkeleton from './components/LoadingSkeleton.vue';

const token = window.location.pathname.split('/').filter(Boolean).pop() ?? '';
const { state, meta, messages, loadingMore, errorMessage, passwordError, loadFirst, loadMore, submitPassword } =
  useMessages(token);

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function userText(message: ShareMessage): string {
  return message.parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
}
</script>

<template>
  <div class="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
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
      <header class="mx-auto w-full max-w-[760px] px-4 pb-6 pt-10">
        <h1 class="text-xl font-semibold">{{ meta?.title ?? 'Shared session' }}</h1>
        <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span v-if="meta?.model" class="rounded-full border border-neutral-200 px-2 py-0.5 dark:border-neutral-800">
            {{ meta.model }}
          </span>
          <span v-if="meta?.provider">{{ meta.provider }}</span>
          <span>{{ formatDate(meta?.createdAt ?? new Date().toISOString()) }}</span>
          <span v-if="meta?.expiresAt" class="text-amber-600 dark:text-amber-400">
            expires {{ formatDate(meta.expiresAt) }}
          </span>
          <span
            v-if="Object.values(meta?.redactions ?? {}).reduce((a, b) => a + b, 0) > 0"
            class="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
          >{{ Object.values(meta?.redactions ?? {}).reduce((a, b) => a + b, 0) }} redacted</span>
        </div>
      </header>
      <main class="mx-auto w-full max-w-[760px] px-4 pb-16">
        <template v-for="message in messages" :key="message.seq">
          <UserMessage v-if="message.role === 'user'" :text="userText(message)" />
          <AssistantMessage v-else :message="message" />
        </template>
        <div v-if="loadingMore" class="py-4 text-center text-sm text-neutral-400">Loading more…</div>
        <div v-else-if="messages.length === 0" class="py-16 text-center text-sm text-neutral-400">
          This session has no shareable messages.
        </div>
        <div ref="sentinel" class="h-1" />
      </main>
    </template>
  </div>
</template>
