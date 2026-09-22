<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ColumnHeader, YarnApp } from '@/types/yarn'
import AppInfoLine from './AppInfoLine.vue'
import UrlFrameDialog from '@/components/UrlFrameDialog.vue'
import { ROWS_PER_PAGE_OPTIONS } from '@/config/yarn'

defineOptions({ name: 'AppsTable' })

const props = defineProps<{
  apps: YarnApp[]
  loading: boolean
  humanize: boolean
  headers: ColumnHeader[]
  searchByAppName: string
  resourceManager: string
  page: number
  rowsPerPage: number
}>()

const emit = defineEmits<{
  (e: 'kill', appId: string, appName: string): void
  (e: 'page-change', page: number): void
  (e: 'rows-change', rows: number): void
}>()

const visibleHeaders = computed(() => props.headers.filter((h) => h.visible))

const sortBy = ref<string | null>(null)
const sortDir = ref<'asc' | 'desc'>('asc')

const rows = computed(() => {
  const kw = props.searchByAppName.trim().toLowerCase()
  const filtered = props.apps.filter((a) => {
    if (!kw) return true
    return (
      a.name.toLowerCase().includes(kw) ||
      a.id.toLowerCase().includes(kw)
    )
  })
  if (!sortBy.value) return filtered
  const dir = sortDir.value === 'asc' ? 1 : -1
  return [...filtered].sort((a, b) => {
    const av = a[sortBy.value as keyof YarnApp]
    const bv = b[sortBy.value as keyof YarnApp]
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
    return String(av).localeCompare(String(bv)) * dir
  })
})

const paged = computed(() =>
  rows.value.slice(props.page * props.rowsPerPage, (props.page + 1) * props.rowsPerPage)
)

const tableRef = ref()

// ── 展开状态跨刷新保持:轮询/刷新会整体替换行对象,el-table 按对象身份记忆展开态
// 会全部塌缩;改为按 appId 记录,数据更新后对仍在本页的行强制恢复展开 ──
const expandedIds = ref<Set<string>>(new Set())

function onExpandChange(_row: YarnApp, expandedRows: YarnApp[]) {
  expandedIds.value = new Set(expandedRows.map((r) => r.id))
}

watch(paged, async () => {
  if (!expandedIds.value.size) return
  await nextTick()
  for (const row of paged.value) {
    if (expandedIds.value.has(row.id)) tableRef.value?.toggleRowExpansion(row, true)
  }
})

function onSortChange({ prop, order }: { prop: string; order: 'ascending' | 'descending' | null }) {
  if (!order) {
    sortBy.value = null
    return
  }
  sortBy.value = prop
  sortDir.value = order === 'ascending' ? 'asc' : 'desc'
}

function onRowClick(row: YarnApp) {
  tableRef.value?.toggleRowExpansion(row)
}

function onPageChange(p: number) {
  emit('page-change', p - 1)
}

function onSizeChange(s: number) {
  emit('rows-change', s)
}

// 追踪UI iframe 弹窗 + 资源管理器重建弹窗;日志入口已移除(原 window.open 新窗口)
const frameShow = ref(false)
const frameUrl = ref('')
const frameTitle = ref('')
function open(url: string, title?: string) {
  frameUrl.value = url
  frameTitle.value = title || '查看'
  frameShow.value = true
}
/** 追踪UI → RM 的 /proxy/{appId}/ 同构代理,子页面/静态资源可跟随 */
function trackingProxyUrl(appId: string): string {
  return `/yarniframe/proxy/${appId}/`
}
/** 资源管理器 → iframe 打开 RM 原生 /cluster/app/{appId}(经 /yarniframe 同构代理) */
function openResource(row: { id: string; name?: string }): void {
  open(`/yarniframe/cluster/app/${row.id}`, `资源管理 - ${row.name || row.id}`)
}
</script>

<template>
  <div class="apps-table">
    <el-table
      ref="tableRef"
      :data="paged"
      v-loading="loading"
      size="small"
      border
      class="apps-table-el"
      @sort-change="onSortChange"
      @row-click="onRowClick"
      @expand-change="onExpandChange"
    >
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button
              v-if="row.trackingUrl"
              link
              type="primary"
              @click.stop="open(trackingProxyUrl(row.id), `追踪UI${row.trackingUI ? ` - ${row.trackingUI}` : ''} - ${row.name}`)"
            >
              追踪UI{{ row.trackingUI ? ` - ${row.trackingUI}` : '' }}
            </el-button>
            <el-button link type="primary" @click.stop="openResource(row)">
              资源管理器
            </el-button>
            <el-button link type="danger" @click.stop="emit('kill', row.id, row.name)">
              终止应用
            </el-button>
          </div>
        </template>
      </el-table-column>
      <el-table-column
        v-for="h in visibleHeaders"
        :key="h.value"
        :prop="h.value"
        :label="h.text"
        :sortable="h.sortable ? 'custom' : false"
        :min-width="h.width"
        show-overflow-tooltip
      >
        <template #default="{ row }">
          <AppInfoLine :item="row" :header="h" :humanize="humanize" />
        </template>
      </el-table-column>
      <template #empty>
        <span>{{ loading ? '' : '无数据' }}</span>
      </template>
    </el-table>
    <el-pagination
      class="apps-pagination"
      :current-page="page + 1"
      :page-size="rowsPerPage"
      :page-sizes="ROWS_PER_PAGE_OPTIONS"
      :total="rows.length"
      layout="total, sizes, prev, pager, next, jumper"
      @current-change="onPageChange"
      @size-change="onSizeChange"
    />

    <!-- 追踪UI / 资源管理器 iframe 弹窗(共用) -->
    <UrlFrameDialog v-model="frameShow" :url="frameUrl" :title="frameTitle" />
  </div>
</template>

<style scoped lang="scss">
.apps-table {
  flex-shrink: 0;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  overflow: hidden;
}

.apps-table-el {
  width: 100%;
}

.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 16px;
}

.apps-pagination {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 10px 12px;
  border-top: 1px solid $border;
}
</style>
