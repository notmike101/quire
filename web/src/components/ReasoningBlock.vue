<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{ text: string }>();
const hasText = computed(() => props.text.trim().length > 0);
const open = ref(false);
</script>

<template>
  <div class="reasoning">
    <button v-if="hasText" class="reasoning-toggle" :aria-expanded="open" @click="open = !open">
      {{ open ? '▾' : '▸' }} thinking…
    </button>
    <span v-else class="reasoning-label">thinking…</span>
    <div
      v-if="hasText && open"
      class="reasoning-body"
    >{{ text }}</div>
  </div>
</template>
<style scoped>
.reasoning {
  margin-block: 0.5rem;
}
.reasoning-toggle {
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  font-style: italic;
  color: var(--color-neutral-400);
}
.reasoning-label {
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  font-style: italic;
  color: var(--color-neutral-400);
}
@media (hover: hover) {
  .reasoning-toggle:hover {
    color: var(--color-neutral-500);
  }
}
.reasoning-body {
  margin-top: 0.25rem;
  white-space: pre-wrap;
  border-left: 2px solid var(--color-neutral-200);
  padding-left: 0.75rem;
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
  color: var(--color-neutral-500);
}
@media (prefers-color-scheme: dark) {
  .reasoning-toggle,
  .reasoning-label {
    color: var(--color-neutral-500);
  }
  .reasoning-body {
    border-color: var(--color-neutral-800);
    color: var(--color-neutral-400);
  }
}
</style>
