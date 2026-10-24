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
  <div class="sys-notice">
    <button
      class="sys-toggle"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="sys-icon" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      <span>
        <span class="sys-label">{{ label }}</span>
        <span v-if="preview" class="sys-preview">{{ preview }}</span>
      </span>
    </button>
    <div
      v-if="open"
      class="sys-body"
    >{{ text }}</div>
  </div>
</template>
<style scoped>
.sys-notice {
  margin-block: 0.5rem;
}
.sys-toggle {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 0.5rem;
  border-radius: 0.5rem;
  border: 1px solid var(--color-neutral-200);
  padding-inline: 0.75rem;
  padding-block: 0.5rem;
  text-align: left;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
@media (hover: hover) {
  .sys-toggle:hover {
    color: var(--color-neutral-700);
  }
}
.sys-icon {
  font-family: var(--font-mono);
}
.sys-label {
  display: block;
  font-weight: 500;
}
.sys-preview {
  margin-top: 0.25rem;
  display: block;
  overflow-wrap: break-word;
}
.sys-body {
  margin-top: 0.375rem;
  white-space: pre-wrap;
  border-radius: 0.5rem;
  border: 1px solid var(--color-neutral-200);
  background-color: var(--color-neutral-50);
  padding: 0.75rem;
  font-size: 0.75rem;
  line-height: 1.625;
  color: var(--color-neutral-500);
}
@media (prefers-color-scheme: dark) {
  .sys-toggle {
    border-color: var(--color-neutral-800);
    color: var(--color-neutral-400);
  }
  @media (hover: hover) {
    .sys-toggle:hover {
      color: var(--color-neutral-200);
    }
  }
  .sys-body {
    border-color: var(--color-neutral-800);
    background-color: #17171766;
    color: var(--color-neutral-400);
  }
  @supports (color: color-mix(in lab, red, red)) {
    .sys-body {
      background-color: color-mix(in oklab, var(--color-neutral-900) 40%, transparent);
    }
  }
}
</style>
