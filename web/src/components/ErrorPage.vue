<script setup lang="ts">
defineProps<{ message: string }>();
</script>

<template>
  <div class="mx-auto mt-24 w-full max-w-sm px-4">
    <div class="rounded-xl border border-neutral-200 p-6 text-center dark:border-neutral-800">
      <h1 class="mb-1 text-lg font-semibold">Something went wrong</h1>
      <p class="text-sm text-neutral-500 dark:text-neutral-400">{{ message }}</p>
    </div>
  </div>
</template>
