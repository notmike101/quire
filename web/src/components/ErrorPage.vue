<script setup lang="ts">
defineProps<{ message: string }>();
</script>

<template>
  <div class="page-wrap">
    <div class="page-card">
      <h1 class="page-title">Something went wrong</h1>
      <p class="page-sub">{{ message }}</p>
    </div>
  </div>
</template>

<style scoped>
.page-card {
  text-align: center;
}
</style>
