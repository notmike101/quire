<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ code: string }>();
const copied = ref(false);

/**
 * Limit displayed code without truncating the original clipboard value.
 *
 * @returns Code capped at 20,000 characters, with an ellipsis when shortened.
 */
function display(): string {
  return props.code.length > 20000 ? `${props.code.slice(0, 20000)}\n…` : props.code;
}

/** Copy the full code and briefly acknowledge success when clipboard access works. */
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // clipboard unavailable (e.g. non-secure context) — ignore
  }
}
</script>

<template>
  <div class="code-block">
    <pre class="code-pre"><code>{{ display() }}</code></pre>
    <button class="copy-btn" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
  </div>
</template>

<style scoped>
.code-block {
  position: relative;
}
.code-pre {
  overflow-x: auto;
  border-radius: 0.375rem;
  background-color: var(--color-neutral-100);
  padding: 0.75rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: var(--lh-xs);
}
.copy-btn {
  position: absolute;
  right: 0.5rem;
  top: 0.5rem;
  display: none;
  border-radius: 0.25rem;
  border: 1px solid var(--color-neutral-300);
  background-color: var(--color-white);
  padding-inline: 0.5rem;
  padding-block: 0.125rem;
  font-size: 0.75rem;
  line-height: var(--lh-xs);
}
@media (hover: hover) {
  .code-block:hover .copy-btn {
    display: block;
  }
}
@media (prefers-color-scheme: dark) {
  .code-pre {
    background-color: var(--color-neutral-900);
  }
  .copy-btn {
    border-color: var(--color-neutral-600);
    background-color: var(--color-neutral-800);
  }
}
</style>
