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
  <div v-else class="tool-group my-3 overflow-hidden rounded-lg border border-neutral-200 text-sm dark:border-neutral-800" :class="{ 'border-red-300 dark:border-red-900': failures.length }">
    <button class="block w-full text-left" :aria-expanded="open" @click="open = !open">
      <span class="flex min-w-0 items-start gap-2 px-3 py-2.5">
        <span class="pt-0.5 font-mono text-xs text-neutral-500" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
        <span class="min-w-0 flex-1">
          <span class="block break-words font-medium">{{ title }}</span>
          <span class="mt-1 block break-words text-xs text-neutral-500 [overflow-wrap:anywhere] dark:text-neutral-400">{{ parts.length }} call{{ parts.length === 1 ? '' : 's' }}<template v-if="targets"> · {{ targets }}</template></span>
        </span>
      </span>
      <span v-if="failures.length" class="flex items-start gap-2 border-t border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
        <span aria-hidden="true">⚠</span>
        <span class="min-w-0 break-words"><strong>{{ failures.length }} failed</strong> · {{ toolErrorPreview(failures[0]!) }}</span>
      </span>
    </button>
    <div v-if="open" class="border-t border-neutral-200 px-3 py-1 dark:border-neutral-800">
      <ToolCard v-for="(part, i) in parts" :key="part.callID ?? i" v-model:open="expandedCalls[i]" :part="part" />
    </div>
  </div>
</template>
