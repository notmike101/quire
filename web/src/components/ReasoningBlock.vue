<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{ text: string }>();
const hasText = computed(() => props.text.trim().length > 0);
const open = ref(false);
</script>

<template>
  <div class="my-2">
    <button v-if="hasText" class="text-xs italic text-neutral-400 hover:text-neutral-500 dark:text-neutral-500" :aria-expanded="open" @click="open = !open">
      {{ open ? '▾' : '▸' }} thinking…
    </button>
    <span v-else class="text-xs italic text-neutral-400 dark:text-neutral-500">thinking…</span>
    <div
      v-if="hasText && open"
      class="mt-1 whitespace-pre-wrap border-l-2 border-neutral-200 pl-3 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
    >{{ text }}</div>
  </div>
</template>
