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

const clusterHasData = computed(() => (cluster.value?.CapacityTotal ?? 0) > 0)
</script>

<template>
  <div class="hdfs-disk" v-loading="loading">
    <!-- 集群总览 -->
    <div class="overview-cards">
      <div class="disk-card">
        <div class="card-head">
          <span class="card-title">集群容量</span>
          <span class="card-num">{{ usedPct }}%</span>
        </div>
        <el-progress
          :percentage="usedPct"
          :stroke-width="14"
          :show-text="false"
          :color="progressColor"
        />
        <div class="card-foot">
          已用 {{ formatSize(cluster?.CapacityUsed ?? 0) }} /
          总量 {{ formatSize(cluster?.CapacityTotal ?? 0) }}
        </div>
      </div>

      <div class="disk-card">
        <div class="card-head">
          <span class="card-title">剩余空间</span>
          <span class="card-num">{{ formatSize(cluster?.CapacityRemaining ?? 0) }}</span>
        </div>
        <el-progress
          :percentage="100 - usedPct"
          :stroke-width="14"
          :show-text="false"
          :color="progressColor"
        />
        <div class="card-foot">剩余 / 总量占比 {{ 100 - usedPct }}%</div>
      </div>

      <div class="disk-card">
        <div class="card-head">
          <span class="card-title">非 DFS 占用</span>
          <span class="card-num">{{ nonDfsPct }}%</span>
        </div>
        <el-progress
          :percentage="nonDfsPct"
          :stroke-width="14"
          :show-text="false"
          :color="progressColor"
        />
        <div class="card-foot">
          {{ formatSize(cluster?.CapacityUsedNonDFS ?? 0) }} / 总量
          {{ formatSize(cluster?.CapacityTotal ?? 0) }}
        </div>
      </div>

      <div class="disk-card disk-card--stats">
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-label">块数</div>
            <div class="stat-value">{{ cluster?.BlocksTotal ?? 0 }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">活跃节点</div>
            <div class="stat-value">{{ cluster?.NumLiveDataNodes ?? 0 }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">宕机节点</div>
            <div class="stat-value" :class="{ danger: (cluster?.NumDeadDataNodes ?? 0) > 0 }">
              {{ cluster?.NumDeadDataNodes ?? 0 }}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">节点负载</div>
            <div class="stat-value">{{ cluster?.TotalLoad ?? 0 }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 单节点明细 -->
    <div class="node-panel">
      <div class="panel-title">DataNode 磁盘明细</div>
      <el-table v-if="data?.nodes.length" :data="data.nodes" border class="node-table">
        <el-table-column prop="host" label="节点" min-width="240" show-overflow-tooltip />
        <el-table-column label="磁盘使用" min-width="220">
          <template #default="{ row }">
            <div class="node-usage">
              <el-progress
                :percentage="nodeUsedPct(row)"
                :stroke-width="10"
                :show-text="false"
                :color="progressColor"
              />
              <span class="node-usage-num">{{ nodeUsedPct(row) }}%</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="已用 / 容量" min-width="200">
          <template #default="{ row }">
            {{ formatSize(row.usedSpace) }} / {{ formatSize(row.capacity) }}
          </template>
        </el-table-column>
        <el-table-column label="剩余" min-width="110" align="right">
          <template #default="{ row }">{{ formatSize(row.remaining) }}</template>
        </el-table-column>
        <el-table-column label="块数" width="110" align="right">
          <template #default="{ row }">{{ row.numBlocks ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="nodeState(row) === 'In Service' ? 'success' : 'warning'" size="small">
              {{ nodeState(row) }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <div v-else-if="!clusterHasData" class="empty">暂无磁盘数据(NameNode JMX 不可达)</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.hdfs-disk {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.overview-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.disk-card {
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 14px 16px;
}

.card-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 10px;
}

.card-title {
  font-size: 14px;
  color: $muted;
}

.card-num {
  font-size: 22px;
  font-weight: 600;
  color: $text;
}

.card-foot {
  margin-top: 8px;
  font-size: 12px;
  color: $muted;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px 16px;
  height: 100%;
  align-content: center;
}

.stat-label {
  font-size: 12px;
  color: $muted;
}

.stat-value {
  font-size: 16px;
  font-weight: 600;
  margin-top: 2px;
  color: $text;

  &.danger {
    color: #f56c6c;
  }
}

.node-panel {
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

.node-usage {
  display: flex;
  align-items: center;
  gap: 8px;

  .el-progress {
    flex: 1;
    margin: 0;
  }
}

.node-usage-num {
  width: 48px;
  text-align: right;
  font-size: 12px;
  color: $muted;
}

.empty {
  color: $muted;
  font-size: 13px;
  padding: 20px 0;
  text-align: center;
}

@media (max-width: 1200px) {
  .overview-cards {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
