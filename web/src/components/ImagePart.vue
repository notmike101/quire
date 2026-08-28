<script setup lang="ts">
import { ref } from 'vue';
import type { SharePart } from '../api';

const props = defineProps<{ part: SharePart }>();

// Collapsed images (Read-attachment images — the agent inspecting a file) start
// tucked behind a chip and expand on click. Non-collapsed images (the agent's
// deliberate markdown screenshots) render inline immediately.
const open = ref(!props.part.collapsed);

// Human-readable size for the too-large placeholder.
function fmtBytes(n: number | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <!-- Collapsed (Read-attachment) image: a chip that expands to the image. -->
  <div v-if="part.collapsed" class="my-2">
    <button
      class="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 py-0.5 text-xs text-neutral-400 hover:text-neutral-600 dark:border-neutral-800 dark:text-neutral-500 dark:hover:text-neutral-300"
      @click="open = !open"
    >
      <span class="font-mono">{{ open ? '▾' : '▸' }}</span>
      <span class="italic">image · {{ part.alt ?? 'Read image' }}</span>
    </button>
    <div v-if="open" class="mt-2 image-part">
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
  </div>

  <!-- Inline (non-collapsed) image: renders immediately. -->
  <div v-else class="my-3 image-part">
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
