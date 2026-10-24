<script setup>
import BaseButton from '@/components/ui/BaseButton.vue'
const warn = '#FF0000'
</script>

<template>
  <!-- a comment with #123456 should not count -->
  <main class="bg-slate-50 p-[13px]">
    <h1 class="text-rose-600" style="color: #0f172b; padding-top: 24px;">Hi</h1>
    <button @click="go">Raw</button>
    <BaseButton variant="primary">Fine</BaseButton>
  </main>
</template>

<style scoped>
.card { background: #0EA5E9; margin: 13px; }
.note { @apply text-[#E11D48] bg-gray-100; }
</style>
