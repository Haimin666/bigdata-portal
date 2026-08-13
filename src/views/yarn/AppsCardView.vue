<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ColumnHeader, YarnApp } from '@/types/yarn'
import AppInfoLine from './AppInfoLine.vue'
import UrlFrameDialog from '@/components/UrlFrameDialog.vue'
import YarnResourceDialog from './YarnResourceDialog.vue'
import FlinkUiDialog from './FlinkUiDialog.vue'
import SparkUiDialog from './SparkUiDialog.vue'
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
/** 资源管理器(卡片视图称「详情」)→ 重建 RM UI 弹窗 */
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
            <el-button v-if="isFlink(app)" size="small" @click="openFlink(app)">
              Flink UI
            </el-button>
            <el-button v-if="isSpark(app)" size="small" @click="openSpark(app)">
              Spark UI
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

    <!-- 追踪 / 日志 / 详情 iframe 弹窗 -->
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
