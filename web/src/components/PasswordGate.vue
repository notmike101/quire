<script setup lang="ts">
import { ref } from 'vue';

defineProps<{ error: string }>();
const emit = defineEmits<{ unlock: [password: string] }>();
const password = ref('');

/** Emit an unlock request only when the password field is nonempty. */
function submit(): void {
  if (password.value) emit('unlock', password.value);
}
</script>

<template>
  <div class="page-wrap">
    <form class="page-card" @submit.prevent="submit">
      <h1 class="page-title">Password required</h1>
      <p class="page-sub gate-intro">This share is password protected.</p>
      <input
        v-model="password"
        type="password"
        class="gate-input"
        placeholder="Password"
        autocomplete="off"
      />
      <p v-if="error" class="gate-error">{{ error }}</p>
      <button
        type="submit"
        class="gate-submit"
      >Unlock</button>
    </form>
  </div>
</template>

<style scoped>
.gate-intro {
  margin-bottom: 1rem;
}
.gate-input {
  width: 100%;
  border-radius: 0.375rem;
  border: 1px solid var(--color-neutral-300);
  background-color: var(--color-white);
  padding-inline: 0.75rem;
  padding-block: 0.5rem;
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
}
.gate-error {
  margin-top: 0.25rem;
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
  color: var(--color-red-600);
}
.gate-submit {
  margin-top: 1rem;
  width: 100%;
  border-radius: 0.375rem;
  background-color: var(--color-neutral-900);
  padding-inline: 1rem;
  padding-block: 0.5rem;
  font-size: 0.875rem;
  line-height: calc(1.25 / 0.875);
  font-weight: 500;
  color: var(--color-white);
}
@media (hover: hover) {
  .gate-submit:hover {
    background-color: var(--color-neutral-700);
  }
}
@media (prefers-color-scheme: dark) {
  .gate-input {
    border-color: var(--color-neutral-700);
    background-color: var(--color-neutral-900);
  }
  .gate-error {
    color: var(--color-red-400);
  }
  .gate-submit {
    background-color: var(--color-neutral-100);
    color: var(--color-neutral-900);
  }
  @media (hover: hover) {
    .gate-submit:hover {
      background-color: var(--color-white);
    }
  }
}
</style>
