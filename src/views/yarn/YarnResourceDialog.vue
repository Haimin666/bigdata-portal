<script setup lang="ts">
/**
 * YARN 资源管理弹窗:重建 RM 应用详情页 UI(非 iframe 原生页)。
 * 数据经门户代理拉取(/api/yarn-resource/proxy REST 转发 + /api/yarn-resource/logs 解析日志类型):
 *   app 详情   GET /api/yarn-resource/proxy?url=<RM>/ws/v1/cluster/apps/{appId}
 *   attempts   GET /api/yarn-resource/proxy?url=<RM>/ws/v1/cluster/apps/{appId}/appattempts
 *   日志类型   GET /api/yarn-resource/logs?node=&container=&user=
 *   日志内容   GET /api/yarn-resource/proxy?url=<NM>/node/containerlogs/{container}/{user}/{file}[?start=-4096]
 */
import { computed, onMounted, ref, watch } from 'vue'
import DialogMaxBtn from '@/components/DialogMaxBtn.vue'
import type { StatusColor } from '@/types/yarn'

defineOptions({ name: 'YarnResourceDialog' })

const props = defineProps<{
  modelValue: boolean
  appId: string
  appName?: string
  /** RM 完整地址,如 http://hadoop-nn-1.bigdata.shiqiao.com:8088 */
  rmHost: string
  /** 应用属主(containerlogs URL 需要),默认 root */
  user?: string
}>()

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

/* ── 数据 ── */
const app = ref<any>(null)
const attempts = ref<any[]>([])
const loading = ref(false)
const error = ref('')

interface LogFile { name: string }
const logFiles = ref<LogFile[]>([])
const logLoading = ref(false)
const curLogFile = ref('')
const logText = ref('')
const logFull = ref(false)

/* ── 视图状态:app(资源页) / logs(日志) ── */
const view = ref<'app' | 'logs'>('app')
const fs = ref(false)
const curContainer = ref('')
const curNode = ref('')

const proxy = (url: string) => `/api/yarn-resource/proxy?url=${encodeURIComponent(url)}`

async function loadApp() {
  loading.value = true
  error.value = ''
  try {
    const r = await fetch(proxy(`${props.rmHost}/ws/v1/cluster/apps/${props.appId}`), { signal: AbortSignal.timeout(15000) })
    const j = await r.json()
    if (!r.ok) throw new Error(j.msg || `HTTP ${r.status}`)
    app.value = j.app
    const ar = await fetch(proxy(`${props.rmHost}/ws/v1/cluster/apps/${props.appId}/appattempts`), { signal: AbortSignal.timeout(15000) })
    const aj = await ar.json()
    if (!ar.ok) throw new Error(aj.msg || `HTTP ${ar.status}`)
    attempts.value = aj.appAttempts?.appAttempt ?? []
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

/* ── 日志 ── */
async function openLogs(containerId: string, nodeHttp: string) {
  view.value = 'logs'
  curContainer.value = containerId
  curNode.value = nodeHttp
  curLogFile.value = ''
  logText.value = ''
  logFull.value = false
  logLoading.value = true
  try {
    const url = `/api/yarn-resource/logs?node=${encodeURIComponent(nodeHttp)}&container=${encodeURIComponent(containerId)}&user=${encodeURIComponent(props.user || 'root')}`
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
    const j = await r.json()
    if (!r.ok || !j.ok) throw new Error(j.msg || `HTTP ${r.status}`)
    logFiles.value = (j.files as string[]).map((name) => ({ name }))
    if (logFiles.value.length) {
      curLogFile.value = logFiles.value[0].name
      await loadLogContent()
    }
  } catch (e) {
    logText.value = `获取日志列表失败: ${e}`
  } finally {
    logLoading.value = false
  }
}

async function loadLogContent() {
  if (!curLogFile.value || !curContainer.value || !curNode.value) return
  logText.value = ''
  logLoading.value = true
  try {
    const q = new URLSearchParams({
      node: curNode.value,
      container: curContainer.value,
      user: props.user || 'root',
      file: curLogFile.value,
      full: logFull.value ? '1' : ''
    })
    const r = await fetch(`/api/yarn-resource/log-content?${q}`, { signal: AbortSignal.timeout(20000) })
    const j = await r.json()
    if (!r.ok || !j.ok) throw new Error(j.msg || `HTTP ${r.status}`)
    logText.value = j.text || '(空日志)'
  } catch (e) {
    logText.value = `加载日志失败: ${e}`
  } finally {
    logLoading.value = false
  }
}

function selectLogFile(name: string) {
  curLogFile.value = name
  logFull.value = false
  loadLogContent()
}

function toggleFull() {
  logFull.value = !logFull.value
  loadLogContent()
}

function backToApp() {
  view.value = 'app'
}

watch(
  () => props.modelValue,
  (v) => {
    if (v && !app.value) loadApp()
  }
)
onMounted(() => {
  if (props.modelValue) loadApp()
})

/* ── 展示格式化 ── */
const stateBadge = computed(() => {
  const s = app.value?.state
  const cls: Record<string, { text: string; color: string }> = {
    RUNNING: { text: '#3b82f6', color: 'running' },
    FINISHED: { text: '#10b981', color: 'finished' },
    FAILED: { text: '#ef4444', color: 'failed' },
    KILLED: { text: '#6b7280', color: 'killed' }
  }
  const m = cls[s] || { text: 'var(--bd-muted)', color: 'neutral' }
  return { label: s, text: m.text, color: m.color }
})

function fmt(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function fmtDur(ms: number): string {
  if (!ms) return '—'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`
}

const infoItems = computed(() => {
  const a = app.value
  if (!a) return []
  return [
    ['应用 ID', a.id],
    ['应用名称', a.name],
    ['用户', a.user],
    ['队列', a.queue],
    ['状态', `${stateBadge.value.label} (final: ${a.finalStatus})`],
    ['类型', a.applicationType],
    ['开始时间', fmt(a.startedTime)],
    ['运行时长', fmtDur(a.elapsedTime)],
    ['分配内存', `${a.allocatedMB} MB`],
    ['分配 vCores', String(a.allocatedVCores)],
    ['运行容器', String(a.runningContainers)],
    ['集群使用率', `${((a.clusterUsagePercentage || 0) * 100).toFixed(1)}%`],
    ['AM 节点', a.amHostHttpAddress || '—'],
    ['诊断', a.diagnostics || '—']
  ] as [string, string][]
})

const statusColor = (c: string): StatusColor =>
  c === 'running' ? 'running' : c === 'finished' ? 'success' : c === 'failed' ? 'failure' : c === 'killed' ? 'stopped' : 'neutral'
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    width="88%"
    top="3vh"
    destroy-on-close
    class="yarn-res-dialog"
    :fullscreen="fs"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <template #header>
      <div class="yrd-dlg-head">
        <span class="yrd-dlg-title">资源管理 {{ appName || appId }}</span>
        <div class="yrd-dlg-actions">
          <DialogMaxBtn :fs="fs" @toggle="fs = !fs" />
        </div>
      </div>
    </template>
    <!-- 顶栏:面包屑 + 回到资源页 -->
    <div class="yrd-topbar">
      <span class="yrd-crumb">
        {{ view === 'app' ? '应用详情 ▸ ' + appId : `容器日志 ▸ ${curContainer} ▸ ${curLogFile}` }}
      </span>
      <button v-if="view === 'logs'" class="yrd-back" @click="backToApp">← 回到资源页</button>
      <button v-else class="yrd-back yrd-back-disabled" disabled>← 回到资源页</button>
    </div>

    <div v-loading="loading" class="yrd-body">
      <!-- ══ 应用详情视图 ══ -->
      <div v-if="view === 'app'">
        <el-alert v-if="error" :title="error" type="error" :closable="false" class="yrd-err" />
        <template v-if="app">
          <div class="yrd-panel">
            <div class="yrd-panel-title"><span class="dot" />应用信息</div>
            <div class="yrd-info-grid">
              <div v-for="[k, v] in infoItems" :key="k" class="yrd-info-item">
                <div class="k">{{ k }}</div>
                <div class="v">
                  <el-tag v-if="k === '状态'" size="small" :type="statusColor(stateBadge.color)" effect="light">{{ v }}</el-tag>
                  <span v-else>{{ v }}</span>
                </div>
              </div>
              <div class="yrd-info-item">
                <div class="k">进度</div>
                <div class="v">
                  <div class="yrd-progress"><div class="fill" :style="{ width: (app.progress || 0) + '%' }" /></div>
                </div>
              </div>
            </div>
          </div>
          <div class="yrd-panel">
            <div class="yrd-panel-title"><span class="dot" />应用尝试 (Attempts)</div>
            <el-table :data="attempts" size="small" class="yrd-table">
              <el-table-column prop="appAttemptId" label="Attempt ID" min-width="220" />
              <el-table-column prop="containerId" label="Container ID" min-width="260" show-overflow-tooltip />
              <el-table-column prop="nodeHttpAddress" label="节点" min-width="180" />
              <el-table-column label="开始时间" width="170">
                <template #default="{ row }">{{ fmt(row.startTime) }}</template>
              </el-table-column>
              <el-table-column label="日志" width="80">
                <template #default="{ row }">
                  <button class="yrd-link" @click="openLogs(row.containerId, row.nodeHttpAddress)">logs</button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </template>
      </div>

      <!-- ══ 日志视图 ══ -->
      <div v-else>
        <div class="yrd-panel">
          <div class="yrd-panel-title"><span class="dot" />容器日志</div>
          <div v-loading="logLoading" class="yrd-log-area">
            <div class="yrd-log-types">
              <button
                v-for="f in logFiles"
                :key="f.name"
                class="yrd-log-type"
                :class="{ active: f.name === curLogFile }"
                @click="selectLogFile(f.name)"
              >{{ f.name }}</button>
              <span v-if="!logFiles.length && !logLoading" class="yrd-log-empty">未发现日志文件</span>
            </div>
            <div class="yrd-log-toolbar">
              <button class="yrd-link" @click="toggleFull">{{ logFull ? '收起' : '展开全部' }}</button>
              <span class="yrd-log-meta">{{ curLogFile }} · {{ logFull ? '完整日志' : '尾部 4KB' }}</span>
              <span class="spacer" />
              <button class="yrd-link" @click="loadLogContent">刷新</button>
            </div>
            <pre class="yrd-log-content">{{ logText || (logLoading ? '加载中…' : '') }}</pre>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
.yrd-dlg-head {
  display: flex; align-items: center; justify-content: space-between;
  padding-right: 12px;
  .yrd-dlg-title { font-size: 15px; font-weight: 700; letter-spacing: 1px; color: $text; }
  .yrd-dlg-actions { display: flex; align-items: center; }
}
.yrd-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 2px 10px;
  border-bottom: 1px solid $border;
  margin-bottom: 12px;
}
.yrd-crumb {
  flex: 1;
  color: $muted;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.yrd-back {
  background: transparent;
  border: 1px solid $primary;
  color: $primary;
  padding: 4px 14px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  &:hover { background: $primary; color: $bg; }
  &-disabled { opacity: 0.35; cursor: not-allowed; }
}
.yrd-body { min-height: 40vh; max-height: 74vh; overflow: auto; }
.yarn-res-dialog.is-fullscreen .yrd-body { max-height: calc(100vh - 180px); }
.yrd-err { margin-bottom: 12px; }
.yrd-panel {
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  margin-bottom: 12px;
  overflow: hidden;
}
.yrd-panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid $border;
  font-weight: 600;
  color: $primary;
  .dot { width: 6px; height: 6px; background: $primary; border-radius: 2px; }
}
.yrd-info-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  .yrd-info-item {
    padding: 10px 14px;
    border-right: 1px solid $border;
    border-bottom: 1px solid $border;
    &:nth-child(4n) { border-right: none; }
    &:nth-last-child(-n + 4) { border-bottom: none; }
    .k { color: $muted; font-size: 11px; margin-bottom: 4px; }
    .v { font-size: 13px; word-break: break-all; }
  }
}
.yrd-progress {
  height: 6px;
  background: #16202e;
  border-radius: 3px;
  overflow: hidden;
  .fill { height: 100%; background: $primary; border-radius: 3px; }
}
.yrd-table { :deep(th.el-table__cell) { padding: 8px 0; } }
.yrd-link {
  background: transparent;
  border: 1px solid $primary;
  color: $primary;
  padding: 2px 10px;
  border-radius: 3px;
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  &:hover { background: $primary; color: $bg; }
}
.yrd-log-area { min-height: 30vh; }
.yrd-log-types {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid $border;
}
.yrd-log-type {
  background: transparent;
  border: 1px solid $border;
  color: $text;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  &:hover { border-color: $primary; color: $primary; }
  &.active { background: rgba(0, 229, 255, 0.1); border-color: $primary; color: $primary; }
}
.yrd-log-empty { color: $muted; font-size: 12px; }
.yrd-log-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid $border;
  background: var(--bd-panel-sub);
  .spacer { flex: 1; }
}
.yrd-log-meta { color: $muted; font-size: 11px; }
.yrd-log-content {
  margin: 0;
  padding: 10px 14px;
  max-height: 46vh;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: $text;
  background: var(--bd-panel-sub);
}
</style>
