<script setup lang="ts">
import { computed, ref } from 'vue';
import { compactPreview } from '../lib/tool-preview';

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

const preview = computed(() => compactPreview(
  props.text.replace(/^\s*<system-(?:reminder|notice)(?:\s[^>]*)?>\s*/i, '').replace(/\s*<\/system-(?:reminder|notice)>\s*$/i, ''),
));
</script>

<template>
  <div class="my-2">
    <button
      class="flex w-full items-start gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-left text-xs text-neutral-500 hover:text-neutral-700 dark:border-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="font-mono" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      <span class="min-w-0">
        <span class="block font-medium">{{ label }}</span>
        <span v-if="preview" class="mt-1 block break-words">{{ preview }}</span>
      </span>
    </button>
    <div
      v-if="open"
      class="mt-1.5 whitespace-pre-wrap rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs leading-relaxed text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-400"
    >{{ text }}</div>
  </div>
</template>
