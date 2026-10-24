<template>
  <div class="skeleton" aria-busy="true">
    <div class="sk-title" />
    <div class="sk-sub" />
    <div class="sk-msg-1" />
    <div class="sk-msg-2" />
    <div class="sk-msg-3" />
  </div>
</template>

<style scoped>
.skeleton {
  margin-inline: auto;
  width: 100%;
  max-width: 760px;
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  padding-inline: 1rem;
  padding-top: 2.5rem;
}
.sk-title {
  height: 1.5rem;
  width: 66.6667%;
  border-radius: 0.25rem;
  background-color: var(--color-neutral-200);
}
.sk-sub {
  margin-top: 0.5rem;
  height: 1rem;
  width: 33.3333%;
  border-radius: 0.25rem;
  background-color: var(--color-neutral-200);
}
.sk-msg-1 {
  margin-top: 2.5rem;
  height: 4rem;
  width: 75%;
  border-radius: 1rem;
  background-color: var(--color-neutral-100);
}
.sk-msg-2 {
  margin-top: 1rem;
  height: 6rem;
  width: 100%;
  border-radius: 1rem;
  background-color: var(--color-neutral-100);
}
.sk-msg-3 {
  margin-top: 1rem;
  height: 4rem;
  width: 66.6667%;
  border-radius: 1rem;
  background-color: var(--color-neutral-100);
}
@media (prefers-color-scheme: dark) {
  .sk-title,
  .sk-sub {
    background-color: var(--color-neutral-800);
  }
  .sk-msg-1,
  .sk-msg-2,
  .sk-msg-3 {
    background-color: var(--color-neutral-900);
  }
}
@keyframes pulse {
  50% {
    opacity: 0.5;
  }
}
</style>
