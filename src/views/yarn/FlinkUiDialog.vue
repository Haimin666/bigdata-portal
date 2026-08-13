<script setup lang="ts">
/** Flink UI 重建弹窗:5 tab 接真实 REST(经门户 /api/yarn-resource/proxy 转发)
 *  - Jobs / Job 详情(拓扑) / Task Managers / Job Manager / Configuration
 *  - 数据源:RM 的 /proxy/{appId}/... → Flink REST API
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import DialogMaxBtn from '@/components/DialogMaxBtn.vue'

const props = defineProps<{
  modelValue: boolean
  appId: string
  appName: string
  rm: string // 完整 RM 地址,如 http://hadoop-nn-1.bigdata.shiqiao.com:8088
}>()
const emit = defineEmits(['update:modelValue'])

const BASE = (path: string) =>
  `/api/yarn-resource/proxy?url=${encodeURIComponent(`${props.rm}/proxy/${props.appId}${path}`)}`

const tab = ref<'jobs' | 'jobDetail' | 'tm' | 'jm' | 'config'>('jobs')
const loading = ref(false)
const errMsg = ref('')
const lastTs = ref('')
const fs = ref(false)

// ── overview + jobs ──
const overview = ref<any>(null)
const jobs = ref<any[]>([])
// ── job 详情 ──
const jobDetail = ref<any>(null)
const selJob = ref<any>(null)
// ── taskmanagers ──
const tms = ref<any[]>([])
const selTm = ref<any>(null)
const tmLogFiles = ref<any[]>([])
// ── jm 日志 ──
const jmLogs = ref<any[]>([])
const curLogFile = ref('')
const logText = ref('')
const logFull = ref(false)
// ── config ──
const configs = ref<any[]>([])

let timer: number | undefined

async function getJson(path: string): Promise<any> {
  const r = await fetch(BASE(path), { signal: AbortSignal.timeout(20000) })
  const text = await r.text()
  if (!r.ok) {
    const hint =
      r.status === 404
        ? '应用已结束或 RM proxy 暂不可用(REST 仅对运行中应用有效)'
        : `HTTP ${r.status}`
    throw new Error(`${hint}: ${path}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`响应不是 JSON(可能返回了 HTML 页面): ${path} — ${text.slice(0, 80)}`)
  }
}
async function getText(path: string, maxBytes?: number): Promise<string> {
  const q = maxBytes ? `${path.includes('?') ? '&' : '?'}maxBytes=${maxBytes}` : ''
  const r = await fetch(BASE(path) + q, { signal: AbortSignal.timeout(25000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${path}`)
  return r.text()
}

async function run<T>(fn: () => Promise<T>): Promise<T | null> {
  loading.value = true
  errMsg.value = ''
  try {
    return await fn()
  } catch (e: any) {
    errMsg.value = String(e.message || e)
    return null
  } finally {
    loading.value = false
  }
}

async function loadJobs() {
  const res = await run(async () => {
    const [a, b] = await Promise.all([getJson('/overview'), getJson('/jobs/overview')])
    return { ov: a, js: b }
  })
  if (!res) return
  overview.value = res.ov
  jobs.value = res.js?.jobs || []
  lastTs.value = new Date().toLocaleTimeString()
}

async function openJob(j: any) {
  selJob.value = j
  jobDetail.value = await run(() => getJson(`/jobs/${j.jid}`))
  tab.value = 'jobDetail'
}

async function loadTm() {
  const d = await run(() => getJson('/taskmanagers'))
  if (d) tms.value = d.taskmanagers || []
  lastTs.value = new Date().toLocaleTimeString()
}

async function openTm(tm: any) {
  selTm.value = tm
  tmLogFiles.value = []
  const d = await run(() => getJson(`/taskmanagers/${tm.id}/logs`))
  if (d) tmLogFiles.value = d.logs || []
}

async function loadJmLogs() {
  const d = await run(() => getJson('/jobmanager/logs'))
  if (d) jmLogs.value = d.logs || []
}

async function openLog(path: string, full = false) {
  curLogFile.value = path
  logFull.value = full
  // 超过 2MB 的日志只取前 1MB(经后端 maxBytes 截断),避免卡死
  const maxBytes = full ? undefined : 1000000
  logText.value = (await run(() => getText(path, maxBytes))) || ''
}

async function loadConfig() {
  const d = await run(() => getJson('/config'))
  if (Array.isArray(d)) configs.value = d
  else if (d && typeof d === 'object') configs.value = Object.entries(d).map(([key, value]) => ({ key, value: String(value) }))
  lastTs.value = new Date().toLocaleTimeString()
}

const stateCls: Record<string, { cls: string; label: string }> = {
  RUNNING: { cls: 'running', label: '运行中' },
  FINISHED: { cls: 'finished', label: '已完成' },
  FAILED: { cls: 'failed', label: '失败' },
  CANCELED: { cls: 'killed', label: '已取消' },
  CREATED: { cls: 'scheduled', label: '创建' },
  SCHEDULED: { cls: 'scheduled', label: '调度中' },
  RESTARTING: { cls: 'scheduled', label: '重启中' },
  RECONCILING: { cls: 'scheduled', label: '对齐中' }
}
function stateOf(s: string) {
  return stateCls[s] || { cls: 'neutral', label: s }
}
function fmtTs(t: number) {
  if (!t || t < 0) return '—'
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}
function fmtDur(ms: number) {
  if (ms < 0 || !isFinite(ms)) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}
function fmtBytes(n: number) {
  if (n == null || isNaN(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}
function switchTab(t: any) {
  tab.value = t
  if (t === 'tm' && !tms.value.length) loadTm()
  if (t === 'jm' && !jmLogs.value.length) loadJmLogs()
  if (t === 'config' && !configs.value.length) loadConfig()
}

/** 拓扑分层(BFS):plan.nodes → layers(computed 缓存,避免模板多次重算) */
const topoLayers = computed(() => planLayers())
function planLayers(): { nodes: any[]; edges: any[] }[] {
  const p = jobDetail.value?.plan
  if (!p) return []
  const nodes: any[] = p.nodes || []
  const edges: any[] = p.edges || []
  const indeg: Record<number, number> = {}
  const out: Record<number, number[]> = {}
  nodes.forEach((n) => { indeg[n.id] = 0; out[n.id] = [] })
  edges.forEach((e) => {
    if (out[e.source] && indeg[e.target] != null) {
      out[e.source].push(e.target)
      indeg[e.target]++
    }
  })
  let layer = nodes.filter((n) => indeg[n.id] === 0).map((n) => n.id)
  const layers: number[][] = []
  const seen = new Set<number>()
  while (layer.length) {
    layers.push(layer)
    layer.forEach((i) => seen.add(i))
    const next = new Set<number>()
    layer.forEach((i) => (out[i] || []).forEach((t) => next.add(t)))
    layer = [...next].filter((t) => !seen.has(t))
  }
  // 兜底:孤立节点
  nodes.forEach((n) => {
    if (!seen.has(n.id)) {
      layers.push([n.id])
      seen.add(n.id)
    }
  })
  return layers.map((ids) => ({
    nodes: ids.map((id) => nodes.find((n) => n.id === id)).filter(Boolean),
    edges: edges.filter((e) => ids.includes(e.source) || ids.includes(e.target))
  }))
}

onMounted(() => {
  loadJobs()
  timer = window.setInterval(() => {
    if (!document.visibilityState || document.visibilityState === 'visible') {
      if (tab.value === 'jobs') loadJobs()
      else if (tab.value === 'tm') loadTm()
      else if (tab.value === 'config') loadConfig()
    }
  }, 30000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    width="1080px"
    top="4vh"
    class="flink-ui-dialog"
    :fullscreen="fs"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="fud-dlg-head">
        <span class="fud-dlg-title">Flink UI - {{ appName }}</span>
        <div class="fud-dlg-actions">
          <DialogMaxBtn :fs="fs" @toggle="fs = !fs" />
        </div>
      </div>
    </template>
    <div class="fud-topbar">
      <div class="tabs">
        <button :class="['fud-tab', { active: tab === 'jobs' }]" @click="switchTab('jobs')">Jobs</button>
        <button
          :class="['fud-tab', { active: tab === 'jobDetail' }]"
          :disabled="!selJob"
          @click="switchTab('jobDetail')"
        >Job 详情</button>
        <button :class="['fud-tab', { active: tab === 'tm' }]" @click="switchTab('tm')">Task Managers</button>
        <button :class="['fud-tab', { active: tab === 'jm' }]" @click="switchTab('jm')">Job Manager</button>
        <button :class="['fud-tab', { active: tab === 'config' }]" @click="switchTab('config')">Configuration</button>
      </div>
      <div class="spacer"></div>
      <span v-if="lastTs" class="fud-ts">更新于 {{ lastTs }}</span>
      <el-button size="small" :loading="loading" @click="switchTab(tab)">刷新</el-button>
    </div>

    <el-alert v-if="errMsg" type="error" :title="errMsg" show-icon class="fud-err" @close="errMsg = ''" />

    <!-- ── Jobs ── -->
    <div v-show="tab === 'jobs'">
      <div class="fud-cards">
        <div class="fud-card" style="--c: var(--bd-primary)"><div class="k">JOBS RUNNING</div><div class="v">{{ overview?.['jobs-running'] ?? '—' }}</div></div>
        <div class="fud-card" style="--c: var(--el-color-success)"><div class="k">FINISHED</div><div class="v">{{ overview?.['jobs-finished'] ?? '—' }}</div></div>
        <div class="fud-card" style="--c: var(--el-color-danger)"><div class="k">FAILED</div><div class="v">{{ overview?.['jobs-failed'] ?? '—' }}</div></div>
        <div class="fud-card" style="--c: var(--bd-muted)"><div class="k">TASK MANAGERS</div><div class="v">{{ overview?.taskmanagers ?? '—' }}</div></div>
      </div>
      <div class="fud-panel">
        <div class="head"><span class="t">JOBS</span><span class="spacer"></span><span class="m">/jobs/overview</span></div>
        <el-table :data="jobs" size="small" :height="fs ? 'calc(100vh - 250px)' : '46vh'" @row-click="openJob">
          <el-table-column label="Job ID" width="130">
            <template #default="{ row }"><span class="mono-id">{{ row.jid.slice(0, 10) }}…</span></template>
          </el-table-column>
          <el-table-column label="名称" prop="name" min-width="200" show-overflow-tooltip />
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <span class="fud-badge" :class="stateOf(row.state).cls">{{ row.state }}</span>
            </template>
          </el-table-column>
          <el-table-column label="开始时间" width="170">
            <template #default="{ row }">{{ fmtTs(row['start-time']) }}</template>
          </el-table-column>
          <el-table-column label="耗时" width="120">
            <template #default="{ row }">{{ fmtDur(row.duration) }}</template>
          </el-table-column>
          <el-table-column label="任务" width="180">
            <template #default="{ row }">
              <span class="fud-taskline">{{ row.tasks?.running ?? 0 }} 运行 / {{ row.tasks?.finished ?? 0 }} 完成 / {{ row.tasks?.total ?? 0 }} 总</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <!-- ── Job 详情 ── -->
    <div v-show="tab === 'jobDetail'" v-loading="loading">
      <div class="fud-panel" v-if="jobDetail">
        <div class="head">
          <span class="t">JOB OVERVIEW</span><span class="spacer"></span>
          <span class="fud-badge" :class="stateOf(jobDetail.state).cls">{{ jobDetail.state }}</span>
        </div>
        <div class="fud-kv">
          <div class="r"><span class="k">Job ID</span><span class="v mono-id">{{ jobDetail.jid }}</span></div>
          <div class="r"><span class="k">Name</span><span class="v">{{ jobDetail.name }}</span></div>
          <div class="r"><span class="k">开始 / 结束</span><span class="v">{{ fmtTs(jobDetail['start-time']) }} → {{ fmtTs(jobDetail['end-time']) }}（{{ fmtDur(jobDetail.duration) }}）</span></div>
          <div class="r"><span class="k">状态计数</span><span class="v">{{ JSON.stringify(jobDetail['status-counts']) }}</span></div>
        </div>
      </div>
      <div class="fud-panel">
        <div class="head"><span class="t">拓扑</span><span class="spacer"></span><span class="m">StreamGraph · 点击 Job 行进入</span></div>
        <div class="fud-topo" v-if="topoLayers.length">
          <template v-for="(l, li) in topoLayers" :key="li">
            <div class="fud-layer">
              <template v-for="(n, ni) in l.nodes" :key="n.id">
                <div v-if="ni" class="fud-arrow">→</div>
                <div class="fud-node">
                  <div class="t">{{ n.operator || 'operator' }}</div>
                  <div class="n" :title="n.description">{{ n.description }}</div>
                  <div class="sub">并行度 {{ n.parallelism }}</div>
                </div>
              </template>
            </div>
            <div v-if="li < topoLayers.length - 1" class="fud-edge-line">
              <span class="fud-edge-arrow" />
            </div>
          </template>
        </div>
        <div v-else class="fud-empty">无拓扑数据(plan 为空)</div>
      </div>
      <div class="fud-panel" v-if="jobDetail">
        <div class="head"><span class="t">VERTICES</span><span class="spacer"></span><span class="m">/jobs/:jid</span></div>
        <el-table :data="jobDetail.vertices || []" size="small" :height="fs ? 'calc(100vh - 460px)' : '26vh'">
          <el-table-column label="名称" prop="name" min-width="180" show-overflow-tooltip />
          <el-table-column label="并行度" prop="parallelism" width="90" />
          <el-table-column label="状态" width="120">
            <template #default="{ row }"><span class="fud-badge" :class="stateOf(row.status).cls">{{ row.status }}</span></template>
          </el-table-column>
          <el-table-column label="完成" width="80">
            <template #default="{ row }">{{ row.tasks?.finished ?? 0 }}/{{ row.tasks?.total ?? 0 }}</template>
          </el-table-column>
          <el-table-column label="Records In" width="120">
            <template #default="{ row }">{{ (row.metrics?.['read-records'] ?? 0).toLocaleString() }}</template>
          </el-table-column>
          <el-table-column label="Records Out" width="120">
            <template #default="{ row }">{{ (row.metrics?.['write-records'] ?? 0).toLocaleString() }}</template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <!-- ── Task Managers ── -->
    <div v-show="tab === 'tm'">
      <div class="fud-panel">
        <div class="head"><span class="t">TASK MANAGERS</span><span class="spacer"></span><span class="m">/taskmanagers</span></div>
        <div class="fud-tm-grid" v-loading="loading">
          <div v-for="tm in tms" :key="tm.id" class="fud-tm" @click="openTm(tm)">
            <div class="name">tm-{{ tm.id }} <span class="mono-id">· {{ tm.path }}</span></div>
            <div class="row"><span>Slots</span><b>{{ tm.slotsNumber - tm.freeSlots }} / {{ tm.slotsNumber }}</b></div>
            <div class="row"><span>心跳间隔</span><b>{{ tm.timeSinceLastHeartbeat }} ms</b></div>
            <div class="row"><span>CPU 核</span><b>{{ tm.hardware?.physicalCpuCores ?? '—' }}</b></div>
            <div class="row"><span>空闲内存</span><b>{{ fmtBytes(tm.hardware?.freeMemory) }}</b></div>
          </div>
          <div v-if="!tms.length && !loading" class="fud-empty">无 TaskManager(作业未运行?)</div>
        </div>
      </div>
      <div class="fud-panel" v-if="selTm">
        <div class="head">
          <span class="t">tm-{{ selTm.id }} · 日志</span><span class="spacer"></span>
          <el-button size="small" text type="primary" @click="selTm = null; tmLogFiles = []">收起</el-button>
        </div>
        <div class="fud-logtypes">
          <button v-for="f in tmLogFiles" :key="f.name" class="fud-logtype" :class="{ active: curLogFile === `/taskmanagers/${selTm.id}/logs/${f.name}` }" @click="openLog(`/taskmanagers/${selTm.id}/logs/${f.name}`)">
            {{ f.name }} <span class="sz">· {{ fmtBytes(f.size) }}</span>
          </button>
          <span v-if="!tmLogFiles.length" class="fud-empty">无日志文件</span>
        </div>
        <pre v-if="logText" class="fud-log">{{ logText }}</pre>
      </div>
    </div>

    <!-- ── Job Manager ── -->
    <div v-show="tab === 'jm'">
      <div class="fud-panel">
        <div class="head"><span class="t">JOB MANAGER · 日志</span><span class="spacer"></span><span class="m">/jobmanager/logs</span></div>
        <div class="fud-logtypes">
          <button v-for="f in jmLogs" :key="f.name" class="fud-logtype" :class="{ active: curLogFile === `/jobmanager/logs/${f.name}` }" @click="openLog(`/jobmanager/logs/${f.name}`)">
            {{ f.name }} <span class="sz">· {{ fmtBytes(f.size) }}</span>
          </button>
          <span v-if="!jmLogs.length && !loading" class="fud-empty">无日志文件</span>
        </div>
        <pre v-if="logText" class="fud-log">{{ logText }}</pre>
      </div>
    </div>

    <!-- ── Configuration ── -->
    <div v-show="tab === 'config'">
      <div class="fud-panel">
        <div class="head"><span class="t">CONFIGURATION</span><span class="spacer"></span><span class="m">/config · {{ configs.length }} 项</span></div>
        <div class="fud-kv" v-loading="loading" style="max-height: 56vh; overflow: auto">
          <div v-for="c in configs" :key="c.key" class="r"><span class="k">{{ c.key }}</span><span class="v">{{ c.value }}</span></div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
.flink-ui-dialog :deep(.el-dialog__body) { padding: 8px 16px 16px; }
.fud-dlg-head {
  display: flex; align-items: center; justify-content: space-between;
  padding-right: 12px;
  .fud-dlg-title { font-size: 15px; font-weight: 700; letter-spacing: 1px; color: $text; }
  .fud-dlg-actions { display: flex; align-items: center; }
}
.fud-topbar {
  display: flex; align-items: center; gap: 12px;
  border-bottom: 1px solid var(--bd-border);
  margin-bottom: 10px;
  .spacer { flex: 1; }
}
.tabs { display: flex; gap: 2px; }
.fud-tab {
  background: transparent; border: none; cursor: pointer;
  font-family: inherit; font-size: 13px; letter-spacing: 1px;
  color: var(--bd-muted); padding: 8px 12px;
  border-bottom: 2px solid transparent;
  transition: color .15s, border-color .15s;
  &:hover:not(:disabled) { color: var(--bd-text); }
  &.active { color: var(--bd-primary); border-bottom-color: var(--bd-primary); }
  &:disabled { cursor: not-allowed; opacity: .4; }
}
.fud-ts { color: var(--bd-muted); font-size: 11px; }
.fud-err { margin-bottom: 10px; }
.fud-cards {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
  margin-bottom: 12px;
}
.fud-card {
  border: 1px solid var(--bd-border); border-radius: 8px;
  padding: 12px 14px; background: var(--bd-panel);
  .k { color: var(--bd-muted); font-size: 11px; letter-spacing: 1px; }
  .v { font-size: 24px; font-weight: 700; color: var(--c); margin-top: 4px; }
}
.fud-panel {
  border: 1px solid var(--bd-border); border-radius: 8px;
  background: var(--bd-panel); margin-bottom: 12px; overflow: hidden;
  .head {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 14px; border-bottom: 1px solid var(--bd-border);
    background: var(--bd-panel-sub);
    .t { font-size: 12px; letter-spacing: 2px; color: var(--bd-muted); }
    .m { font-size: 11px; color: var(--bd-muted); }
  }
}
.fud-badge {
  display: inline-block; padding: 2px 9px; border-radius: 10px;
  font-size: 11px; font-weight: 600;
  &.running { color: #3b82f6; background: color-mix(in srgb, #3b82f6 14%, transparent); }
  &.finished { color: #10b981; background: color-mix(in srgb, #10b981 14%, transparent); }
  &.failed { color: #ef4444; background: color-mix(in srgb, #ef4444 14%, transparent); }
  &.killed { color: #6b7280; background: color-mix(in srgb, #6b7280 14%, transparent); }
  &.scheduled { color: #f59e0b; background: color-mix(in srgb, #f59e0b 14%, transparent); }
  &.neutral { color: var(--bd-muted); background: color-mix(in srgb, var(--bd-muted) 14%, transparent); }
}
.mono-id { color: var(--bd-muted); font-size: 11px; font-family: var(--el-font-family); }
.fud-taskline { font-size: 12px; color: var(--bd-text); }
.fud-kv {
  padding: 8px 14px 4px;
  .r { display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid color-mix(in srgb, var(--bd-border) 55%, transparent); font-size: 12px; }
  .k { color: var(--bd-muted); min-width: 200px; word-break: break-all; }
  .v { color: var(--bd-text); word-break: break-all; }
}
.fud-topo { padding: 16px 18px; }
.fud-layer { display: flex; justify-content: center; align-items: center; gap: 8px; flex-wrap: wrap; }
.fud-edge-line {
  display: flex; justify-content: center; align-items: center;
  height: 24px; position: relative;
  &::before {
    content: ''; width: 2px; height: 100%;
    background: color-mix(in srgb, var(--bd-primary) 50%, transparent);
  }
  .fud-edge-arrow {
    position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
    border: 5px solid transparent; border-top-color: var(--bd-primary);
  }
}
.fud-arrow { color: var(--bd-primary); font-weight: 700; }
.fud-node {
  min-width: 180px; max-width: 280px; text-align: center;
  padding: 10px 12px; border: 1px solid var(--bd-primary); border-radius: 6px;
  background: color-mix(in srgb, var(--bd-primary) 6%, var(--bd-panel));
  .t { color: var(--bd-primary); font-size: 10px; letter-spacing: 1px; margin-bottom: 3px; }
  .n { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { color: var(--bd-muted); font-size: 10px; margin-top: 3px; }
}
.fud-tm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; padding: 12px 14px; }
.fud-tm {
  border: 1px solid var(--bd-border); border-radius: 6px; padding: 10px 12px;
  background: var(--bd-panel-sub); cursor: pointer; transition: border-color .15s;
  &:hover { border-color: var(--bd-primary); }
  .name { color: var(--bd-primary); font-size: 12px; font-weight: 600; }
  .row { display: flex; justify-content: space-between; margin-top: 5px; font-size: 11px; color: var(--bd-muted); b { color: var(--bd-text); font-weight: 600; } }
}
.fud-logtypes { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--bd-border); }
.fud-logtype {
  background: transparent; border: 1px solid var(--bd-border); color: var(--bd-text);
  padding: 4px 12px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 12px;
  &:hover { border-color: var(--bd-primary); color: var(--bd-primary); }
  &.active { background: color-mix(in srgb, var(--bd-primary) 10%, transparent); border-color: var(--bd-primary); color: var(--bd-primary); }
  .sz { color: var(--bd-muted); font-size: 11px; }
}
.fud-log {
  margin: 0; padding: 10px 14px; max-height: 42vh; overflow: auto;
  font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all;
  color: var(--bd-text); background: var(--bd-panel-sub);
}
.fud-empty { color: var(--bd-muted); font-size: 12px; padding: 14px; }
</style>
