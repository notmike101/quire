<script setup lang="ts">
import SystemNotice from './SystemNotice.vue';
import type { SharePart } from '../api';

const props = defineProps<{ parts: SharePart[] }>();
</script>

<template>
  <div class="user-messages">
    <template v-for="(part, i) in parts" :key="i">
      <div
        v-if="part.type === 'text'"
        class="user-bubble"
      >{{ part.text }}</div>
      <div v-else-if="part.type === 'system'" class="system-part">
        <SystemNotice :text="part.text ?? ''" />
      </div>
    </template>
  </div>
</template>
<style scoped>
.user-messages {
  margin-block: 1rem;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.5rem;
}
.user-bubble {
  max-width: 85%;
  white-space: pre-wrap;
  border-radius: 1rem;
  background-color: var(--color-neutral-100);
  padding-inline: 1rem;
  padding-block: 0.5rem;
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
}
.system-part {
  max-width: 85%;
  align-self: flex-end;
}
@media (prefers-color-scheme: dark) {
  .user-bubble {
    background-color: var(--color-neutral-800);
  }
}
</style>
