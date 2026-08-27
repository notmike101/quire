<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{ text: string }>();
const open = ref(false);

// Short label for the collapsed chip. The goal-continuation reminder is the
// dominant real-world case; everything else is a generic "system reminder".
const label = computed(() => {
  const t = props.text ?? '';
  if (t.includes('active session goal')) return 'goal continuation';
  if (t.includes('TodoWrite')) return 'todo reminder';
  if (t.includes('continued from a previous conversation')) return 'context summary';
  return 'system reminder';
});
</script>

<template>
  <div class="my-2">
    <button
      class="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 py-0.5 text-xs text-neutral-400 hover:text-neutral-600 dark:border-neutral-800 dark:text-neutral-500 dark:hover:text-neutral-300"
      @click="open = !open"
    >
      <span class="font-mono">{{ open ? '▾' : '▸' }}</span>
      <span class="italic">{{ label }}</span>
    </button>
    <div
      v-if="open"
      class="mt-1.5 whitespace-pre-wrap rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs leading-relaxed text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-400"
    >{{ text }}</div>
  </div>
</template>
