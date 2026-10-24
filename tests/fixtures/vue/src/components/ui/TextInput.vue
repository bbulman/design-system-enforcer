<script setup>
defineProps({
  label: { type: String, required: true },
  tone: { type: String, default: 'neutral', validator: v => ['neutral', 'error'].includes(v) },
})
</script>
<template><label>{{ label }}<input /></label></template>
