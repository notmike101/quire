<script setup lang="ts">
import SystemNotice from './SystemNotice.vue';
import type { SharePart } from '../api';

const props = defineProps<{ parts: SharePart[] }>();
</script>

<template>
  <div class="my-4 flex flex-col items-end gap-2">
    <template v-for="(part, i) in parts" :key="i">
      <div
        v-if="part.type === 'text'"
        class="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-neutral-100 px-4 py-2 text-sm dark:bg-neutral-800"
      >{{ part.text }}</div>
      <div v-else-if="part.type === 'system'" class="max-w-[85%] self-end">
        <SystemNotice :text="part.text ?? ''" />
      </div>
    </template>
  </div>
</template>
