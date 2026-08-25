<script setup lang="ts">
import { computed, ref } from 'vue';
import CodeBlock from './CodeBlock.vue';
import type { SharePart } from '../api';

const props = defineProps<{ part: SharePart }>();
const open = ref(false);

const statusClass = computed(() => {
  const s = props.part.status;
  if (s === 'completed') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
  if (s === 'error') return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
  return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
});

function inputText(part: SharePart): string {
  if (part.input === undefined || part.input === null) return '';
  return typeof part.input === 'string' ? part.input : JSON.stringify(part.input, null, 2);
}
</script>

<template>
  <div class="my-2 rounded-lg border border-neutral-200 text-sm dark:border-neutral-800">
    <button class="flex w-full items-center gap-2 px-3 py-2 text-left" @click="open = !open">
      <span class="font-mono text-xs text-neutral-500 dark:text-neutral-400">{{ open ? '▾' : '▸' }}</span>
      <span class="font-medium">{{ part.tool ?? 'tool' }}</span>
      <span class="rounded-full px-2 py-0.5 text-xs" :class="statusClass">{{ part.status ?? 'pending' }}</span>
    </button>
    <div v-if="open" class="space-y-2 border-t border-neutral-200 p-3 dark:border-neutral-800">
      <CodeBlock v-if="inputText(part)" :code="inputText(part)" />
      <CodeBlock v-if="part.output" :code="part.output" />
    </div>
  </div>
</template>
