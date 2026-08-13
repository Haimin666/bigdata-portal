<script setup lang="ts">
import { computed } from 'vue'

defineOptions({ name: 'StatusBadge' })

const props = withDefaults(
  defineProps<{
    label: string
    type?: 'success' | 'failure' | 'running' | 'paused' | 'stopped' | 'neutral'
    /** 自定义主色(hex,如 '#3b82f6'):优先级高于 type,深浅主题自动派生柔和底 */
    color?: string
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

// 自定义色:用 color-mix 派生淡底/边框(半透明),深浅主题通吃,
// 避免在 html.dark 下叠加荧光感,也无需为自定义色另写暗色分支
const customStyle = computed(() => {
  if (!props.color) return undefined
  return {
    '--el-tag-bg-color': `color-mix(in srgb, ${props.color} 12%, transparent)`,
    '--el-tag-border-color': `color-mix(in srgb, ${props.color} 40%, transparent)`,
    '--el-tag-text-color': props.color
  }
})
</script>

<template>
  <el-tag
    :type="color ? undefined : elType"
    :style="customStyle"
    size="small"
    effect="light"
  >{{ label }}</el-tag>
</template>
