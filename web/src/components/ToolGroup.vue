<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SharePart } from '../api';
import { compactPreview, toolPreview, toolFailed, toolErrorPreview } from '../lib/tool-preview';
import ToolCard from './ToolCard.vue';

const props = defineProps<{ parts: SharePart[] }>();
const open = ref(false);
// Runs grow by appending calls; keep disclosure state outside remounted cards.
const expandedCalls = ref<boolean[]>([]);
const previews = computed(() => props.parts.map(toolPreview));
const title = computed(() => {
  const titles = [...new Set(previews.value.map((preview) => preview.title))];
  return `${titles[0] ?? 'Tool activity'}${titles.length > 1 ? ` + ${titles.length - 1} more` : ''}`;
});
const targets = computed(() => compactPreview([...new Set(previews.value.map((preview) => preview.detail).filter(Boolean))].slice(0, 3).join(' · '), 160));
const failures = computed(() => props.parts.filter(toolFailed));
</script>

<template>
  <ToolCard v-if="parts.length === 1" v-model:open="open" :part="parts[0]!" @update:open="expandedCalls[0] = $event" />
  <div v-else class="tool-group" :class="{ failed: failures.length }">
    <button class="group-toggle" :aria-expanded="open" @click="open = !open">
      <span class="group-row">
        <span class="group-caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
        <span class="group-summary">
          <span class="group-title">{{ title }}</span>
          <span class="group-targets">{{ parts.length }} call{{ parts.length === 1 ? '' : 's' }}<template v-if="targets"> · {{ targets }}</template></span>
        </span>
      </span>
      <span v-if="failures.length" class="group-failures">
        <span aria-hidden="true">⚠</span>
        <span class="failure-note"><strong>{{ failures.length }} failed</strong> · {{ toolErrorPreview(failures[0]!) }}</span>
      </span>
    </button>
    <div v-if="open" class="group-body">
      <ToolCard v-for="(part, i) in parts" :key="part.callID ?? i" v-model:open="expandedCalls[i]" :part="part" />
    </div>
  </div>
</template>

<style scoped>
.tool-group {
  margin-block: 0.75rem;
  overflow: hidden;
  border-radius: 0.5rem;
  border: 1px solid var(--color-neutral-200);
  font-size: 0.875rem;
  line-height: var(--lh-sm);
}
.tool-group.failed {
  border-color: var(--color-red-300);
}
.group-toggle {
  display: block;
  width: 100%;
  text-align: left;
}
.group-row {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 0.5rem;
  padding-inline: 0.75rem;
  padding-block: 0.625rem;
}
.group-caret {
  padding-top: 0.125rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: var(--lh-xs);
  color: var(--color-neutral-500);
}
.group-summary {
  min-width: 0;
  flex: 1;
}
.group-title {
  display: block;
  overflow-wrap: break-word;
  font-weight: 500;
}
.group-targets {
  margin-top: 0.25rem;
  display: block;
  overflow-wrap: break-word;
  font-size: 0.75rem;
  line-height: var(--lh-xs);
  color: var(--color-neutral-500);
}
.group-failures {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  border-color: var(--color-red-200);
  border-top: 1px solid var(--color-red-200);
  background-color: var(--color-red-50);
  padding-inline: 0.75rem;
  padding-block: 0.5rem;
  font-size: 0.75rem;
  line-height: var(--lh-xs);
  color: var(--color-red-800);
}
.failure-note {
  min-width: 0;
  overflow-wrap: break-word;
}
.group-body {
  border-color: var(--color-neutral-200);
  border-top: 1px solid var(--color-neutral-200);
  padding-inline: 0.75rem;
  padding-block: 0.25rem;
}
@media (prefers-color-scheme: dark) {
  .tool-group {
    border-color: var(--color-neutral-800);
  }
  .tool-group.failed {
    border-color: var(--color-red-900);
  }
  .group-targets {
    color: var(--color-neutral-400);
  }
  .group-failures {
    border-color: var(--color-red-900);
    background-color: #46080966;
    color: var(--color-red-200);
  }
  @supports (color: color-mix(in lab, red, red)) {
    .group-failures {
      background-color: color-mix(in oklab, var(--color-red-950) 40%, transparent);
    }
  }
  .group-body {
    border-color: var(--color-neutral-800);
  }
}
</style>
