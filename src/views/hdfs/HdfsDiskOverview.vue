<script setup lang="ts">
import { computed } from 'vue'
import type { HdfsDataNodeInfo, HdfsDiskOverview } from '@/types/hdfs'

defineOptions({ name: 'HdfsDiskOverview' })

const props = defineProps<{
  data: HdfsDiskOverview | null
  loading: boolean
}>()

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i <= 1 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

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

/** 使用率 → 进度条颜色:>=85% 红,>=60% 橙,其余主题蓝 */
function progressColor(p: number): string {
  if (p >= 85) return '#f56c6c'
  if (p >= 60) return '#e6a23c'
  return '#5e6ad2'
}

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
    <!-- 集群总览(紧凑,不挤占文件浏览) -->
    <div class="overview-strip">
      <div class="mini">
        <span class="mini-label">集群容量</span>
        <el-progress :percentage="usedPct" :stroke-width="8" :show-text="false" :color="progressColor" />
        <span class="mini-meta">{{ usedPct }}% · {{ formatSize(cluster?.CapacityUsed ?? 0) }}/{{ formatSize(cluster?.CapacityTotal ?? 0) }}</span>
      </div>
      <div class="mini">
        <span class="mini-label">剩余</span>
        <el-progress :percentage="100 - usedPct" :stroke-width="8" :show-text="false" :color="progressColor" />
        <span class="mini-meta">{{ formatSize(cluster?.CapacityRemaining ?? 0) }}</span>
      </div>
      <div class="mini">
        <span class="mini-label">非DFS</span>
        <el-progress :percentage="nonDfsPct" :stroke-width="8" :show-text="false" :color="progressColor" />
        <span class="mini-meta">{{ nonDfsPct }}% · {{ formatSize(cluster?.CapacityUsedNonDFS ?? 0) }}</span>
      </div>
      <div class="mini stat">
        <span class="mini-label">节点</span>
        <span class="mini-stat">{{ cluster?.NumLiveDataNodes ?? 0 }} 在线 / {{ cluster?.NumDeadDataNodes ?? 0 }} 离线</span>
        <span class="mini-meta">块 {{ cluster?.BlocksTotal ?? 0 }} · 负载 {{ cluster?.TotalLoad ?? 0 }}</span>
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
            <template #default="{ row }">{{ formatSize(row.usedSpace) }} / {{ formatSize(row.capacity) }}</template>
          </el-table-column>
          <el-table-column label="剩余" width="100" align="right">
            <template #default="{ row }">{{ formatSize(row.remaining) }}</template>
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

.empty {
  color: $muted;
  font-size: 13px;
  padding: 16px 0;
  text-align: center;
}

@media (max-width: 1100px) {
  .overview-strip {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
