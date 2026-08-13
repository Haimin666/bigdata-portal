<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ColumnHeader, YarnApp } from '@/types/yarn'
import AppInfoLine from './AppInfoLine.vue'
import UrlFrameDialog from '@/components/UrlFrameDialog.vue'
import YarnResourceDialog from './YarnResourceDialog.vue'
import FlinkUiDialog from './FlinkUiDialog.vue'
import SparkUiDialog from './SparkUiDialog.vue'
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
/** 资源管理器 → 重建 RM UI 弹窗(接真实 REST,经门户代理) */
const resShow = ref(false)
const resApp = ref<{ id: string; name: string; user?: string } | null>(null)
function openResource(row: { id: string; name?: string; user?: string }): void {
  resApp.value = { id: row.id, name: row.name || row.id, user: row.user }
  resShow.value = true
}

/** Flink UI / Spark UI → 重建弹窗(按 applicationType 显示) */
const flinkShow = ref(false)
const sparkShow = ref(false)
const uiApp = ref<{ id: string; name: string } | null>(null)
function isFlink(row: { applicationType?: string }): boolean {
  return /flink/i.test(row.applicationType || '')
}
function isSpark(row: { applicationType?: string }): boolean {
  return /spark/i.test(row.applicationType || '')
}
function openFlink(row: { id: string; name?: string }): void {
  uiApp.value = { id: row.id, name: row.name || row.id }
  flinkShow.value = true
}
function openSpark(row: { id: string; name?: string }): void {
  uiApp.value = { id: row.id, name: row.name || row.id }
  sparkShow.value = true
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
            <el-button v-if="isFlink(row)" link type="primary" @click.stop="openFlink(row)">
              Flink UI
            </el-button>
            <el-button v-if="isSpark(row)" link type="primary" @click.stop="openSpark(row)">
              Spark UI
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

    <!-- 追踪UI iframe 弹窗 -->
    <UrlFrameDialog v-model="frameShow" :url="frameUrl" :title="frameTitle" />

    <!-- 资源管理器:重建 RM UI 弹窗 -->
    <YarnResourceDialog
      v-if="resApp"
      v-model="resShow"
      :app-id="resApp.id"
      :app-name="resApp.name"
      :user="resApp.user || 'root'"
      :rm-host="props.resourceManager"
    />
    <!-- Flink UI:重建弹窗 -->
    <FlinkUiDialog
      v-if="uiApp"
      v-model="flinkShow"
      :app-id="uiApp.id"
      :app-name="uiApp.name"
      :rm="props.resourceManager"
    />
    <!-- Spark UI:重建弹窗(4 tab + 10s 自动刷新) -->
    <SparkUiDialog
      v-if="uiApp"
      v-model="sparkShow"
      :app-id="uiApp.id"
      :app-name="uiApp.name"
      :rm="props.resourceManager"
    />
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
