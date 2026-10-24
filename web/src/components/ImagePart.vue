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
  <div class="image-block image-part">
    <img
      v-if="isSafeImageSrc(part.src)"
      :src="part.src"
      :alt="part.alt ?? 'image'"
      loading="lazy"
      class="image-part-img"
    />
    <div v-else class="image-placeholder">
      <span>📷</span>
      <span class="placeholder-note">
        image too large to embed{{ part.bytes ? ` (${fmtBytes(part.bytes)})` : '' }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.image-block {
  margin-block: 0.75rem;
}
.image-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border-radius: 0.5rem;
  border: 1px solid var(--color-neutral-200);
  background-color: var(--color-neutral-50);
  padding-inline: 0.75rem;
  padding-block: 0.5rem;
  font-size: 0.75rem;
  line-height: var(--lh-xs);
  color: var(--color-neutral-400);
}
.placeholder-note {
  font-style: italic;
}
@media (prefers-color-scheme: dark) {
  .image-placeholder {
    border-color: var(--color-neutral-800);
    background-color: #17171766;
    color: var(--color-neutral-500);
  }
  @supports (color: color-mix(in lab, red, red)) {
    .image-placeholder {
      background-color: color-mix(in oklab, var(--color-neutral-900) 40%, transparent);
    }
  }
}
</style>
