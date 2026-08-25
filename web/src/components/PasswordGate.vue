<script setup lang="ts">
import { ref } from 'vue';

defineProps<{ error: string }>();
const emit = defineEmits<{ unlock: [password: string] }>();
const password = ref('');

function submit(): void {
  if (password.value) emit('unlock', password.value);
}
</script>

<template>
  <div class="mx-auto mt-24 w-full max-w-sm px-4">
    <form class="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800" @submit.prevent="submit">
      <h1 class="mb-1 text-lg font-semibold">Password required</h1>
      <p class="mb-4 text-sm text-neutral-500 dark:text-neutral-400">This share is password protected.</p>
      <input
        v-model="password"
        type="password"
        class="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        placeholder="Password"
        autocomplete="current-password"
      />
      <p v-if="error" class="mt-2 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
      <button
        type="submit"
        class="mt-4 w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
      >Unlock</button>
    </form>
  </div>
</template>
