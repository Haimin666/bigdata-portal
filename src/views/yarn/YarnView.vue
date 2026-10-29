<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQuery } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { storeToRefs } from 'pinia'
import { useYarnStore } from '@/store/yarn'
import { AVAILABLE_STATES, REFRESH_INTERVALS } from '@/config/yarn'
import AppsTable from './AppsTable.vue'
import AppsCardView from './AppsCardView.vue'
import YarnOverview from './YarnOverview.vue'
import type { AppFilters } from '@/types/yarn'
import TableToolbar from '@/components/TableToolbar.vue'
import StateView from '@/components/StateView.vue'

defineOptions({ name: 'YarnView' })

const props = withDefaults(defineProps<{ active?: boolean; initialQuery?: LocationQuery }>(), { active: true })
const documentVisible = ref(document.visibilityState !== 'hidden')
const visible = computed(() => props.active && documentVisible.value)
let ready = false
let disposed = false

const store = useYarnStore()
const route = useRoute()
const router = useRouter()

const { rms, apps, queues, availableUsers, availableAppTypes, headers, metrics, queueTree } = storeToRefs(store)

// 偏好:通过 computed 包装 store.setPref 以便 v-model
const humanizeModel = computed({
  get: () => store.humanize,
  set: (v: boolean) => store.setPref('humanize', v)
})
const autoRefreshModel = computed({
  get: () => store.autoRefresh,
  set: (v: boolean) => store.setPref('autoRefresh', v)
})
const refreshIntervalModel = computed({
  get: () => store.refreshInterval,
  set: (v: number) => store.setPref('refreshInterval', v)
})
const viewStyleModel = computed({
  get: () => store.viewStyle,
  set: (v: 'table' | 'card') => store.setPref('viewStyle', v)
})

// 分页状态
const page = ref(0)
const rowsPerPage = ref(16)
const tableDensity = ref<'large' | 'default' | 'small'>('default')
const killLoadingId = ref('')

// ── URL 筛选同步 ─────────────────────────────────────────────
let filtersFromUrl = false
// URL 原本是否有筛选 query(applyFiltersFromQuery 时记录)
let hadQuery = false
// 首次 watch 触发是否已消费(区分"初始化写入"与"用户后续操作")
let initialized = false

function applyFiltersFromQuery() {
  const qs = props.initialQuery ?? route.query
  hadQuery = Object.keys(qs).length > 0
  store.filters.states = qs.states ? String(qs.states).split(',').filter(Boolean) : ['RUNNING']
  store.filters.appTypes = qs.applicationTypes
    ? String(qs.applicationTypes).split(',').filter(Boolean)
    : []
  store.filters.user = String(qs.user ?? '')
  store.filters.queue = String(qs.queue ?? '')
  filtersFromUrl = true
  initialized = false
}

watch(
  () => ({ ...store.filters }),
  (f: AppFilters) => {
    if (!filtersFromUrl || !props.active) return
    // 首次触发是初始化写入:仅当 URL 原本有 query 才写回(保持 URL 与筛选一致),
    // 否则跳过——避免篡改地址栏 + 与导航(router.push)竞态导致页面不跳转
    if (!initialized) {
      initialized = true
      if (!hadQuery) return
    }
    const query: Record<string, string> = {}
    if (f.states.length) query.states = f.states.join(',')
    if (f.user) query.user = f.user
    if (f.appTypes.length) query.applicationTypes = f.appTypes.join(',')
    if (f.queue) query.queue = f.queue
    router.replace({ query })
  },
  { deep: true }
)

// 连续筛选变更合并请求；名称/ID 搜索仍由列表本地即时过滤。
let filterTimer: number | undefined
watch(
  () => store.filters,
  () => {
    if (filterTimer) clearTimeout(filterTimer)
    if (!ready || !visible.value) return
    filterTimer = window.setTimeout(() => {
      filterTimer = undefined
      page.value = 0
      void store.loadApps()
    }, 200)
  },
  { deep: true }
)

watch(() => store.rm, () => {
  if (ready && visible.value) void refreshAll()
})

let timer: number | undefined
let refreshPromise: Promise<void> | undefined
let refreshRm = ''
async function refreshAll() {
  if (disposed) return
  // 同 RM 合并刷新；切 RM 立即发起新请求，不等待旧 RM 的慢响应。
  const rm = store.rm
  if (refreshPromise && refreshRm === rm) return refreshPromise
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = undefined
  refreshRm = rm
  const promise = Promise.all([store.loadMetrics(), store.loadQueues(), store.loadApps()]).then(() => undefined)
  refreshPromise = promise
  try {
    await promise
  } finally {
    if (refreshPromise === promise) {
      refreshPromise = undefined
      scheduleRefresh()
    }
  }
}

function scheduleRefresh() {
  if (timer) clearTimeout(timer)
  timer = undefined
  if (disposed || refreshPromise || !ready || !visible.value || !store.autoRefresh) return
  timer = window.setTimeout(async () => {
    timer = undefined
    await refreshAll()
    scheduleRefresh()
  }, store.refreshInterval * 1000)
}

watch([visible, () => store.autoRefresh, () => store.refreshInterval], ([shown], [wasShown]) => {
  if (timer) clearTimeout(timer)
  timer = undefined
  if (!shown && filterTimer) {
    clearTimeout(filterTimer)
    filterTimer = undefined
  }
  if (!ready) return
  if (shown && !wasShown) void refreshAll().finally(scheduleRefresh)
  else scheduleRefresh()
})

function onVisibilityChange() {
  documentVisible.value = document.visibilityState !== 'hidden'
}
onUnmounted(() => {
  disposed = true
  if (timer) clearTimeout(timer)
  if (filterTimer) clearTimeout(filterTimer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  store.cancelApps()
})

// 错误提示
watch(
  () => store.error,
  (e) => {
    if (e) ElMessage.error(e)
  }
)

onMounted(async () => {
  document.addEventListener('visibilitychange', onVisibilityChange)
  applyFiltersFromQuery()
  await store.init()
  if (disposed) return
  ready = true
  if (visible.value) await refreshAll()
  scheduleRefresh()
})

// ── 交互 ─────────────────────────────────────────────────────
async function onKill(appId: string, appName: string) {
  try {
    await ElMessageBox.prompt(`请输入应用名称以确认终止: ${appName}`, '终止应用', {
      confirmButtonText: '终止',
      cancelButtonText: '取消',
      inputPlaceholder: '应用名称',
      inputErrorMessage: '应用名称不匹配',
      inputValidator: (v: string) => v === appName || '应用名称不匹配'
    })
  } catch {
    return // 用户取消
  }
  killLoadingId.value = appId
  try {
    await store.kill(appId)
    ElMessage.success(`已请求终止 ${appName},请刷新确认`)
  } catch (e) {
    ElMessage.error(`终止 ${appName} 失败: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    killLoadingId.value = ''
  }
}

function onManualRefresh() {
  void refreshAll()
}

const visibleHeaderValues = computed(() =>
  store.headers.filter((h) => h.visible).map((h) => h.value)
)

function applyVisibility(vals: Array<string | number | boolean>) {
  const set = new Set(vals.map(String))
  store.headers.forEach((h) => {
    h.visible = set.has(String(h.value))
  })
}

function onPageChange(p: number) {
  page.value = p
}

function onRowsChange(s: number) {
  rowsPerPage.value = s
  page.value = 0
}
</script>

<template>
  <div class="yarn-view">
    <TableToolbar
      v-model:density="tableDensity"
      storage-key="yarn-apps"
      :loading="store.loading"
      @refresh="onManualRefresh"
    >
      <template #filters>
        <el-select v-model="store.rm" class="toolbar-item rm-select" placeholder="ResourceManager" filterable>
          <el-option v-for="r in rms" :key="r" :label="r" :value="r" />
        </el-select>

        <el-select
          v-model="store.filters.states"
          class="toolbar-item"
          multiple
          collapse-tags
          placeholder="按状态筛选"
        >
          <el-option v-for="s in AVAILABLE_STATES" :key="s" :label="s" :value="s" />
        </el-select>

        <el-select v-model="store.filters.user" class="toolbar-item" filterable clearable placeholder="按用户筛选">
          <el-option v-for="u in availableUsers" :key="u" :label="u" :value="u" />
        </el-select>

        <el-select v-model="store.filters.queue" class="toolbar-item" filterable clearable placeholder="按队列筛选">
          <el-option v-for="q in queues" :key="q" :label="q" :value="q" />
        </el-select>

        <el-select
          v-model="store.filters.appTypes"
          class="toolbar-item"
          multiple
          collapse-tags
          filterable
          placeholder="按类型筛选"
        >
          <el-option v-for="t in availableAppTypes" :key="t" :label="t" :value="t" />
        </el-select>

        <el-input v-model="store.searchByAppName" class="toolbar-item search-input" placeholder="按应用名/ID 搜索" clearable />
      </template>

      <template #actions>
        <el-radio-group v-model="viewStyleModel" size="default">
          <el-radio-button value="table">表格</el-radio-button>
          <el-radio-button value="card">卡片</el-radio-button>
        </el-radio-group>

        <span class="toolbar-switch" title="按下方间隔自动刷新应用列表">
          <span class="toolbar-switch-label">自动刷新</span>
          <el-switch v-model="autoRefreshModel" class="toolbar-item" />
        </span>
        <el-select v-if="store.autoRefresh" v-model="refreshIntervalModel" class="toolbar-item interval-select">
          <el-option v-for="i in REFRESH_INTERVALS" :key="i" :label="`${i}s`" :value="i" />
        </el-select>

        <span class="toolbar-switch" title="时间列显示为「绝对时间 (相对时间)」">
          <span class="toolbar-switch-label">人性化时间</span>
          <el-switch v-model="humanizeModel" class="toolbar-item" />
        </span>

        <el-popover placement="bottom" :width="260" trigger="click">
          <template #reference>
            <el-button class="toolbar-item">字段显隐</el-button>
          </template>
          <div class="field-list">
            <el-checkbox-group :model-value="visibleHeaderValues" @change="applyVisibility">
              <el-checkbox v-for="h in headers" :key="h.value" :value="h.value" :label="h.text" />
            </el-checkbox-group>
          </div>
        </el-popover>
      </template>
    </TableToolbar>

    <YarnOverview :metrics="metrics" :queue-tree="queueTree" :humanize="store.humanize" />

    <StateView
      v-if="store.error && !store.loading && !apps.length"
      mode="error"
      :description="store.error"
      @retry="onManualRefresh"
    />
    <el-alert v-else-if="store.error && apps.length" :title="store.error" type="error" show-icon :closable="false" />

    <AppsTable
      v-if="viewStyleModel === 'table' && !(store.error && !store.loading && !apps.length)"
      :apps="apps"
      :loading="store.loading"
      :humanize="store.humanize"
      :headers="headers"
      :search-by-app-name="store.searchByAppName"
      :resource-manager="store.rm"
      :page="page"
      :rows-per-page="rowsPerPage"
      :density="tableDensity"
      :kill-loading-id="killLoadingId"
      @kill="onKill"
      @page-change="onPageChange"
      @rows-change="onRowsChange"
    />
    <AppsCardView
      v-else-if="!(store.error && !store.loading && !apps.length)"
      :apps="apps"
      :loading="store.loading"
      :humanize="store.humanize"
      :headers="headers"
      :search-by-app-name="store.searchByAppName"
      :resource-manager="store.rm"
      :page="page"
      :rows-per-page="rowsPerPage"
      :kill-loading-id="killLoadingId"
      @kill="onKill"
      @page-change="onPageChange"
      @rows-change="onRowsChange"
    />
  </div>
</template>

<style scoped lang="scss">
.yarn-view {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
}

.toolbar-item {
  max-width: 220px;
}

/* 开关可读性:之前只有 tooltip,不看悬停不知道是什么 */
.toolbar-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.toolbar-switch-label {
  font-size: 12px;
  color: $muted;
}

.yarn-view :deep(.data-toolbar) {
  align-items: flex-start;
}

.yarn-view :deep(.toolbar-filters),
.yarn-view :deep(.toolbar-actions) {
  min-height: 32px;
}

.rm-select {
  min-width: 260px;
  max-width: 380px;
}

.search-input {
  width: 200px;
}

.interval-select {
  width: 90px;
}

.field-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow: auto;
}
</style>
