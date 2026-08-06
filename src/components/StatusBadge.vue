<script setup lang="ts">
import { computed } from 'vue'

defineOptions({ name: 'StatusBadge' })

const props = withDefaults(
  defineProps<{
    label: string
    type?: 'success' | 'failure' | 'running' | 'paused' | 'stopped' | 'neutral'
  }>(),
  { type: 'neutral' }
)

const typeMap: Record<string, string> = {
  success: 'success',
  failure: 'danger',
  running: 'primary',
  paused: 'warning',
  stopped: 'info',
  neutral: 'info'
}

const elType = computed(() => typeMap[props.type] ?? 'info')
</script>

<template>
  <el-tag :type="elType" size="small" effect="light">{{ label }}</el-tag>
</template>