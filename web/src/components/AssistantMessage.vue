<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { renderMarkdown } from '../markdown';
import ToolCard from './ToolCard.vue';
import ReasoningBlock from './ReasoningBlock.vue';
import SystemNotice from './SystemNotice.vue';
import ImagePart from './ImagePart.vue';
import type { ShareMessage, SharePart } from '../api';

const props = defineProps<{ message: ShareMessage }>();

type RenderedPart =
  | { kind: 'html'; html: string }
  | { kind: 'tool'; part: SharePart }
  | { kind: 'reasoning'; part: SharePart }
  | { kind: 'system'; part: SharePart }
  | { kind: 'image'; part: SharePart };

const parts = ref<RenderedPart[]>([]);

onMounted(async () => {
  const out: RenderedPart[] = [];
  for (const part of props.message.parts) {
    if (part.type === 'text') {
      out.push({ kind: 'html', html: await renderMarkdown(part.text ?? '') });
    } else if (part.type === 'tool') {
      out.push({ kind: 'tool', part });
    } else if (part.type === 'system') {
      out.push({ kind: 'system', part });
    } else if (part.type === 'image') {
      out.push({ kind: 'image', part });
    } else {
      out.push({ kind: 'reasoning', part });
    }
  }
  parts.value = out;
});
</script>

<template>
  <div class="my-4 text-sm leading-relaxed">
    <template v-for="(item, i) in parts" :key="i">
      <div v-if="item.kind === 'html'" class="prose-quire" v-html="item.html" />
      <ToolCard v-else-if="item.kind === 'tool'" :part="item.part" />
      <SystemNotice v-else-if="item.kind === 'system'" :text="item.part.text ?? ''" />
      <ImagePart v-else-if="item.kind === 'image'" :part="item.part" />
      <ReasoningBlock v-else :text="item.part.text ?? ''" />
    </template>
  </div>
</template>
