<template>
  <article class="metric-tile" :class="[tone, { 'is-loading': loading }]">
    <span class="metric-label">{{ label }}</span>
    <template v-if="loading">
      <span class="metric-skeleton metric-skeleton-value" aria-hidden="true" />
      <span class="metric-skeleton metric-skeleton-note" aria-hidden="true" />
    </template>
    <template v-else>
      <strong>{{ value }}</strong>
      <small v-if="note">{{ note }}</small>
    </template>
  </article>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ label: string; value: string | number; note?: string; tone?: string; loading?: boolean }>(), { tone: 'blue', loading: false })
</script>
