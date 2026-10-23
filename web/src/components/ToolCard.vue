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
  <div class="my-2 overflow-hidden rounded-lg border text-sm" :class="failed ? 'border-red-300 bg-red-50/70 dark:border-red-800 dark:bg-red-950/30' : 'border-neutral-200 dark:border-neutral-800'">
    <button class="flex w-full items-start gap-2 px-3 py-2 text-left" :aria-expanded="open" @click="open = !open">
      <span class="pt-0.5 font-mono text-xs text-neutral-500 dark:text-neutral-400" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      <span class="min-w-0 flex-1">
        <span class="block break-words font-medium">{{ preview.title }}</span>
        <span class="mt-0.5 block break-all font-mono text-xs text-neutral-500 dark:text-neutral-400">{{ part.tool ?? 'tool' }}<template v-if="preview.detail"> · {{ preview.detail }}</template></span>
        <span v-if="failed" class="mt-1 block break-words text-xs text-red-800 dark:text-red-200">{{ toolErrorPreview(part) }}</span>
        <span v-if="part.images?.length" class="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">{{ part.images.length }} image{{ part.images.length > 1 ? 's' : '' }}</span>
      </span>
      <span v-if="failed" class="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/60 dark:text-red-200">Failed</span>
    </button>
    <div v-if="open" class="space-y-2 border-t border-neutral-200 p-3 dark:border-neutral-800">
      <CodeBlock v-if="inputText(part)" :code="inputText(part)" />
      <CodeBlock v-if="part.output" :code="part.output" />
      <div v-if="part.images && part.images.length > 0" class="space-y-2 pt-1">
        <div v-for="(img, i) in part.images" :key="i" class="image-part">
          <img v-if="isSafeImageSrc(img.src)" :src="img.src" :alt="img.alt ?? 'image'" loading="lazy" class="image-part-img" />
          <div v-else class="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-400">
            <span>📷</span>
            <span class="italic">image too large to embed{{ img.bytes ? ` (${fmtBytes(img.bytes)})` : '' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
