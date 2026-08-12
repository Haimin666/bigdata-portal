<script setup lang="ts">
import { computed } from 'vue'
import StatusBadge from '@/components/StatusBadge.vue'
import type { ColumnHeader, StatusColor, YarnApp } from '@/types/yarn'
import { formatElapsed, formatTimestamp, yarnStateColor } from '@/utils/format'

defineOptions({ name: 'AppInfoLine' })

const props = defineProps<{
  item: YarnApp
  header: ColumnHeader
  humanize: boolean
}>()

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
  | { kind: 'badge'; text: string; color: StatusColor }
  | { kind: 'bar'; value: number; max: number; color: string }
  | { kind: 'text'; text: string; numeric: boolean }

function themePrimary(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--bd-primary').trim() || '#00b8cc'
}

const display = computed<Display>(() => {
  const h = props.header.value
  const v = props.item[h]
  if (h === 'state') {
    return { kind: 'badge', text: String(v), color: yarnStateColor(String(v)) }
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
  <StatusBadge v-if="display.kind === 'badge'" :label="display.text" :type="display.color" />
  <span v-else-if="display.kind === 'bar'" class="cell-bar">
    <span class="bar-track">
      <span class="bar-fill" :style="{ width: `${barPct}%`, background: display.color }" />
    </span>
    <span class="bar-value">{{ display.value }}</span>
  </span>
  <span v-else :class="{ 'cell-numeric': display.numeric }">{{ display.text }}</span>
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
</style>
