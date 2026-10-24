<script setup lang="ts">
import { ref, watch } from 'vue';
import { renderMarkdown } from '../markdown';
import ToolGroup from './ToolGroup.vue';
import ReasoningBlock from './ReasoningBlock.vue';
import SystemNotice from './SystemNotice.vue';
import ImagePart from './ImagePart.vue';
import type { ShareMessage, SharePart } from '../api';

const props = defineProps<{ message: ShareMessage }>();

type RenderedPart =
  | { kind: 'html'; html: string }
  | { kind: 'tools'; parts: SharePart[] }
  | { kind: 'reasoning'; part: SharePart }
  | { kind: 'system'; part: SharePart }
  | { kind: 'image'; part: SharePart };

const parts = ref<RenderedPart[]>([]);

watch(() => props.message.parts, async (source, _previous, onCleanup) => {
  let stale = false;
  onCleanup(() => { stale = true; });
  const out: RenderedPart[] = [];
  for (const part of source) {
    if (part.type === 'text') {
      if (part.text?.trim()) out.push({ kind: 'html', html: await renderMarkdown(part.text) });
    } else if (part.type === 'tool') {
      const last = out[out.length - 1];
      if (last?.kind === 'tools') last.parts.push(part);
      else out.push({ kind: 'tools', parts: [part] });
    } else if (part.type === 'system') {
      out.push({ kind: 'system', part });
    } else if (part.type === 'image') {
      out.push({ kind: 'image', part });
    } else {
      out.push({ kind: 'reasoning', part });
    }
  }
  if (!stale) parts.value = out;
}, { immediate: true });
</script>

<template>
  <div class="assistant-body">
    <template v-for="(item, i) in parts" :key="i">
      <div v-if="item.kind === 'html'" class="prose-quire" v-html="item.html" />
      <ToolGroup v-else-if="item.kind === 'tools'" :parts="item.parts" />
      <SystemNotice v-else-if="item.kind === 'system'" :text="item.part.text ?? ''" />
      <ImagePart v-else-if="item.kind === 'image'" :part="item.part" />
      <ReasoningBlock v-else :text="item.part.text ?? ''" />
    </template>
  </div>
</template>
<style scoped>
.assistant-body {
  margin-block: 1rem;
  font-size: 0.875rem;
  line-height: 1.625;
}
</style>
