<template>
  <article class="metric-tile" :class="tone">
    <span class="metric-label">{{ label }}</span>
    <strong>{{ value }}</strong>
    <small v-if="note">{{ note }}</small>
  </article>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ label: string; value: string | number; note?: string; tone?: string }>(), { tone: 'blue' })
</script>
