<script setup lang="ts">
/** Spark UI 重建弹窗:4 tab 接真实 REST(经门户 /api/yarn-resource/proxy)
 *  Jobs / Stages / Executors / Environment + 应用头
 *  打开后默认 10s 自动刷新(可暂停)
 *  数据源:RM 的 /proxy/{appId}/api/v1/... → Spark REST API
 */
import { ref, onMounted, onUnmounted } from 'vue'
import DialogMaxBtn from '@/components/DialogMaxBtn.vue'

const props = defineProps<{
  modelValue: boolean
  appId: string
  appName: string
  rm: string
}>()
const emit = defineEmits(['update:modelValue'])

const BASE = (path: string) =>
  `/api/yarn-resource/proxy?url=${encodeURIComponent(`${props.rm}/proxy/${props.appId}/api/v1/applications/${props.appId}${path}`)}`

const tab = ref<'jobs' | 'stages' | 'executors' | 'env'>('jobs')
const loading = ref(false)
const errMsg = ref('')
const lastTs = ref('')
const autoRefresh = ref(true)
const fs = ref(false)

const appInfo = ref<any>(null)
const jobs = ref<any[]>([])
const stages = ref<any[]>([])
const executors = ref<any[]>([])
const env = ref<any>(null)
const envFilter = ref('')

let timer: number | undefined

async function getJson(path: string): Promise<any> {
  const r = await fetch(BASE(path), { signal: AbortSignal.timeout(20000) })
  const text = await r.text()
  if (!r.ok) {
    // 404 常见:应用已结束,RM /proxy/{appId} 只代理运行中应用;或 AM 尚未注册
    const hint =
      r.status === 404
        ? '应用已结束或 RM proxy 暂不可用(REST 仅对运行中应用有效)'
        : `HTTP ${r.status}`
    throw new Error(`${hint}: ${path}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    // 偶发:RM 返回 HTML(404 页/登录页)而非 JSON,给可读提示而非 "Unexpected token '<'"
    throw new Error(`响应不是 JSON(可能返回了 HTML 页面): ${path} — ${text.slice(0, 80)}`)
  }
}

async function refreshAll() {
  loading.value = true
  errMsg.value = ''
  try {
    const [apps, j, s, e, en] = await Promise.all([
      getJson(''),
      getJson('/jobs'),
      getJson('/stages'),
      getJson('/executors'),
      getJson('/environment')
    ])
    appInfo.value = (Array.isArray(apps) ? apps : []).find((a: any) => a.id === props.appId) || apps
    jobs.value = j || []
    stages.value = s || []
    executors.value = e || []
    env.value = en || null
    lastTs.value = new Date().toLocaleTimeString()
  } catch (err: any) {
    // 保留上一次成功数据,仅提示刷新失败(避免 404 时整窗空白)
    errMsg.value = `刷新失败:${String(err.message || err)}`
  } finally {
    loading.value = false
  }
}

function toggleAuto() {
  autoRefresh.value = !autoRefresh.value
  if (autoRefresh.value) start()
  else if (timer) clearInterval(timer)
}
function start() {
  if (timer) clearInterval(timer)
  timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') refreshAll()
  }, 10000)
}

const stateCls: Record<string, string> = {
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  COMPLETE: 'succeeded',
  FAILED: 'failed',
  UNKNOWN: 'neutral',
  KILLED: 'killed',
  ACTIVE: 'running',
  PENDING: 'queued',
  QUEUED: 'queued'
}
function clsOf(s: string) {
  return stateCls[s] || 'neutral'
}
function fmtTs(t: string | number) {
  if (!t) return '—'
  if (typeof t === 'string') {
    const d = new Date(t)
    return isNaN(d.getTime()) ? t : d.toLocaleString('zh-CN', { hour12: false })
  }
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}
function fmtDurMs(ms: number) {
  if (ms == null || !isFinite(ms)) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}.${Math.floor((ms % 1000) / 100)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
function fmtBytes(n: number) {
  if (n == null || isNaN(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}
function progress(done: number, total: number) {
  return total ? Math.round((done / total) * 100) : 0
}
function envEntries(): { k: string; v: string }[] {
  const sp = env.value?.sparkProperties || {}
  const f = envFilter.value.trim().toLowerCase()
  return Object.entries(sp)
    .map(([k, v]) => ({ k, v: String(v) }))
    .filter((x) => !f || x.k.toLowerCase().includes(f) || x.v.toLowerCase().includes(f))
}

onMounted(refreshAll)
onMounted(() => start())
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    width="1080px"
    top="4vh"
    class="spark-ui-dialog"
    :fullscreen="fs"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="sud-dlg-head">
        <span class="sud-dlg-title">Spark UI - {{ appName }}</span>
        <div class="sud-dlg-actions">
          <DialogMaxBtn :fs="fs" @toggle="fs = !fs" />
        </div>
      </div>
    </template>
    <div class="sud-topbar">
      <div class="tabs">
        <button :class="['sud-tab', { active: tab === 'jobs' }]" @click="tab = 'jobs'">Jobs</button>
        <button :class="['sud-tab', { active: tab === 'stages' }]" @click="tab = 'stages'">Stages</button>
        <button :class="['sud-tab', { active: tab === 'executors' }]" @click="tab = 'executors'">Executors</button>
        <button :class="['sud-tab', { active: tab === 'env' }]" @click="tab = 'env'">Environment</button>
      </div>
      <div class="spacer"></div>
      <span v-if="lastTs" class="sud-ts">更新于 {{ lastTs }}</span>
      <el-switch
        v-model="autoRefresh"
        size="small"
        active-text="10s 自动刷新"
        style="--el-switch-on-color: var(--bd-primary)"
        @change="toggleAuto"
      />
      <el-button size="small" :loading="loading" @click="refreshAll">刷新</el-button>
    </div>

    <el-alert v-if="errMsg" type="error" :title="errMsg" show-icon class="sud-err" @close="errMsg = ''" />

    <!-- 应用头 -->
    <div class="sud-apphead" v-if="appInfo">
      <span class="name">{{ appInfo.name || appName }}</span>
      <span class="mono-id">{{ appInfo.id }}</span>
      <span class="kv"><span class="k">用户</span><b>{{ appInfo.attempts?.[0]?.sparkUser || '—' }}</b></span>
      <span class="kv"><span class="k">开始</span><b>{{ fmtTs(appInfo.attempts?.[0]?.startTime) }}</b></span>
      <span class="kv"><span class="k">耗时</span><b>{{ fmtDurMs(appInfo.attempts?.[0]?.duration) }}</b></span>
      <span class="kv"><span class="k">状态</span><span class="sud-badge" :class="clsOf(appInfo.attempts?.[0]?.completed ? 'SUCCEEDED' : 'RUNNING')">{{ appInfo.attempts?.[0]?.completed ? 'COMPLETED' : 'RUNNING' }}</span></span>
    </div>

    <div v-loading="loading">
      <!-- ── Jobs ── -->
      <div v-show="tab === 'jobs'" class="sud-panel">
        <div class="head"><span class="t">JOBS</span><span class="spacer"></span><span class="m">/api/v1/applications/:id/jobs</span></div>
        <el-table :data="jobs" size="small" :height="fs ? 'calc(100vh - 260px)' : '52vh'">
          <el-table-column label="Job ID" prop="jobId" width="80" />
          <el-table-column label="描述" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="sud-desc">{{ row.name }}</span>
              <span v-if="row.jobGroup" class="mono-id" style="margin-left:6px">· {{ row.jobGroup }}</span>
            </template>
          </el-table-column>
          <el-table-column label="提交时间" width="170">
            <template #default="{ row }">{{ fmtTs(row.submissionTime) }}</template>
          </el-table-column>
          <el-table-column label="耗时" width="110">
            <template #default="{ row }">
              {{ row.completionTime ? fmtDurMs(new Date(row.completionTime).getTime() - new Date(row.submissionTime).getTime()) : '运行中' }}
            </template>
          </el-table-column>
          <el-table-column label="Stages" width="150">
            <template #default="{ row }">
              <span class="sud-stages">{{ row.numCompletedStages }}/{{ row.stageIds?.length || row.numActiveStages + row.numCompletedStages }} 完成 · {{ row.numActiveStages }} 活跃</span>
            </template>
          </el-table-column>
          <el-table-column label="Tasks" width="180">
            <template #default="{ row }">
              <div class="sud-prog">
                <div class="bar"><div class="fill" :style="{ width: progress(row.numCompletedTasks, row.numTasks) + '%' }"></div></div>
                <span class="cnt">{{ row.numCompletedTasks }}/{{ row.numActiveTasks }}活跃/{{ row.numTasks }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }"><span class="sud-badge" :class="clsOf(row.status)">{{ row.status }}</span></template>
          </el-table-column>
        </el-table>
      </div>

      <!-- ── Stages ── -->
      <div v-show="tab === 'stages'" class="sud-panel">
        <div class="head"><span class="t">STAGES</span><span class="spacer"></span><span class="m">/api/v1/applications/:id/stages · {{ stages.length }} 条</span></div>
        <el-table :data="stages" size="small" :height="fs ? 'calc(100vh - 260px)' : '52vh'">
          <el-table-column label="Stage" width="90">
            <template #default="{ row }"><span class="mono-id">{{ row.stageId }} / {{ row.attemptId }}</span></template>
          </el-table-column>
          <el-table-column label="描述" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">{{ row.details || row.description || '—' }}</template>
          </el-table-column>
          <el-table-column label="提交 / 完成" width="180">
            <template #default="{ row }">{{ fmtTs(row.submissionTime) }}<br><span class="mono-id">{{ row.completionTime ? fmtTs(row.completionTime) : '运行中' }}</span></template>
          </el-table-column>
          <el-table-column label="Tasks" width="200">
            <template #default="{ row }">
              <div class="sud-prog">
                <div class="bar"><div class="fill" :style="{ width: progress(row.numCompleteTasks, row.numTasks) + '%' }"></div></div>
                <span class="cnt">{{ row.numCompleteTasks }} 完成 · {{ row.numActiveTasks }} 活跃 · {{ row.numFailedTasks }} 失败 / {{ row.numTasks }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }"><span class="sud-badge" :class="clsOf(row.status)">{{ row.status }}</span></template>
          </el-table-column>
        </el-table>
      </div>

      <!-- ── Executors ── -->
      <div v-show="tab === 'executors'" class="sud-panel">
        <div class="head"><span class="t">EXECUTORS</span><span class="spacer"></span><span class="m">/api/v1/applications/:id/executors · {{ executors.length }} 个</span></div>
        <el-table :data="executors" size="small" :height="fs ? 'calc(100vh - 260px)' : '52vh'">
          <el-table-column label="ID" prop="id" width="80" />
          <el-table-column label="地址" prop="hostPort" min-width="180" show-overflow-tooltip />
          <el-table-column label="状态" width="100">
            <template #default="{ row }"><span class="sud-badge" :class="row.isActive ? 'running' : 'killed'">{{ row.isActive ? 'ACTIVE' : 'DEAD' }}</span></template>
          </el-table-column>
          <el-table-column label="Cores" prop="totalCores" width="70" />
          <el-table-column label="内存" width="110">
            <template #default="{ row }"><span>{{ fmtBytes(row.memoryUsed) }} <span class="mono-id">/ {{ fmtBytes(row.maxMemory) }}</span></span></template>
          </el-table-column>
          <el-table-column label="Tasks" width="170">
            <template #default="{ row }">{{ row.completedTasks }} 完成 · {{ row.activeTasks }} 活跃 · {{ row.failedTasks }} 失败</template>
          </el-table-column>
          <el-table-column label="GC 时间" width="100">
            <template #default="{ row }">{{ fmtDurMs(row.totalGCTime) }}</template>
          </el-table-column>
          <el-table-column label="Shuffle" width="150">
            <template #default="{ row }">读 {{ fmtBytes(row.totalShuffleRead) }} / 写 {{ fmtBytes(row.totalShuffleWrite) }}</template>
          </el-table-column>
        </el-table>
      </div>

      <!-- ── Environment ── -->
      <div v-show="tab === 'env'" class="sud-panel">
        <div class="head">
          <span class="t">ENVIRONMENT · sparkProperties</span>
          <span class="spacer"></span>
          <el-input v-model="envFilter" size="small" placeholder="过滤 key/value…" clearable style="width: 220px" />
        </div>
        <div class="sud-env" style="max-height: 52vh; overflow: auto">
          <div v-for="e in envEntries()" :key="e.k" class="r"><span class="k">{{ e.k }}</span><span class="v">{{ e.v }}</span></div>
          <div v-if="!envEntries().length" class="sud-empty">无配置项(或过滤无结果)</div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
.spark-ui-dialog :deep(.el-dialog__body) { padding: 8px 16px 16px; }
.sud-dlg-head {
  display: flex; align-items: center; justify-content: space-between;
  padding-right: 12px;
  .sud-dlg-title { font-size: 15px; font-weight: 700; letter-spacing: 1px; color: $text; }
  .sud-dlg-actions { display: flex; align-items: center; }
}
.sud-topbar {
  display: flex; align-items: center; gap: 12px;
  border-bottom: 1px solid var(--bd-border); margin-bottom: 10px;
  .spacer { flex: 1; }
}
.tabs { display: flex; gap: 2px; }
.sud-tab {
  background: transparent; border: none; cursor: pointer;
  font-family: inherit; font-size: 13px; letter-spacing: 1px;
  color: var(--bd-muted); padding: 8px 12px;
  border-bottom: 2px solid transparent; transition: color .15s, border-color .15s;
  &:hover { color: var(--bd-text); }
  &.active { color: var(--bd-primary); border-bottom-color: var(--bd-primary); }
}
.sud-ts { color: var(--bd-muted); font-size: 11px; }
.sud-err { margin-bottom: 10px; }
.sud-apphead {
  display: flex; flex-wrap: wrap; gap: 8px 26px; align-items: center;
  border: 1px solid var(--bd-border); border-radius: 8px;
  padding: 12px 16px; margin-bottom: 12px; background: var(--bd-panel);
  .name { font-size: 15px; font-weight: 700; color: var(--bd-primary); }
  .kv { display: flex; gap: 6px; font-size: 12px; align-items: center; .k { color: var(--bd-muted); } }
}
.sud-panel {
  border: 1px solid var(--bd-border); border-radius: 8px;
  background: var(--bd-panel); overflow: hidden;
  .head {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 14px; border-bottom: 1px solid var(--bd-border);
    background: var(--bd-panel-sub);
    .t { font-size: 12px; letter-spacing: 2px; color: var(--bd-muted); }
    .m { font-size: 11px; color: var(--bd-muted); }
  }
}
.sud-badge {
  display: inline-block; padding: 2px 9px; border-radius: 10px;
  font-size: 11px; font-weight: 600;
  &.running { color: #3b82f6; background: color-mix(in srgb, #3b82f6 14%, transparent); }
  &.succeeded { color: #10b981; background: color-mix(in srgb, #10b981 14%, transparent); }
  &.failed { color: #ef4444; background: color-mix(in srgb, #ef4444 14%, transparent); }
  &.killed { color: #6b7280; background: color-mix(in srgb, #6b7280 14%, transparent); }
  &.queued { color: #f59e0b; background: color-mix(in srgb, #f59e0b 14%, transparent); }
  &.neutral { color: var(--bd-muted); background: color-mix(in srgb, var(--bd-muted) 14%, transparent); }
}
.mono-id { color: var(--bd-muted); font-size: 11px; font-family: var(--el-font-family); }
.sud-desc { color: var(--bd-primary); }
.sud-stages { font-size: 12px; color: var(--bd-text); }
.sud-prog {
  display: flex; flex-direction: column; gap: 3px;
  .bar { height: 5px; border-radius: 3px; background: var(--bd-panel-sub); overflow: hidden; .fill { height: 100%; background: var(--bd-primary); border-radius: 3px; } }
  .cnt { font-size: 11px; color: var(--bd-muted); }
}
.sud-env {
  padding: 8px 14px 4px;
  .r { display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid color-mix(in srgb, var(--bd-border) 55%, transparent); font-size: 12px; }
  .k { color: var(--bd-muted); min-width: 260px; word-break: break-all; flex-shrink: 0; }
  .v { color: var(--bd-text); word-break: break-all; }
}
.sud-empty { color: var(--bd-muted); font-size: 12px; padding: 14px; }
</style>
