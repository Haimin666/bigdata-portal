<script setup lang="ts">
import { computed } from 'vue'
import { formatBytes, progressColor } from '@/utils/format'
import type { HdfsDataNodeInfo, HdfsDiskOverview } from '@/types/hdfs'
import EChart from '@/components/EChart.vue'
import type { EChartsOption } from 'echarts'

defineOptions({ name: 'HdfsDiskOverview' })

const props = defineProps<{
  data: HdfsDiskOverview | null
  loading: boolean
}>()

// ── 集群维度 ─────────────────────────────────────────────
const cluster = computed(() => props.data?.cluster)
const usedPct = computed(() => {
  const t = cluster.value?.CapacityTotal ?? 0
  const u = cluster.value?.CapacityUsed ?? 0
  return t > 0 ? Math.min(100, Math.round((u / t) * 100)) : 0
})
const nonDfsPct = computed(() => {
  const t = cluster.value?.CapacityTotal ?? 0
  const n = cluster.value?.CapacityUsedNonDFS ?? 0
  return t > 0 ? Math.min(100, Math.round((n / t) * 100)) : 0
})

// ── 集群容量环形图(echarts:已用/非DFS/剩余)──
const diskChartOption = computed<EChartsOption>(() => {
  const total = cluster.value?.CapacityTotal ?? 0
  const used = cluster.value?.CapacityUsed ?? 0
  const nonDfs = cluster.value?.CapacityUsedNonDFS ?? 0
  const remaining = Math.max(0, total - used - nonDfs)
  return {
    tooltip: {
      trigger: 'item',
      formatter: (pp: unknown) => {
        const p = pp as { name?: string; value?: number }
        return `${p.name}: ${formatBytes(p.value ?? 0)}(${total > 0 ? Math.round((p.value ?? 0) / total * 100) : 0}%)`
      }
    },
    series: [
      {
        name: '集群容量',
        type: 'pie',
        radius: ['62%', '82%'],
        label: { show: false },
        itemStyle: { borderRadius: 3 },
        data: [
          { name: '数据已用', value: used, itemStyle: { color: '#e6645c' } },
          { name: '非 DFS', value: nonDfs, itemStyle: { color: '#e6a23c' } },
          { name: '剩余', value: remaining, itemStyle: { color: '#67c23a' } }
        ]
      }
    ]
  }
})

// ── 节点维度 ─────────────────────────────────────────────
function nodeUsedPct(n: HdfsDataNodeInfo): number {
  return n.capacity > 0 ? Math.min(100, Math.round((n.usedSpace / n.capacity) * 100)) : 0
}

function nodeState(n: HdfsDataNodeInfo): string {
  return n.adminState ?? 'In Service'
}
</script>

<template>
  <div class="hdfs-disk" v-loading="loading">
    <!-- 集群总览(紧凑,不挤占文件浏览):左环形图 + 右进度条组 -->
    <div class="overview-strip with-chart">
      <div class="disk-ring">
        <EChart :option="diskChartOption" height="150px" />
        <span class="ring-center">{{ usedPct }}%</span>
      </div>
      <div class="strip-rest">
      <div class="mini">
        <span class="mini-label">集群容量</span>
        <el-progress :percentage="usedPct" :stroke-width="8" :show-text="false" :color="progressColor" />
        <span class="mini-meta">{{ usedPct }}% · {{ formatBytes(cluster?.CapacityUsed ?? 0) }}/{{ formatBytes(cluster?.CapacityTotal ?? 0) }}</span>
      </div>
      <div class="mini">
        <span class="mini-label">剩余</span>
        <el-progress :percentage="100 - usedPct" :stroke-width="8" :show-text="false" :color="progressColor" />
        <span class="mini-meta">{{ formatBytes(cluster?.CapacityRemaining ?? 0) }}</span>
      </div>
      <div class="mini">
        <span class="mini-label">非DFS</span>
        <el-progress :percentage="nonDfsPct" :stroke-width="8" :show-text="false" :color="progressColor" />
        <span class="mini-meta">{{ nonDfsPct }}% · {{ formatBytes(cluster?.CapacityUsedNonDFS ?? 0) }}</span>
      </div>
      <div class="mini stat">
        <span class="mini-label">节点</span>
        <span class="mini-stat">{{ cluster?.NumLiveDataNodes ?? 0 }} 在线 / {{ cluster?.NumDeadDataNodes ?? 0 }} 离线</span>
        <span class="mini-meta">块 {{ cluster?.BlocksTotal ?? 0 }} · 负载 {{ cluster?.TotalLoad ?? 0 }}</span>
      </div>
      </div>
    </div>

    <!-- DataNode 明细(默认收起) -->
    <el-collapse v-if="data?.nodes.length" class="node-collapse">
      <el-collapse-item title="DataNode 磁盘明细" name="nodes">
        <el-table :data="data.nodes" border class="node-table" size="small">
          <el-table-column prop="host" label="节点" min-width="200" show-overflow-tooltip />
          <el-table-column label="磁盘使用" min-width="180">
            <template #default="{ row }">
              <div class="node-usage">
                <el-progress :percentage="nodeUsedPct(row)" :stroke-width="8" :show-text="false" :color="progressColor" />
                <span class="node-usage-num">{{ nodeUsedPct(row) }}%</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="已用 / 容量" min-width="160">
            <template #default="{ row }">{{ formatBytes(row.usedSpace) }} / {{ formatBytes(row.capacity) }}</template>
          </el-table-column>
          <el-table-column label="剩余" width="100" align="right">
            <template #default="{ row }">{{ formatBytes(row.remaining) }}</template>
          </el-table-column>
          <el-table-column label="块数" width="90" align="right">
            <template #default="{ row }">{{ row.numBlocks ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="nodeState(row) === 'In Service' ? 'success' : 'warning'" size="small">{{ nodeState(row) }}</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<style scoped lang="scss">
.hdfs-disk {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.with-chart {
  display: flex;
  gap: 12px;
}

.disk-ring {
  position: relative;
  width: 190px;
  flex-shrink: 0;
}

.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 600;
  color: $text;
  pointer-events: none;
}

.strip-rest {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  flex: 1;
  min-width: 0;
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

.node-collapse {
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;

  :deep(.el-collapse-item__header) {
    font-size: 13px;
    font-weight: 600;
    color: $text;
    padding: 0 12px;
  }

  :deep(.el-collapse-item__content) {
    padding: 0 12px 10px;
  }
}

.node-usage {
  display: flex;
  align-items: center;
  gap: 6px;

  .el-progress {
    flex: 1;
    margin: 0;
  }
}

.node-usage-num {
  width: 42px;
  text-align: right;
  font-size: 12px;
  color: $muted;
}

@media (max-width: 1100px) {
  .overview-strip {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
