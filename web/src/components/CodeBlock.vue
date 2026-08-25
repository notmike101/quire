<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ code: string }>();
const copied = ref(false);

function display(): string {
  return props.code.length > 20000 ? `${props.code.slice(0, 20000)}\n…` : props.code;
}

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
  <div class="group relative">
    <pre class="overflow-x-auto rounded-md bg-neutral-100 p-3 font-mono text-xs dark:bg-neutral-900">
      <code>{{ display() }}</code></pre>
    <button
      class="absolute right-2 top-2 hidden rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs group-hover:block dark:border-neutral-600 dark:bg-neutral-800"
      @click="copy"
    >{{ copied ? 'Copied' : 'Copy' }}</button>
  </div>
</template>
