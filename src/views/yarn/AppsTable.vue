<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ColumnHeader, YarnApp } from '@/types/yarn'
import AppInfoLine from './AppInfoLine.vue'
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
  const filtered = props.apps.filter((a) =>
    a.name.toLowerCase().includes(props.searchByAppName.toLowerCase())
  )
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
  props.rowsPerPage === -1
    ? rows.value
    : rows.value.slice(props.page * props.rowsPerPage, (props.page + 1) * props.rowsPerPage)
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

function open(url: string) {
  window.open(url, '_blank')
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
              @click.stop="open(row.trackingUrl)"
            >
              追踪UI{{ row.trackingUI ? ` - ${row.trackingUI}` : '' }}
            </el-button>
            <el-button v-if="row.amContainerLogs" link type="primary" @click.stop="open(row.amContainerLogs)">
              日志
            </el-button>
            <el-button link type="primary" @click.stop="open(`${resourceManager}/cluster/app/${row.id}`)">
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
  </div>
</template>

<style scoped lang="scss">
.apps-table {
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
  padding: 12px 16px;
  border-top: 1px solid $border;
}
</style>
