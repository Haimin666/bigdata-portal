<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import StatusBadge from '@/components/StatusBadge.vue'
import type { ColumnHeader, StatusColor, YarnApp } from '@/types/yarn'
import { formatElapsed, formatTimestamp, yarnStateColor, yarnStateHex } from '@/utils/format'
import { copyText } from '@/utils/clipboard'

defineOptions({ name: 'AppInfoLine' })

const props = defineProps<{
  item: YarnApp
  header: ColumnHeader
  humanize: boolean
}>()

/** 应用 ID 列:点击复制(表格行点击展开互不干扰,用 .stop 阻断) */
const isId = computed(() => props.header.value === 'id')

async function copyId() {
  const id = String(props.item.id || '')
  if (!id) return
  // 用带降级的 copyText,规避 HTTP 非安全上下文下 navigator.clipboard 不可用导致的复制失败
  const ok = await copyText(id)
  if (ok) ElMessage.success('已复制应用 ID')
  else ElMessage.error('复制失败,请手动选择复制')
}

const NUMERIC_HEADERS = new Set<keyof YarnApp>([
  'elapsedTime',
  'allocatedVCores',
  'allocatedMB',
  'runningContainers',
  'queueUsagePercentage',
  'memorySeconds',
  'vcoreSeconds',
  'clusterUsagePercentage',
  'preemptedResourceMB',
  'preemptedResourceVCores',
  'numNonAMContainerPreempted',
  'numAMContainerPreempted',
  'priority'
])

type Display =
  | { kind: 'badge'; text: string; color: StatusColor | string }
  | { kind: 'bar'; value: number; max: number; color: string }
  | { kind: 'text'; text: string; numeric: boolean }

function themePrimary(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--bd-primary').trim() || '#00b8cc'
}

const display = computed<Display>(() => {
  const h = props.header.value
  const v = props.item[h]
  if (h === 'state') {
    return { kind: 'badge', text: String(v), color: yarnStateHex(String(v)) ?? yarnStateColor(String(v)) }
  }
  if (h === 'startedTime' || h === 'finishedTime') {
    return { kind: 'text', text: formatTimestamp(Number(v), props.humanize), numeric: false }
  }
  if (h === 'elapsedTime') {
    return { kind: 'text', text: formatElapsed(Number(v), props.humanize), numeric: false }
  }
  if (h === 'progress') {
    return { kind: 'bar', value: Math.round(Number(v) * 100), max: 100, color: themePrimary() }
  }
  if (h === 'queueUsagePercentage' || h === 'clusterUsagePercentage') {
    return { kind: 'bar', value: Math.round(Number(v)), max: 100, color: themePrimary() }
  }
  if (h === 'allocatedVCores') {
    return { kind: 'bar', value: Number(v), max: Math.max(Number(v), 64), color: themePrimary() }
  }
  if (h === 'allocatedMB') {
    return { kind: 'bar', value: Number(v), max: Math.max(Number(v), 8192), color: themePrimary() }
  }
  const text = v === null || v === undefined ? '' : String(v)
  return { kind: 'text', text, numeric: NUMERIC_HEADERS.has(h) }
})

const barPct = computed(() => {
  if (display.value.kind !== 'bar') return 0
  return display.value.max > 0 ? Math.min(100, (display.value.value / display.value.max) * 100) : 0
})
</script>

<template>
  <StatusBadge
    v-if="display.kind === 'badge'"
    :label="display.text"
    :type="typeof display.color === 'string' ? undefined : display.color"
    :color="typeof display.color === 'string' ? display.color : undefined"
  />
  <span v-else-if="display.kind === 'bar'" class="cell-bar">
    <span class="bar-track">
      <span class="bar-fill" :style="{ width: `${barPct}%`, background: display.color }" />
    </span>
    <span class="bar-value">{{ display.value }}</span>
  </span>
  <span
    v-else
    :class="{ 'cell-numeric': display.numeric, 'cell-copy': isId }"
    :title="isId ? '点击复制应用 ID' : undefined"
    @click.stop="isId ? copyId() : undefined"
  >{{ display.text }}</span>
</template>

<style scoped lang="scss">
.cell-bar {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 96px;
}

.bar-track {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: $border;
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
}

.bar-value {
  font-size: 12px;
  color: $muted;
}

.cell-numeric {
  font-variant-numeric: tabular-nums;
  display: inline-block;
}

/* 应用 ID:点击复制提示(悬停下划线 + 复制光标) */
.cell-copy {
  cursor: copy;
  color: $primary;
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;

  &:hover {
    text-decoration: underline dotted;
  }
}
</style>
