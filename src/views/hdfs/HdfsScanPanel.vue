<script setup lang="ts">
import { ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Delete } from '@element-plus/icons-vue'

// 磁盘检测:手动触发,扫描大/小文件,支持清理(二次确认 + 移回收站)
defineOptions({ name: 'HdfsScanPanel' })

export interface ScannedFile {
  path: string
  size: number
  blocks?: number
  mtime?: number
}

defineProps<{
  /** 扫描服务是否可用(服务未部署时为 false,隐藏检测入口) */
  available: boolean
}>()

const emit = defineEmits<{
  scan: []
  delete: [file: ScannedFile]
}>()

const scanning = ref(false)
const result = ref<{ scanTime?: string; files: ScannedFile[] } | null>(null)

const bigFiles = ref<ScannedFile[]>([])
const smallFiles = ref<ScannedFile[]>([])
const activeTab = ref<'big' | 'small'>('big')

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

function startScan() {
  if (scanning.value) return
  scanning.value = true
  emit('scan')
}

/** 父组件(HdfsView)拿到扫描结果后调用 */
function onScanResult(data: { scanTime?: string; files: ScannedFile[] }) {
  result.value = data
  const files = [...data.files].sort((a, b) => b.size - a.size)
  bigFiles.value = files.slice(0, 20)
  smallFiles.value = [...files].sort((a, b) => a.size - b.size).slice(0, 20)
  activeTab.value = 'big'
}

function onDelete(file: ScannedFile) {
  void ElMessageBox.confirm(
    `确定删除文件「${file.path}」(${formatSize(file.size)})吗?删除后将移入 HDFS 回收站。`,
    '删除确认',
    { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
  )
    .then(() => emit('delete', file))
    .catch(() => undefined)
}

defineExpose({
  onScanResult,
  setScanning: (v: boolean) => {
    scanning.value = v
  }
})
</script>

<template>
  <div v-if="available" class="hdfs-scan">
    <div class="scan-head">
      <span class="scan-title">磁盘检测</span>
      <el-button
        size="small"
        :icon="Delete"
        :loading="scanning"
        type="primary"
        plain
        @click="startScan"
      >
        {{ scanning ? '检测中…' : '检测大/小文件' }}
      </el-button>
      <span v-if="result?.scanTime" class="scan-time">上次检测:{{ result.scanTime }}</span>
    </div>

    <div v-if="bigFiles.length" class="scan-result">
      <el-tabs v-model="activeTab" size="small">
        <el-tab-pane :label="`大文件 (${bigFiles.length})`" name="big">
          <el-table :data="bigFiles" size="small" border class="scan-table" max-height="300">
            <el-table-column label="路径" min-width="280" show-overflow-tooltip>
              <template #default="{ row }">{{ row.path }}</template>
            </el-table-column>
            <el-table-column label="大小" width="110" align="right" sortable>
              <template #default="{ row }">{{ formatSize(row.size) }}</template>
            </el-table-column>
            <el-table-column label="块数" width="80" align="right">
              <template #default="{ row }">{{ row.blocks ?? '—' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="80" fixed="right">
              <template #default="{ row }">
                <el-button link type="danger" size="small" @click="onDelete(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`小文件 (${smallFiles.length})`" name="small">
          <el-table :data="smallFiles" size="small" border class="scan-table" max-height="300">
            <el-table-column label="路径" min-width="280" show-overflow-tooltip>
              <template #default="{ row }">{{ row.path }}</template>
            </el-table-column>
            <el-table-column label="大小" width="110" align="right" sortable>
              <template #default="{ row }">{{ formatSize(row.size) }}</template>
            </el-table-column>
            <el-table-column label="块数" width="80" align="right">
              <template #default="{ row }">{{ row.blocks ?? '—' }}</template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<style scoped lang="scss">
.hdfs-scan {
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 2px;
}

.scan-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.scan-title {
  font-size: 13px;
  font-weight: 600;
  color: $text;
}

.scan-time {
  font-size: 12px;
  color: $muted;
}

.scan-result {
  margin-top: 8px;
}
</style>
