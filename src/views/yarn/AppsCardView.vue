<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ColumnHeader, YarnApp } from '@/types/yarn'
import AppInfoLine from './AppInfoLine.vue'
import UrlFrameDialog from '@/components/UrlFrameDialog.vue'
import { ROWS_PER_PAGE_OPTIONS } from '@/config/yarn'

defineOptions({ name: 'AppsCardView' })

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

const rows = computed(() => {
  const kw = props.searchByAppName.trim().toLowerCase()
  return props.apps.filter((a) => {
    if (!kw) return true
    return (
      a.name.toLowerCase().includes(kw) ||
      a.id.toLowerCase().includes(kw)
    )
  })
})

const paged = computed(() =>
  rows.value.slice(props.page * props.rowsPerPage, (props.page + 1) * props.rowsPerPage)
)

// 追踪 iframe 弹窗 + 资源管理器重建弹窗;日志入口已移除
const frameShow = ref(false)
const frameUrl = ref('')
const frameTitle = ref('')
function open(url: string, title?: string) {
  frameUrl.value = url
  frameTitle.value = title || '查看'
  frameShow.value = true
}
/** 追踪 → RM 的 /proxy/{appId}/ 同构代理 */
function trackingProxyUrl(appId: string): string {
  return `/yarniframe/proxy/${appId}/`
}
/** 资源管理器 → iframe 打开 RM 原生 /cluster/app/{appId}(经 /yarniframe 同构代理) */
function openResource(row: { id: string; name?: string }): void {
  open(`/yarniframe/cluster/app/${row.id}`, `资源管理 - ${row.name || row.id}`)
}

function onPageChange(p: number) {
  emit('page-change', p - 1)
}

function onSizeChange(s: number) {
  emit('rows-change', s)
}
</script>

<template>
  <div class="apps-card-view" v-loading="loading">
    <el-row :gutter="16">
      <el-col v-for="app in paged" :key="app.id" :xs="24" :sm="12" :md="8" :lg="6">
        <el-card class="app-card" shadow="never">
          <div class="app-name" :title="app.name">{{ app.name }}</div>
          <el-divider class="app-divider" />
          <div v-for="h in visibleHeaders" :key="h.value" class="app-field">
            <span class="field-label">{{ h.text }}</span>
            <span class="field-value">
              <AppInfoLine :item="app" :header="h" :humanize="humanize" />
            </span>
          </div>
          <div class="card-actions">
            <el-button
              v-if="app.trackingUrl"
              size="small"
              @click="open(trackingProxyUrl(app.id), `追踪 - ${app.name}`)"
            >
              追踪
            </el-button>
            <el-button size="small" @click="openResource(app)">
              资源管理器
            </el-button>
            <el-button size="small" type="danger" @click="emit('kill', app.id, app.name)">
              终止
            </el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>
    <div v-if="rows.length === 0 && !loading" class="card-empty">无数据</div>
    <el-pagination
      class="apps-pagination"
      :current-page="page + 1"
      :page-size="rowsPerPage"
      :page-sizes="ROWS_PER_PAGE_OPTIONS"
      :total="rows.length"
      layout="total, sizes, prev, pager, next"
      @current-change="onPageChange"
      @size-change="onSizeChange"
    />

    <!-- 追踪 / 资源管理器 iframe 弹窗(共用) -->
    <UrlFrameDialog v-model="frameShow" :url="frameUrl" :title="frameTitle" />
  </div>
</template>

<style scoped lang="scss">
.apps-card-view {
  flex-shrink: 0;
}

.app-card {
  margin-bottom: 16px;
}

.app-name {
  font-weight: 600;
  font-size: 14px;
  color: $text;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.app-divider {
  margin: 8px 0;
}

.app-field {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 0;
}

.field-label {
  font-size: 12px;
  color: $muted;
  flex-shrink: 0;
}

.field-value {
  text-align: right;
  max-width: 60%;
  word-break: break-all;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}

.card-empty {
  text-align: center;
  color: $muted;
  padding: 24px 0;
}

.apps-pagination {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 10px 12px;
  border-top: 1px solid $border;
  background: $panel;
  border-radius: 0 0 6px 6px;
}
</style>
