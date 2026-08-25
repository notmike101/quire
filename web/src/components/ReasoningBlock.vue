<script setup lang="ts">
import { ref } from 'vue';

defineProps<{ text: string }>();
const open = ref(false);
</script>

<template>
  <div class="my-2">
    <button class="text-xs italic text-neutral-400 hover:text-neutral-500 dark:text-neutral-500" @click="open = !open">
      {{ open ? '▾' : '▸' }} thinking…
    </button>
    <div
      v-if="open"
      class="mt-1 whitespace-pre-wrap border-l-2 border-neutral-200 pl-3 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
    >{{ text }}</div>
  </div>
</template>
