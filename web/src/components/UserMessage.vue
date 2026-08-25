<script setup lang="ts">
defineProps<{ text: string }>();
</script>

<template>
  <div class="my-4 flex justify-end">
    <div class="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-neutral-100 px-4 py-2 text-sm dark:bg-neutral-800">
      {{ text }}
    </div>
  </div>
</template>
