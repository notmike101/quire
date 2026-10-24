<script setup lang="ts">
import { computed } from 'vue';
import CodeBlock from './CodeBlock.vue';
import type { SharePart } from '../api';
import { isSafeImageSrc } from '../lib/imgsrc';
import { toolPreview, toolFailed, toolErrorPreview } from '../lib/tool-preview';

const props = defineProps<{ part: SharePart }>();
const open = defineModel<boolean>('open', { default: false });

const preview = computed(() => toolPreview(props.part));
const failed = computed(() => toolFailed(props.part));

/**
 * Format tool arguments for the expanded code block.
 *
 * @param part - Tool part containing raw text or structured arguments.
 * @returns Original text, indented JSON, or an empty string for absent input.
 */
function inputText(part: SharePart): string {
  if (part.input === undefined || part.input === null) return '';
  return typeof part.input === 'string' ? part.input : JSON.stringify(part.input, null, 2);
}

/**
 * Format attachment sizes for images omitted from a tool result.
 *
 * @param n - Original image size in bytes, when known.
 * @returns Size in B, KB, or MB, or an empty string when unknown.
 */
function fmtBytes(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <div class="tool-card" :class="{ failed }">
    <button class="tool-head" :aria-expanded="open" @click="open = !open">
      <span class="card-caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      <span class="tool-summary">
        <span class="tool-name">{{ preview.title }}</span>
        <span class="tool-target">{{ part.tool ?? 'tool' }}<template v-if="preview.detail"> · {{ preview.detail }}</template></span>
        <span v-if="failed" class="tool-error">{{ toolErrorPreview(part) }}</span>
        <span v-if="part.images?.length" class="tool-image-count">{{ part.images.length }} image{{ part.images.length > 1 ? 's' : '' }}</span>
      </span>
      <span v-if="failed" class="failed-badge">Failed</span>
    </button>
    <div v-if="open" class="tool-body">
      <CodeBlock v-if="inputText(part)" :code="inputText(part)" />
      <CodeBlock v-if="part.output" :code="part.output" />
      <div v-if="part.images && part.images.length > 0" class="tool-images">
        <div v-for="(img, i) in part.images" :key="i" class="image-part">
          <img v-if="isSafeImageSrc(img.src)" :src="img.src" :alt="img.alt ?? 'image'" loading="lazy" class="image-part-img" />
          <div v-else class="image-placeholder">
            <span>📷</span>
            <span class="placeholder-note">image too large to embed{{ img.bytes ? ` (${fmtBytes(img.bytes)})` : '' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  margin-block: 0.5rem;
  overflow: hidden;
  border-radius: 0.5rem;
  border: 1px solid var(--color-neutral-200);
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
}
.tool-card.failed {
  border-color: var(--color-red-300);
  background-color: #fef2f2b3;
}
@supports (color: color-mix(in lab, red, red)) {
  .tool-card.failed {
    background-color: color-mix(in oklab, var(--color-red-50) 70%, transparent);
  }
}
.tool-head {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 0.5rem;
  padding-inline: 0.75rem;
  padding-block: 0.5rem;
  text-align: left;
}
.card-caret {
  padding-top: 0.125rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
.tool-summary {
  min-width: 0;
  flex: 1;
}
.tool-name {
  display: block;
  overflow-wrap: break-word;
  font-weight: 500;
}
.tool-target {
  margin-top: 0.125rem;
  display: block;
  word-break: break-all;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
.tool-error {
  margin-top: 0.25rem;
  display: block;
  overflow-wrap: break-word;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-red-800);
}
.tool-image-count {
  margin-top: 0.25rem;
  display: block;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
.failed-badge {
  flex-shrink: 0;
  border-radius: 2147483647px;
  background-color: var(--color-red-100);
  padding-inline: 0.5rem;
  padding-block: 0.125rem;
  font-size: 0.75rem;
  line-height: calc(1 / 0.75);
  font-weight: 500;
  color: var(--color-red-800);
}
.tool-body {
  border-top: 1px solid var(--color-neutral-200);
  padding: 0.75rem;
}
.tool-body > :not(:last-child) {
  margin-block-end: 0.5rem;
}
.tool-images {
  padding-top: 0.25rem;
}
.tool-images > :not(:last-child) {
  margin-block-end: 0.5rem;
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
  line-height: calc(1 / 0.75);
  color: var(--color-neutral-500);
}
.placeholder-note {
  font-style: italic;
}
@media (prefers-color-scheme: dark) {
  .tool-card {
    border-color: var(--color-neutral-800);
  }
  .tool-card.failed {
    border-color: var(--color-red-800);
    background-color: #4608094d;
  }
  @supports (color: color-mix(in lab, red, red)) {
    .tool-card.failed {
      background-color: color-mix(in oklab, var(--color-red-950) 30%, transparent);
    }
  }
  .card-caret,
  .tool-target,
  .tool-image-count {
    color: var(--color-neutral-400);
  }
  .tool-error {
    color: var(--color-red-200);
  }
  .failed-badge {
    background-color: #82181a99;
    color: var(--color-red-200);
  }
  @supports (color: color-mix(in lab, red, red)) {
    .failed-badge {
      background-color: color-mix(in oklab, var(--color-red-900) 60%, transparent);
    }
  }
  .tool-body {
    border-color: var(--color-neutral-800);
  }
  .image-placeholder {
    border-color: var(--color-neutral-800);
    background-color: #17171766;
    color: var(--color-neutral-400);
  }
  @supports (color: color-mix(in lab, red, red)) {
    .image-placeholder {
      background-color: color-mix(in oklab, var(--color-neutral-900) 40%, transparent);
    }
  }
}
</style>
