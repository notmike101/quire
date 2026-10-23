<script setup lang="ts">
import type { SharePart } from '../api';
import { isSafeImageSrc } from '../lib/imgsrc';

const props = defineProps<{ part: SharePart }>();

/**
 * Format the omitted image's byte count for its placeholder.
 *
 * @param n - Original image size, when available.
 * @returns Size in B, KB, or MB, or an empty string for a missing or zero size.
 */
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
      v-if="isSafeImageSrc(part.src)"
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
