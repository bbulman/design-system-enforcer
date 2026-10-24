<!-- The primary action. Use for anything that submits or commits. -->
<script setup lang="ts">
const props = defineProps<{
  variant?: 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
}>()
</script>
<template><button class="bg-brand text-surface"><slot /></button></template>
