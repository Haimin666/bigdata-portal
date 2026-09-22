<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { storeToRefs } from 'pinia'
import { useYarnStore } from '@/store/yarn'
import { AVAILABLE_STATES, REFRESH_INTERVALS } from '@/config/yarn'
import AppsTable from './AppsTable.vue'
import AppsCardView from './AppsCardView.vue'
import YarnOverview from './YarnOverview.vue'
import type { AppFilters } from '@/types/yarn'

defineOptions({ name: 'YarnView' })

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })

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

// ── URL 筛选同步 ─────────────────────────────────────────────
let filtersFromUrl = false
// URL 原本是否有筛选 query(applyFiltersFromQuery 时记录)
let hadQuery = false
// 首次 watch 触发是否已消费(区分"初始化写入"与"用户后续操作")
let initialized = false

function applyFiltersFromQuery() {
  const qs = route.query
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
    if (!filtersFromUrl) return
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

// 筛选变化 → 重新拉取
watch(
  () => store.filters,
  () => store.loadApps(),
  { deep: true }
)

// RM 切换 → 重新拉取指标、队列与应用
watch(
  () => store.rm,
  () => {
    store.loadMetrics()
    store.loadQueues()
    store.loadApps()
  }
)

// 自动刷新
let timer: number | undefined
watch(
  [() => store.autoRefresh, () => store.refreshInterval],
  ([auto, interval]) => {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    if (auto && props.active)
      timer = window.setInterval(() => {
        store.loadMetrics()
        store.loadQueues()
        store.loadApps()
      }, interval * 1000)
  },
  { immediate: true }
)
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

watch(
  () => props.active,
  (active) => {
    if (!active) return
    store.loadMetrics()
    store.loadQueues()
    store.loadApps()
  }
)

// 错误提示
watch(
  () => store.error,
  (e) => {
    if (e) ElMessage.error(e)
  }
)

onMounted(async () => {
  applyFiltersFromQuery()
  await store.init()
  store.loadMetrics()
  store.loadQueues()
  store.loadApps()
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
  try {
    await store.kill(appId)
    ElMessage.success(`已请求终止 ${appName},请刷新确认`)
  } catch (e) {
    ElMessage.error(`终止 ${appName} 失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function onManualRefresh() {
  store.loadMetrics()
  store.loadQueues()
  store.loadApps()
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
    <div class="toolbar">
      <div class="filter-row">
        <el-select v-model="store.rm" class="rm-select" placeholder="ResourceManager" filterable>
          <el-option v-for="r in rms" :key="r" :label="r" :value="r" />
        </el-select>

        <el-select
          v-model="store.filters.states"
          multiple
          collapse-tags
          placeholder="按状态筛选"
        >
          <el-option v-for="s in AVAILABLE_STATES" :key="s" :label="s" :value="s" />
        </el-select>

        <el-select
          v-model="store.filters.user"
          filterable
          clearable
          placeholder="按用户筛选"
        >
          <el-option v-for="u in availableUsers" :key="u" :label="u" :value="u" />
        </el-select>

        <el-select
          v-model="store.filters.queue"
          filterable
          clearable
          placeholder="按队列筛选"
        >
          <el-option v-for="q in queues" :key="q" :label="q" :value="q" />
        </el-select>

        <el-select
          v-model="store.filters.appTypes"
          multiple
          collapse-tags
          filterable
          placeholder="按类型筛选"
        >
          <el-option v-for="t in availableAppTypes" :key="t" :label="t" :value="t" />
        </el-select>

        <el-input
          v-model="store.searchByAppName"
          class="search-input"
          placeholder="按应用名/ID 搜索"
          clearable
        />

        <el-button class="refresh-button" @click="onManualRefresh">刷新</el-button>
      </div>

      <div class="toolbar-options">
        <el-radio-group v-model="viewStyleModel" size="default">
          <el-radio-button value="table">表格</el-radio-button>
          <el-radio-button value="card">卡片</el-radio-button>
        </el-radio-group>

        <div class="toolbar-preferences">
          <div class="toolbar-option">
            <span class="option-label">自动刷新</span>
            <el-tooltip content="自动刷新">
              <el-switch v-model="autoRefreshModel" />
            </el-tooltip>
          </div>
          <el-select
            v-if="store.autoRefresh"
            v-model="refreshIntervalModel"
            class="interval-select"
            aria-label="自动刷新间隔"
          >
            <el-option v-for="i in REFRESH_INTERVALS" :key="i" :label="`${i}s`" :value="i" />
          </el-select>

          <div class="toolbar-option">
            <span class="option-label">相对时间</span>
            <el-tooltip content="人性化时间">
              <el-switch v-model="humanizeModel" />
            </el-tooltip>
          </div>

          <el-popover placement="bottom" :width="260" trigger="click">
            <template #reference>
              <el-button>字段显隐</el-button>
            </template>
            <div class="field-list">
              <el-checkbox-group :model-value="visibleHeaderValues" @change="applyVisibility">
                <el-checkbox v-for="h in headers" :key="h.value" :value="h.value" :label="h.text" />
              </el-checkbox-group>
            </div>
          </el-popover>
        </div>
      </div>
    </div>

    <YarnOverview :metrics="metrics" :queue-tree="queueTree" :humanize="store.humanize" />

    <AppsTable
      v-if="viewStyleModel === 'table'"
      :apps="apps"
      :loading="store.loading"
      :humanize="store.humanize"
      :headers="headers"
      :search-by-app-name="store.searchByAppName"
      :resource-manager="store.rm"
      :page="page"
      :rows-per-page="rowsPerPage"
      @kill="onKill"
      @page-change="onPageChange"
      @rows-change="onRowsChange"
    />
    <AppsCardView
      v-else
      :apps="apps"
      :loading="store.loading"
      :humanize="store.humanize"
      :headers="headers"
      :search-by-app-name="store.searchByAppName"
      :resource-manager="store.rm"
      :page="page"
      :rows-per-page="rowsPerPage"
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
  gap: 12px;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
}

.toolbar {
  display: grid;
  gap: 12px;
  background: $panel;
  border: 1px solid $border;
  border-radius: var(--bd-radius);
  padding: 12px 14px;
}

.filter-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.4fr) repeat(4, minmax(110px, 1fr)) minmax(150px, 1.2fr) auto;
  gap: 6px;
  align-items: center;
}

.rm-select {
  min-width: 0;
}

.search-input {
  min-width: 0;
}

.interval-select {
  width: 90px;
}

.toolbar-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 10px;
  border-top: 1px solid $border;
}

.toolbar-preferences {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
}

.toolbar-option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.option-label {
  color: $muted;
  font-size: 13px;
}

.refresh-button {
  min-width: 68px;
}

.field-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow: auto;
}

@media (max-width: 1100px) {
  .filter-row {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .rm-select { grid-column: span 2; }
  .search-input { grid-column: span 2; }
}

@media (max-width: 640px) {
  .yarn-view { padding: 12px; gap: 10px; }
  .toolbar { padding: 10px; }
  .filter-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rm-select,
  .search-input { grid-column: 1 / -1; }
  .refresh-button { grid-column: 1 / -1; width: 100%; }
  .toolbar-options { align-items: flex-start; flex-direction: column; }
  .toolbar-preferences { width: 100%; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
}
</style>
