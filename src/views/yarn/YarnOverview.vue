<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ClusterMetrics, QueueResources } from '@/types/yarn'
import { formatMem, progressColor } from '@/utils/format'
import EChart from '@/components/EChart.vue'
import type { EChartsOption } from 'echarts'

defineOptions({ name: 'YarnOverview' })

const props = defineProps<{
  metrics: ClusterMetrics
  queueTree: QueueResources[]
  humanize: boolean
}>()

// ── 总资源 ─────────────────────────────────────────────
const memTotal = computed(() => props.metrics.totalMB ?? 0)
const memUsed = computed(() => props.metrics.allocatedMB ?? 0)
const memPercent = computed(() =>
  memTotal.value > 0 ? Math.min(100, Math.round((memUsed.value / memTotal.value) * 100)) : 0
)
const vcTotal = computed(() => props.metrics.totalVirtualCores ?? 0)
const vcUsed = computed(() => props.metrics.allocatedVirtualCores ?? 0)
const vcPercent = computed(() =>
  vcTotal.value > 0 ? Math.min(100, Math.round((vcUsed.value / vcTotal.value) * 100)) : 0
)

// ── 队列资源 ───────────────────────────────────────────
/** 队列内存配额:capacity 调度 = 集群总量 × 绝对容量;fair 调度 = maxResources(硬上限),缺失回退公平份额/集群总量 */
function queueMemQuota(q: QueueResources): number {
  if (q.scheduler === 'fair') {
    if (q.quotaMemory > 0) return q.quotaMemory
    if (q.fairMemory) return q.fairMemory
    return memTotal.value
  }
  if (q.absoluteCapacity > 0) return (memTotal.value * q.absoluteCapacity) / 100
  return memTotal.value
}

/** 队列 vCores 配额 */
function queueVcQuota(q: QueueResources): number {
  if (q.scheduler === 'fair') {
    if (q.quotaVCores > 0) return q.quotaVCores
    if (q.fairVCores) return q.fairVCores
    return vcTotal.value
  }
  if (q.absoluteCapacity > 0) return (vcTotal.value * q.absoluteCapacity) / 100
  return vcTotal.value
}

function memUsage(q: QueueResources): number {
  const quota = queueMemQuota(q)
  return quota > 0 ? Math.min(100, Math.round((q.memory / quota) * 100)) : 0
}

function vcUsage(q: QueueResources): number {
  const quota = queueVcQuota(q)
  return quota > 0 ? Math.min(100, Math.round((q.vCores / quota) * 100)) : 0
}

function queueMemText(q: QueueResources): string {
  return `${formatMem(q.memory, props.humanize)} / ${formatMem(queueMemQuota(q), props.humanize)}`
}

function queueVcText(q: QueueResources): string {
  return `${q.vCores} / ${Math.round(queueVcQuota(q))}`
}

/** 配置列文案:capacity 调度显示容量%,fair 调度显示权重/配额 */
function queueConfigText(q: QueueResources): string {
  if (q.scheduler === 'fair') {
    return q.weight > 0 ? `权重 ${q.weight}` : '公平调度'
  }
  return `${q.capacity}%`
}

const hasData = computed(() => memTotal.value > 0 || props.queueTree.length > 0)

// ── 队列内存占比图(echarts 横向条形;只取一级队列,含子级聚合)──
const queueChartOption = computed<EChartsOption>(() => {
  const roots = props.queueTree
  const names = roots.map((q) => q.queueName)
  // used/quota 百分比(与表格 memUsage 同源)
  const pcts = roots.map((q) => memUsage(q))
  const usedMem = roots.map((q) => Math.round(q.memory / 1024)) // GiB 展示
  return {
    tooltip: {
      trigger: 'item',
      formatter: (pp: unknown) => {
        const p = pp as { name?: string; value?: number; dataIndex?: number }
        const i = p.dataIndex ?? 0
        const q = roots[i]
        if (!q) return ''
        return `<b>${q.queueName}</b><br/>已用 ${formatMem(q.memory, props.humanize)} / 配额 ${formatMem(queueMemQuota(q), props.humanize)}<br/>占用 ${memUsage(q)}% · 活跃应用 ${q.numActiveApps ?? 0}`
      }
    },
    grid: { left: 8, right: 40, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' }, splitLine: { show: false } },
    yAxis: { type: 'category', data: names, inverse: true, axisTick: { show: false } },
    series: [
      {
        name: '内存占用',
        type: 'bar',
        data: pcts,
        barMaxWidth: 14,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: {
          show: true,
          position: 'right',
          formatter: (pp: unknown) => {
          const p = pp as { dataIndex?: number }
          return `${pcts[p.dataIndex ?? 0]}% · ${usedMem[p.dataIndex ?? 0]}Gi`
        },
          fontSize: 11,
          color: '#8a94a3'
        }
      }
    ]
  }
})

// 队列树刷新后保持用户上次手动展开的行:
// 不再用 tableKey 重建表格(会丢展开态),数据更新时对已展开的 queueName 重新 toggleRowExpansion。
const tableRef = ref()
const expandedQueues = ref<Set<string>>(new Set())
function onExpandChange(_row: QueueResources, expandedRows: QueueResources[]) {
  const names = new Set(expandedRows.map((r) => r.queueName))
  expandedQueues.value = names
}
watch(
  () => props.queueTree,
  async () => {
    await nextTick()
    for (const name of expandedQueues.value) {
      const row = props.queueTree.find((q) => q.queueName === name)
      if (row) tableRef.value?.toggleRowExpansion(row, true)
    }
  }
)
</script>

<template>
  <div class="yarn-overview">
    <!-- 总资源(紧凑条):内存 / CPU / 节点 / 应用 -->
    <div class="overview-strip">
      <div class="mini">
        <span class="mini-label">内存</span>
        <el-progress :percentage="memPercent" :stroke-width="8" :show-text="false" :color="progressColor" />
        <span class="mini-meta">{{ memPercent }}% · {{ formatMem(memUsed, humanize) }}/{{ formatMem(memTotal, humanize) }}</span>
      </div>
      <div class="mini">
        <span class="mini-label">CPU (vCores)</span>
        <el-progress :percentage="vcPercent" :stroke-width="8" :show-text="false" :color="progressColor" />
        <span class="mini-meta">{{ vcPercent }}% · {{ vcUsed }}/{{ vcTotal }}</span>
      </div>
      <div class="mini stat">
        <span class="mini-label">节点</span>
        <span class="mini-stat">{{ metrics.activeNodes ?? 0 }} 在线 / {{ metrics.totalNodes ?? 0 }} 总数</span>
        <span class="mini-meta">运行 {{ metrics.appsRunning ?? 0 }} · 排队 {{ metrics.appsPending ?? 0 }}</span>
      </div>
      <div class="mini stat">
        <span class="mini-label">容器</span>
        <span class="mini-stat">{{ metrics.containersAllocated ?? 0 }} 已分配</span>
        <span class="mini-meta">排队 {{ metrics.containersPending ?? 0 }}</span>
      </div>
    </div>

    <!-- 各队列资源使用情况(树形) -->
    <div class="queue-panel">
      <div class="panel-title">队列资源使用</div>
      <!-- 一级队列内存占用占比图(echarts) -->
      <div v-if="queueTree.length" class="queue-chart">
        <EChart :option="queueChartOption" height="180px" />
      </div>
      <el-table
        v-if="queueTree.length"
        ref="tableRef"
        :data="queueTree"
        row-key="queueName"
        :tree-props="{ children: 'children' }"
        @expand-change="onExpandChange"
      >
        <el-table-column prop="queueName" label="队列" min-width="170" />
        <el-table-column label="配置" width="110">
          <template #default="{ row }">
            <el-tooltip v-if="row.scheduler === 'capacity'" :content="`绝对容量 ${row.absoluteCapacity}%`" placement="top">
              <span>{{ queueConfigText(row) }}</span>
            </el-tooltip>
            <span v-else>{{ queueConfigText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="内存 (已用/配额)" min-width="210">
          <template #default="{ row }">
            <div class="queue-res">
              <el-progress :percentage="memUsage(row)" :stroke-width="10" :show-text="false" :color="progressColor" />
              <span class="queue-res-num">{{ queueMemText(row) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="vCores (已用/配额)" min-width="170">
          <template #default="{ row }">
            <div class="queue-res">
              <el-progress :percentage="vcUsage(row)" :stroke-width="10" :show-text="false" :color="progressColor" />
              <span class="queue-res-num">{{ queueVcText(row) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="应用 (活跃/排队)" width="140">
          <template #default="{ row }">{{ row.numActiveApps ?? 0 }} / {{ row.numPendingApps ?? 0 }}</template>
        </el-table-column>
      </el-table>
      <div v-else-if="!hasData" class="empty">暂无集群指标或队列数据</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.yarn-overview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex-shrink: 0;
}

.overview-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 8px 12px;
}

.mini {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.mini-label {
  font-size: 12px;
  color: $muted;
}

.mini-meta {
  font-size: 12px;
  color: $text;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mini.stat {
  justify-content: center;
}

.mini-stat {
  font-size: 13px;
  font-weight: 600;
  color: $text;
}

.queue-chart {
  margin-bottom: 10px;
}

.queue-panel {
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 12px 16px;
}

.panel-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 10px;
  color: $text;
}

.queue-res {
  display: flex;
  align-items: center;
  gap: 8px;

  .el-progress {
    flex: 1;
    margin: 0;
  }
}

.queue-res-num {
  min-width: 96px;
  text-align: right;
  font-size: 12px;
  color: $muted;
  white-space: nowrap;
}

.empty {
  color: $muted;
  font-size: 13px;
  padding: 20px 0;
  text-align: center;
}

@media (max-width: 1100px) {
  .overview-strip {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
