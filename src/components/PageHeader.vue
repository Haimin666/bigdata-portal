<script setup lang="ts">
defineOptions({ name: 'PageHeader' })

withDefaults(
  defineProps<{
    title: string
    description?: string
    eyebrow?: string
    compact?: boolean
  }>(),
  {
    description: '',
    eyebrow: '',
    compact: false
  }
)
</script>

<template>
  <header class="page-header" :class="{ compact }">
    <div class="page-heading">
      <div v-if="eyebrow" class="page-eyebrow">{{ eyebrow }}</div>
      <div class="page-title-row">
        <h1>{{ title }}</h1>
        <slot name="status" />
      </div>
      <p v-if="description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="page-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped lang="scss">
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 52px;
  padding: 2px 2px 0;
}

.page-header.compact {
  min-height: 28px;
  gap: 8px;

  h1 {
    font-size: 14px;
  }

  p {
    font-size: 10px;
  }
}

.page-heading {
  min-width: 0;
}

.page-eyebrow {
  margin-bottom: 2px;
  color: $muted;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.page-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

h1 {
  margin: 0;
  color: $text;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.3;
}

p {
  margin: 5px 0 0;
  overflow: hidden;
  color: $muted;
  font-size: 12px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

@media (max-width: 760px) {
  .page-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
  }

  .page-actions {
    width: 100%;
  }
}
</style>
