<script setup lang="ts">
import type { SharePart } from '../api';

const props = defineProps<{ part: SharePart }>();

// Human-readable size for the too-large placeholder.
function fmtBytes(n: number | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <div class="my-3 image-part">
    <img
      v-if="part.src"
      :src="part.src"
      :alt="part.alt ?? 'image'"
      loading="lazy"
      class="image-part-img"
    />
    <div
      v-else
      class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-500"
    >
      <span>📷</span>
      <span class="italic">
        image too large to embed{{ part.bytes ? ` (${fmtBytes(part.bytes)})` : '' }}
      </span>
    </div>
  </div>
</template>
