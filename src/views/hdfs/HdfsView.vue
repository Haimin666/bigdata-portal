<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowUp, Document, Folder, HomeFilled, Position, Refresh } from '@element-plus/icons-vue'
import { listStatus, fetchHdfsDiskOverview } from '@/api/hdfs'
import { formatTimestamp } from '@/utils/format'
import type { HdfsDiskOverview, HdfsFileStatus } from '@/types/hdfs'
import HdfsDiskOverviewView from './HdfsDiskOverview.vue'
import HdfsScanPanel, { type ScannedFile } from './HdfsScanPanel.vue'

defineOptions({ name: 'HdfsView' })

const route = useRoute()
const router = useRouter()

const path = ref('/')
const pathInput = ref('')
const entries = ref<HdfsFileStatus[]>([])
const loading = ref(false)
const error = ref('')

// 磁盘总览(集群 + 单节点,经 NameNode JMX)
const diskData = ref<HdfsDiskOverview | null>(null)
const diskLoading = ref(false)

async function loadDisk() {
  diskLoading.value = true
  try {
    diskData.value = await fetchHdfsDiskOverview()
  } catch {
    diskData.value = null
  } finally {
    diskLoading.value = false
  }
}

// ── 磁盘检测(大/小文件,由自建服务经 /api/hdfs/scan 提供)────────
const scanPanel = ref<InstanceType<typeof HdfsScanPanel>>()
// 服务未部署时隐藏检测入口:启动时探测一次,失败则标记不可用
const scanAvailable = ref(true)

async function onScan() {
  try {
    const res = await fetch('/api/hdfs/scan')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as {
      code?: number
      data?: { scanTime?: string; files?: ScannedFile[] }
    }
    if (data.code !== 0 || !data.data) throw new Error(data.code ? '扫描失败' : '无数据')
    scanPanel.value?.onScanResult({ scanTime: data.data.scanTime, files: data.data.files ?? [] })
    scanPanel.value?.setScanning(false)
  } catch (e) {
    scanPanel.value?.setScanning(false)
    ElMessage.error(`磁盘检测失败:${e instanceof Error ? e.message : e}`)
  }
}

async function onScanDelete(file: ScannedFile) {
  try {
    const res = await fetch('/api/hdfs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file.path, trash: true })
    })
    const data = (await res.json()) as { code?: number; msg?: string }
    if (!res.ok || data.code !== 0) throw new Error(data.msg || `HTTP ${res.status}`)
    ElMessage.success(`已删除 ${file.path}(移入回收站)`)
    // 删除成功后重新检测
    onScan()
  } catch (e) {
    ElMessage.error(`删除失败:${e instanceof Error ? e.message : e}`)
  }
}

// 磁盘相关 30s 自动刷新(仅磁盘监控,不刷新目录列表)
let diskTimer: number | undefined
onMounted(() => {
  diskTimer = window.setInterval(() => loadDisk(), 30000)
  // 探测磁盘检测服务是否可用(自建服务未部署时隐藏入口)
  fetch('/api/hdfs/scan', { method: 'GET' })
    .then((r) => {
      if (!r.ok) scanAvailable.value = false
    })
    .catch(() => {
      scanAvailable.value = false
    })
})
onUnmounted(() => {
  if (diskTimer) clearInterval(diskTimer)
})

// 分页(前端分页:WebHDFS LISTSTATUS 不支持分页参数)
const page = ref(0)
const pageSize = ref(20)

const segments = computed(() => path.value.split('/').filter(Boolean))
const isRoot = computed(() => path.value === '/')
const parentPath = computed(() => {
  if (isRoot.value) return null
  const idx = path.value.lastIndexOf('/')
  return idx <= 0 ? '/' : path.value.slice(0, idx)
})

// 目录优先,再按名称排序
const sortedEntries = computed(() =>
  [...entries.value].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'DIRECTORY' ? -1 : 1
    return a.pathSuffix.localeCompare(b.pathSuffix)
  })
)

const pagedEntries = computed(() =>
  sortedEntries.value.slice(page.value * pageSize.value, (page.value + 1) * pageSize.value)
)

function formatSize(len: number): string {
  if (len < 1024) return `${len} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let v = len
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v.toFixed(1)} ${units[i]}`
}

async function load(dir: string): Promise<boolean> {
  path.value = dir
  loading.value = true
  error.value = ''
  try {
    entries.value = await listStatus(dir)
    page.value = 0 // 切换目录/刷新后回到第一页
    return true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    entries.value = []
    return false
  } finally {
    loading.value = false
  }
}

function goTo(segmentIndex: number) {
  load('/' + segments.value.slice(0, segmentIndex + 1).join('/'))
}

function goUp() {
  if (parentPath.value != null) load(parentPath.value)
}

function refresh() {
  load(path.value)
  loadDisk()
}

function onSizeChange(size: number) {
  pageSize.value = size
  page.value = 0
}

/** 路径定位:支持粘贴完整路径(/a/b)或相对路径(a/b,相对当前目录),回车或点按钮跳转 */
async function goToPath() {
  const raw = pathInput.value.trim()
  if (!raw) return
  const target = raw.startsWith('/')
    ? raw
    : (path.value === '/' ? '/' : path.value + '/') + raw
  // 规范化:合并重复斜杠、去除尾部斜杠
  const normalized = target.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
  pathInput.value = ''
  const ok = await load(normalized)
  if (!ok) ElMessage.error(`无法定位路径: ${normalized}`)
}

function onRowClick(row: HdfsFileStatus) {
  if (row.type !== 'DIRECTORY') return
  load(path.value === '/' ? `/${row.pathSuffix}` : `${path.value}/${row.pathSuffix}`)
}

// 进入页面时从 URL query 恢复路径;路径变化写回 query,顶栏刷新(重挂)后停留当前目录
onMounted(() => {
  const q = route.query.path
  load(typeof q === 'string' && q ? q : '/')
  loadDisk()
})

watch(path, (p) => {
  router.replace({ query: p === '/' ? {} : { path: p } })
})
</script>

<template>
  <div class="hdfs-view">
    <HdfsDiskOverviewView :data="diskData" :loading="diskLoading" />

    <HdfsScanPanel ref="scanPanel" :available="scanAvailable" @scan="onScan" @delete="onScanDelete" />

    <div class="toolbar">
      <el-input
        v-model="pathInput"
        class="path-input"
        placeholder="输入或粘贴 HDFS 路径,回车定位(如 /GPS 或 GPS/demo)"
        clearable
        @keyup.enter="goToPath"
      >
        <template #append>
          <el-button :icon="Position" @click="goToPath">定位</el-button>
        </template>
      </el-input>

      <div class="toolbar-spacer" />

      <el-tooltip content="上级目录">
        <el-button :disabled="isRoot" :icon="ArrowUp" circle @click="goUp" />
      </el-tooltip>
      <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
    </div>

    <div class="path-bar">
      <el-breadcrumb class="breadcrumb" separator="/">
        <el-breadcrumb-item>
          <el-icon><HomeFilled /></el-icon>
          <span class="crumb-link" @click="load('/')">HDFS 根目录</span>
        </el-breadcrumb-item>
        <el-breadcrumb-item v-for="(seg, i) in segments" :key="i">
          <span class="crumb-link" @click="goTo(i)">{{ seg }}</span>
        </el-breadcrumb-item>
      </el-breadcrumb>
      <span class="path-full">{{ path }}</span>
    </div>

    <el-result v-if="error" icon="error" title="加载失败" :sub-title="error">
      <template #extra>
        <el-button type="primary" @click="refresh">重试</el-button>
        <el-button v-if="!isRoot" @click="goUp">返回上级</el-button>
      </template>
    </el-result>

    <el-table
      v-else
      v-loading="loading"
      :data="pagedEntries"
      border
      class="file-table"
      @row-click="onRowClick"
    >
      <el-table-column label="名称" min-width="320" sortable>
        <template #default="{ row }">
          <span class="entry-name" :class="{ dir: row.type === 'DIRECTORY' }">
            <el-icon class="entry-icon">
              <Folder v-if="row.type === 'DIRECTORY'" />
              <Document v-else />
            </el-icon>
            {{ row.pathSuffix }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="大小" width="110" align="right" sortable>
        <template #default="{ row }">
          {{ row.type === 'DIRECTORY' ? '—' : formatSize(row.length) }}
        </template>
      </el-table-column>
      <el-table-column prop="permission" label="权限" width="90" sortable />
      <el-table-column prop="owner" label="所有者" width="150" sortable />
      <el-table-column prop="group" label="组" width="150" sortable />
      <el-table-column label="修改时间" min-width="220" sortable>
        <template #default="{ row }">
          {{ formatTimestamp(row.modificationTime, true) }}
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="空目录" />
      </template>
    </el-table>

    <div class="pagination-bar">
      <el-pagination
        :current-page="page + 1"
        :page-size="pageSize"
        :total="sortedEntries.length"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next, jumper"
        @current-change="(p: number) => (page = p - 1)"
        @size-change="onSizeChange"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.hdfs-view {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 10px 12px;
}

.path-input {
  flex: 1;
  min-width: 260px;
}

.path-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 8px 12px;
}

.path-full {
  margin-left: auto;
  font-size: 12px;
  color: $muted;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.breadcrumb {
  font-size: 14px;
}

.crumb-link {
  cursor: pointer;
  color: $text;

  &:hover {
    color: $primary;
  }
}

.toolbar-spacer {
  flex: 1;
}

.file-table {
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 8px 12px;
}

.entry-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;

  &.dir {
    cursor: pointer;
    color: $primary;
    font-weight: 500;
  }
}

.entry-icon {
  color: $muted;
}
</style>
