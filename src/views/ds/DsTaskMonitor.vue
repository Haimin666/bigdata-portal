<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Document, Refresh, View } from '@element-plus/icons-vue'
import {
  listProjects,
  listProcessInstances,
  listTasksByProcess,
  listTaskInstances,
  executeProcess,
  getTaskLog,
  type DsProject,
  type DsProcessInstance,
  type DsTaskInstance
} from '@/api/ds'
import { formatTimestamp } from '@/utils/format'
import type { TableInstance } from 'element-plus'
import StateSelect, { type StateOption } from '@/components/StateSelect.vue'
import DsDepsDialog from './DsDepsDialog.vue'
import { searchWorkflows, rerunInstances } from '@/api/dsDeps'

// YARN application id 在任务日志中的正则(海豚任务日志含 application_<cluster>_<id>)
const YARN_APP_RE = /application_\d+_\d+/

defineOptions({ name: 'DsTaskMonitor' })

const router = useRouter()

const projects = ref<DsProject[]>([])
const projectName = ref('')
const loading = ref(false)
const error = ref('')

// 视图模式:process = 工作流实例(默认);task = 任务实例(填写了任务名搜索)
const viewMode = ref<'process' | 'task'>('process')

const instances = ref<DsProcessInstance[]>([])
const tasks = ref<DsTaskInstance[]>([])
const total = ref(0)
const pageNo = ref(1)
const pageSize = ref(20)

const stateType = ref('')
const searchProcess = ref('')
const searchTask = ref('')
const rangeKey = ref('1d')

// YARN RM 地址(从 /api/config 获取,用于 application id 跳转)
const rmHost = ref('')

// 状态选项:集中定义,供筛选下拉与展示标签共用(StateSelect + dsStateLabel)
const stateOptions: StateOption[] = [
  // 注意:本版本海豚运行中状态枚举为 RUNNING_EXEUTION(少一个 C),
  // 展示与筛选参数均为该拼写(实测确认,传标准 RUNNING_EXECUTION 会 10113 报错)
  { label: '运行中', value: 'RUNNING_EXEUTION', type: 'primary', running: true },
  { label: '成功', value: 'SUCCESS', type: 'success' },
  { label: '失败', value: 'FAILURE', type: 'danger' },
  { label: '暂停', value: 'PAUSE', type: 'warning' },
  { label: '停止', value: 'STOP', type: 'info' },
  { label: '已提交', value: 'SUBMITTED_SUCCESS', type: 'info', running: true },
  { label: '已终止', value: 'KILL', type: 'info' }
]

/** 额外状态映射(不在筛选选项中但可能出现在数据的展示状态) */
const extraStateLabels: Record<string, string> = {
  RUNNING_EXECUTION: '运行中',
  READY_PAUSE: '待暂停',
  READY_STOP: '待停止',
  DELAY_EXECUTION: '延迟执行',
  SERIAL_WAIT: '串行等待',
  NEED_FAULT_TOLERANCE: '需容错',
  TIMEOUT: '超时',
  WAITING_DEPEND: '等待依赖',
  WAITING_THREAD: '等待线程',
  WAIT_TO_RUN: '等待运行',
  WAIT_TO_THREAD: '等待线程池',
  FORCED_SUCCESS: '强制成功'
}

function dsStateLabel(state: string): string {
  return stateOptions.find((o) => o.value === state)?.label || extraStateLabels[state] || state
}

function stateTagType(state: string): StateOption['type'] {
  return stateOptions.find((o) => o.value === state)?.type || 'info'
}

function isRunning(state: string): boolean {
  return stateOptions.some((o) => o.value === state && o.running) || ['DELAY_EXECUTION', 'SERIAL_WAIT'].includes(state)
}

/** 时间范围 → [startDate, endDate],海豚 API 格式 yyyy-MM-dd HH:mm:ss */
function rangeDates(): { start?: string; end?: string } {
  const now = new Date()
  const fmt = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  const hours: Record<string, number> = { '1d': 24, '3d': 24 * 3, '7d': 24 * 7 }
  const h = hours[rangeKey.value]
  if (!h) return {}
  const start = new Date(now.getTime() - h * 3600 * 1000)
  return { start: fmt(start), end: fmt(now) }
}

// 请求序号:防止快速切换筛选/项目/分页时旧响应覆盖新结果
let loadSeq = 0

async function load() {
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    // 全部项目模式下必须有搜索词(避免并发请求全部项目,打垮海豚/卡顿)
    if (!projectName.value) {
      const kw = (viewMode.value === 'task' ? searchTask.value : searchProcess.value)?.trim()
      if (!kw) {
        instances.value = []
        tasks.value = []
        total.value = 0
        if (seq === loadSeq) loading.value = false
        return
      }
    }
    const { start, end } = rangeDates()
    // 填写任务名 → 任务实例视图;否则工作流实例视图
    if (viewMode.value === 'task') {
      const data = await loadAllOrOne<DsTaskInstance>('task', { start, end })
      if (seq !== loadSeq) return
      tasks.value = data.totalList || []
      total.value = data.total || 0
    } else {
      const data = await loadAllOrOne<DsProcessInstance>('process', { start, end })
      if (seq !== loadSeq) return
      instances.value = data.totalList || []
      total.value = data.total || 0
    }
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e instanceof Error ? e.message : String(e)
    instances.value = []
    tasks.value = []
    total.value = 0
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

/** 查询工作流/任务实例:单个项目直查;全部项目(空 projectName)跨项目合并 */
async function loadAllOrOne<T>(
  mode: 'task' | 'process',
  { start, end }: { start?: string; end?: string }
): Promise<{ totalList: T[]; total: number }> {
  const common = { pageNo: 1, pageSize: pageSize.value, stateType: stateType.value || undefined, startDate: start, endDate: end }
  // 单个项目
  if (projectName.value) {
    if (mode === 'task') {
      return listTaskInstances(projectName.value, { ...common, taskName: searchTask.value || undefined }) as unknown as { totalList: T[]; total: number }
    }
    return listProcessInstances(projectName.value, { ...common, searchVal: searchProcess.value || undefined }) as unknown as { totalList: T[]; total: number }
  }
  // 全部项目
  const kw = (mode === 'task' ? searchTask.value : searchProcess.value)?.trim()
  const targets: { projectName: string; processName?: string; processId?: number }[] = []
  if (!kw) {
    // 全部项目必须有搜索词才跨项目查(避免并发请求全部项目,打垮海豚/页面卡顿)
    return { totalList: [], total: 0 }
  }
  // 有搜索词:用依赖缓存定位(快,不发海豚搜索请求)
  const hits = await searchWorkflows(kw)
  const byProject = new Map<string, { projectName: string }>()
  for (const h of hits) {
    if (h.matchedTask || h.processName.toLowerCase().includes(kw.toLowerCase())) {
      targets.push({ projectName: h.projectName, processName: h.processName, processId: h.processId })
    } else {
      byProject.set(h.projectName, { projectName: h.projectName })
    }
  }
  for (const p of byProject.values()) targets.push(p)
  if (!targets.length) return { totalList: [], total: 0 }
  // 并发查询(限 3)
  const results: T[] = []
  let cursor = 0
  const worker = async () => {
    while (cursor < targets.length) {
      const t = targets[cursor++]
      try {
        const tag = (list: unknown[]) =>
          (list as Array<Record<string, unknown>>).map((x) => ({ ...x, _projectName: t.projectName }))
        if (t.processId) {
          // 精确工作流:按工作流名搜索实例
          const d =
            mode === 'task'
              ? await listTaskInstances(t.projectName, { ...common, taskName: t.processName })
              : await listProcessInstances(t.projectName, { ...common, searchVal: t.processName })
          results.push(...(tag(d.totalList || []) as T[]))
        } else {
          const d =
            mode === 'task'
              ? await listTaskInstances(t.projectName, { ...common, taskName: kw || undefined })
              : await listProcessInstances(t.projectName, { ...common, searchVal: kw || undefined })
          results.push(...(tag(d.totalList || []) as T[]))
        }
      } catch {
        /* 单个项目失败跳过 */
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  return { totalList: results, total: results.length }
}

function onProjectChange() {
  pageNo.value = 1
  load()
}

function onFilterChange() {
  pageNo.value = 1
  load()
}

/** 任务名搜索框变化:切换视图模式 */
function onTaskSearchChange() {
  viewMode.value = searchTask.value.trim() ? 'task' : 'process'
  pageNo.value = 1
  load()
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '—'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${h}h ${m}m`
}

/** 从任务日志解析 YARN application id(取日志前 300 行) */
async function resolveYarnAppId(taskId: number): Promise<string | null> {
  try {
    const log = await getTaskLog(taskId, 0, 300)
    const m = log.match(YARN_APP_RE)
    return m ? m[0] : null
  } catch {
    return null
  }
}

// 工作流实例表格实例(整行点击展开用)
const tableRef = ref<TableInstance>()

/** 展开工作流实例行:加载任务列表 + 并发解析 YARN appId(限 4 路,避免日志接口并发过高卡顿) */
async function onExpandChange(row: DsProcessInstance, expanded: boolean) {
  const r = row as unknown as { _tasks?: DsTaskInstance[]; _tasksLoading?: boolean }
  if (!expanded || r._tasks) return
  r._tasksLoading = true
  try {
    r._tasks = await listTasksByProcess(projectName.value, row.id)
  } catch (e) {
    ElMessage.error(`加载任务失败:${e instanceof Error ? e.message : e}`)
    r._tasksLoading = false
    return
  }
  r._tasksLoading = false
  // 并发解析 YARN application id
  const tasks = r._tasks
  let cursor = 0
  const worker = async () => {
    while (cursor < tasks.length) {
      const t = tasks[cursor++] as DsTaskInstance & { _yarnAppId?: string }
      t._yarnAppId = (await resolveYarnAppId(t.id)) ?? undefined
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
}

/** 点击行任意位置展开/收起。展开箭头列点击时 el-table 同时触发 row-click,跳过避免双重切换 */
function onRowClick(row: DsProcessInstance, column: { type?: string }) {
  if (column.type === 'expand') return
  tableRef.value?.toggleRowExpansion(row)
}

/** 跳转 YARN RM 的 application 详情页 */
function openYarnApp(appId: string) {
  if (!rmHost.value) {
    ElMessage.warning('未获取到 ResourceManager 地址')
    return
  }
  window.open(`${rmHost.value}/cluster/app/${appId}`, '_blank')
}

/** 跳转海豚调度 iframe 的实例详情页(/ds 菜单,SubAppView 消费 dsTarget query) */
function goDsInstance(processInstanceId: number) {
  router.push({ path: '/ds', query: { dsTarget: String(processInstanceId) } })
}

// ── 日志 ──────────────────────────────────────────────────────
const logVisible = ref(false)
const logLoading = ref(false)
const logContent = ref('')
const logSkip = ref(0)
const logTaskId = ref(0)
const LOG_LIMIT = 500

async function openLog(task: DsTaskInstance) {
  logTaskId.value = task.id
  logSkip.value = 0
  logContent.value = ''
  logVisible.value = true
  await loadLog()
}

async function loadLog(append = false) {
  logLoading.value = true
  try {
    const text = await getTaskLog(logTaskId.value, logSkip.value, LOG_LIMIT)
    logContent.value = append ? logContent.value + text : text
    if (text) logSkip.value += LOG_LIMIT
  } catch (e) {
    ElMessage.error(`日志加载失败:${e instanceof Error ? e.message : e}`)
  } finally {
    logLoading.value = false
  }
}

// ── 工作流实例操作 ───────────────────────────────────────────
async function onExecute(inst: DsProcessInstance, executeType: string) {
  const label = executeType === 'REPEAT_RUNNING' ? '重跑' : executeType === 'STOP' ? '停止' : executeType
  try {
    await ElMessageBox.confirm(
      `确定要${label}工作流实例「${inst.name}」吗?`,
      label,
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await executeProcess(projectName.value, inst.id, executeType)
    ElMessage.success(`${label}成功`)
    load()
  } catch (e) {
    ElMessage.error(`${label}失败:${e instanceof Error ? e.message : e}`)
  }
}

// ── 工作流依赖查看 / 级联重跑 ───────────────────────────────
const depsDialogVisible = ref(false)
const depsTarget = ref<{ processId: number; processName: string; projectName: string; instanceId?: number; instanceName?: string } | null>(null)

/** 打开依赖弹窗(级联重跑/查看) */
function openDeps(inst: DsProcessInstance) {
  if (!inst.processDefinitionId) {
    ElMessage.warning('该实例缺少工作流定义 ID,无法查看依赖')
    return
  }
  depsTarget.value = {
    processId: inst.processDefinitionId,
    processName: inst.name,
    projectName: projectName.value,
    instanceId: inst.id,
    instanceName: inst.name
  }
  depsDialogVisible.value = true
}

/** 依赖树节点点击 → 跳到对应工作流实例(切项目+搜索工作流名) */
function onDepsJump(node: { projectName: string; processName: string }) {
  projectName.value = node.projectName
  searchProcess.value = node.processName
  searchTask.value = ''
  viewMode.value = 'process'
  pageNo.value = 1
  load()
}

/** 一键拉起失败:批量重跑当前列表中的失败实例(二次确认) */
async function rerunAllFailed() {
  const failed = instances.value.filter((i) => i.state === 'FAILURE')
  if (!failed.length) {
    ElMessage.info('当前列表没有失败实例')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定要重跑当前列表中的 ${failed.length} 个失败工作流实例吗?\n(项目: ${projectName.value || '全部'},将逐个重跑)`,
      '一键拉起失败',
      { confirmButtonText: '确认重跑', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    const targets = failed.map((i) => ({
      projectName: i._projectName || projectName.value,
      instanceId: i.id,
      name: i.name
    }))
    const results = await rerunInstances(targets)
    const ok = results.filter((r) => r.ok).length
    const fail = results.filter((r) => !r.ok)
    ElMessage.success(`拉起完成:成功 ${ok},失败 ${fail.length}`)
    if (fail.length) ElMessage.warning(fail.map((f) => `${f.name}:${f.msg}`).join(';'))
    load()
  } catch (e) {
    ElMessage.error(`拉起失败:${e instanceof Error ? e.message : e}`)
  }
}

// ── 任务节点级操作(单任务重跑 / 从节点级联)─────────────────
/** 从任务实例提取节点定义 id(taskJson.id,如 tasks-41739) */
function taskNodeId(t: DsTaskInstance): string | null {
  const tj = t.taskJson
  if (!tj) return null
  const id = typeof tj === 'string' ? (JSON.parse(tj)?.id ?? null) : (tj.id ?? null)
  return id ? String(id) : null
}

/** 单任务重跑 / 从节点级联:start-process-instance + startNodeList=该节点 */
async function onRerunFromTask(t: DsTaskInstance, cascade: boolean) {
  const nodeId = taskNodeId(t)
  if (!nodeId) {
    ElMessage.warning('该任务缺少节点定义 ID,无法从节点重跑')
    return
  }
  const label = cascade ? '从该节点级联重跑' : '单任务重跑'
  try {
    await ElMessageBox.confirm(
      `确定要${label}「${t.name}」吗?(将从该节点开始执行${cascade ? '及其后续节点' : ''})`,
      label,
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    const res = await fetch('/api/ds-deps/rerun-from-node', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectName: projectName.value,
        processInstanceId: t.processInstanceId,
        startNodeId: nodeId
      })
    })
    const body = (await res.json()) as { code?: number; msg?: string }
    if (body.code !== 0) throw new Error(body.msg || '重跑失败')
    ElMessage.success(`${label}成功`)
    load()
  } catch (e) {
    ElMessage.error(`${label}失败:${e instanceof Error ? e.message : e}`)
  }
}

onMounted(async () => {
  try {
    const res = await fetch('/api/config')
    const cfg = (await res.json()) as { resourceManagers?: string[] }
    rmHost.value = cfg.resourceManagers?.[0] || ''
  } catch {
    // 忽略:跳转 YARN 时提示
  }
  try {
    projects.value = await listProjects()
    // 默认"全部项目"(空 projectName),跨项目检索
    projectName.value = ''
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    if (!projects.value.length) error.value += '(海豚 token 由网关 DS_TOKEN 配置注入,项目列表即该用户可见项目)'
  }
})
</script>

<template>
  <div class="ds-monitor">
    <div class="toolbar">
      <el-select
        v-model="projectName"
        class="project-select"
        placeholder="选择项目(可输入搜索)"
        filterable
        @change="onProjectChange"
      >
        <el-option label="全部项目(跨项目检索)" value="" />
        <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.name" />
      </el-select>

      <StateSelect v-model="stateType" :options="stateOptions" @change="onFilterChange" />

      <el-select v-model="rangeKey" class="range-select" @change="onFilterChange">
        <el-option label="近 1 天" value="1d" />
        <el-option label="近 3 天" value="3d" />
        <el-option label="近 7 天" value="7d" />
        <el-option label="全部" value="all" />
      </el-select>

      <el-input
        v-model="searchProcess"
        class="search-input"
        placeholder="搜索工作流名称"
        clearable
        @keyup.enter="onFilterChange"
        @clear="onFilterChange"
      />
      <el-input
        v-model="searchTask"
        class="search-input"
        placeholder="搜索任务名"
        clearable
        @keyup.enter="onTaskSearchChange"
        @clear="onTaskSearchChange"
      />

      <div class="toolbar-spacer" />
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      <el-button type="danger" plain :loading="loading" @click="rerunAllFailed">一键拉起失败</el-button>
    </div>

    <el-result v-if="error && !loading" icon="error" title="加载失败" :sub-title="error">
      <template #extra>
        <el-button type="primary" @click="load">重试</el-button>
      </template>
    </el-result>

    <!-- 工作流实例视图(默认,支持展开任务) -->
    <el-table
      ref="tableRef"
      v-else-if="viewMode === 'process'"
      v-loading="loading"
      row-key="id"
      :data="instances"
      border class="task-table"
      @expand-change="onExpandChange"
      @row-click="onRowClick"
    >
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="sub-wrap">
            <el-table v-loading="(row as any)._tasksLoading" :data="(row as any)._tasks || []" size="small" border class="sub-table">
              <el-table-column label="任务名" min-width="200" show-overflow-tooltip sortable>
                <template #default="{ row: t }">{{ t.name }}</template>
              </el-table-column>
              <el-table-column prop="taskType" label="类型" width="90" sortable />
              <el-table-column label="状态" width="100" sortable>
                <template #default="{ row: t }">
                  <el-tag :type="stateTagType(t.state)" size="small">{{ dsStateLabel(t.state) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="开始时间" width="155" sortable>
                <template #default="{ row: t }">{{ t.startTime ? formatTimestamp(Date.parse(t.startTime), true) : '—' }}</template>
              </el-table-column>
              <el-table-column label="结束时间" width="155" sortable>
                <template #default="{ row: t }">{{ t.endTime ? formatTimestamp(Date.parse(t.endTime), true) : '—' }}</template>
              </el-table-column>
              <el-table-column label="耗时" width="80" align="right" sortable>
                <template #default="{ row: t }">{{ formatDuration(t.duration) }}</template>
              </el-table-column>
              <el-table-column label="重试" width="70" align="right" sortable>
                <template #default="{ row: t }">{{ t.retryTimes != null ? `${t.retryTimes}/${t.maxRetryTimes ?? '-'}` : '—' }}</template>
              </el-table-column>
              <el-table-column prop="host" label="主机" width="130" show-overflow-tooltip sortable />
              <el-table-column label="YARN 应用" width="170">
                <template #default="{ row: t }">
                  <el-link
                    v-if="(t as any)._yarnAppId"
                    type="primary"
                    class="yarn-link"
                    @click="openYarnApp((t as any)._yarnAppId)"
                  >{{ (t as any)._yarnAppId }}</el-link>
                  <span v-else class="muted">—</span>
                </template>
              </el-table-column>
              <el-table-column label="日志" width="80" fixed="right">
                <template #default="{ row: t }">
                  <el-button link type="primary" size="small" @click="openLog(t)">查看</el-button>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="150" fixed="right">
                <template #default="{ row: t }">
                  <el-button link size="small" @click="onRerunFromTask(t, false)">单任务重跑</el-button>
                  <el-button link type="success" size="small" @click="onRerunFromTask(t, true)">节点级联</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="工作流实例名称" min-width="280" show-overflow-tooltip sortable>
        <template #default="{ row }">
          <el-link
            type="primary"
            class="instance-name"
            :title="`打开海豚调度查看实例 ${row.name}`"
            @click="goDsInstance(row.id)"
          >{{ row.name }}</el-link>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="130" sortable>
        <template #default="{ row }">
          <el-tag :type="stateTagType(row.state)" size="small">{{ dsStateLabel(row.state) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="工作流" min-width="160" show-overflow-tooltip sortable>
        <template #default="{ row }">{{ row.processDefinition?.name || '—' }}</template>
      </el-table-column>
      <el-table-column label="开始时间" width="170" sortable>
        <template #default="{ row }">
          {{ row.startTime ? formatTimestamp(Date.parse(row.startTime), true) : '—' }}
        </template>
      </el-table-column>
      <el-table-column label="结束时间" width="170" sortable>
        <template #default="{ row }">
          {{ row.endTime ? formatTimestamp(Date.parse(row.endTime), true) : '—' }}
        </template>
      </el-table-column>
      <el-table-column label="耗时" width="100" align="right" sortable>
        <template #default="{ row }">{{ formatDuration(row.duration) }}</template>
      </el-table-column>
      <el-table-column prop="executorName" label="执行人" width="100" sortable />
      <el-table-column prop="host" label="主机" min-width="130" show-overflow-tooltip sortable />
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }">
          <template v-if="isRunning(row.state)">
            <el-button link type="warning" size="small" @click="onExecute(row, 'PAUSE')">暂停</el-button>
            <el-button link type="danger" size="small" @click="onExecute(row, 'STOP')">停止</el-button>
          </template>
          <el-button v-else link type="primary" size="small" @click="onExecute(row, 'REPEAT_RUNNING')">重跑</el-button>
          <el-button link type="success" size="small" @click="openDeps(row)">级联重跑</el-button>
          <el-button link size="small" @click="openDeps(row)">依赖</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :description="!projectName && !searchProcess.trim() ? '全部项目下请输入工作流名称搜索' : '暂无工作流实例'" />
      </template>
    </el-table>

    <!-- 任务实例视图(填写了任务名搜索) -->
    <el-table v-else v-loading="loading" :data="tasks" border class="task-table">
      <el-table-column label="任务名" min-width="260" show-overflow-tooltip sortable>
        <template #default="{ row }">
          <span class="task-name">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="taskType" label="类型" width="100" sortable />
      <el-table-column label="状态" width="110" sortable>
        <template #default="{ row }">
          <el-tag :type="stateTagType(row.state)" size="small">{{ dsStateLabel(row.state) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="workerGroup" label="Worker" width="110" show-overflow-tooltip sortable />
      <el-table-column prop="host" label="主机" width="150" show-overflow-tooltip sortable />
      <el-table-column prop="executorName" label="执行人" width="100" sortable />
      <el-table-column label="开始时间" width="165" sortable>
        <template #default="{ row }">
          {{ row.startTime ? formatTimestamp(Date.parse(row.startTime), true) : '—' }}
        </template>
      </el-table-column>
      <el-table-column label="结束时间" width="165" sortable>
        <template #default="{ row }">
          {{ row.endTime ? formatTimestamp(Date.parse(row.endTime), true) : '—' }}
        </template>
      </el-table-column>
      <el-table-column label="耗时" width="100" align="right" sortable>
        <template #default="{ row }">{{ formatDuration(row.duration) }}</template>
      </el-table-column>
      <el-table-column label="重试" width="80" align="right" sortable>
        <template #default="{ row }">{{ row.retryTimes != null ? `${row.retryTimes}/${row.maxRetryTimes ?? '-'}` : '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openLog(row)">
            <el-icon><Document /></el-icon>&nbsp;日志
          </el-button>
          <el-link
            v-if="row.appLink && row.appLink !== 'null'"
            type="primary"
            :href="row.appLink"
            target="_blank"
            class="app-link"
          >
            <el-icon><View /></el-icon>&nbsp;YARN
          </el-link>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :description="!projectName && !searchTask.trim() ? '全部项目下请输入任务名称搜索' : '暂无任务实例'" />
      </template>
    </el-table>

    <!-- 工作流依赖 / 级联重跑弹窗 -->
    <DsDepsDialog
      v-model="depsDialogVisible"
      v-if="depsTarget"
      :process-id="depsTarget.processId"
      :process-name="depsTarget.processName"
      :project-name="depsTarget.projectName"
      :instance-id="depsTarget.instanceId"
      :instance-name="depsTarget.instanceName"
      @jump="onDepsJump"
    />

    <div class="pagination-bar">
      <el-pagination
        v-model:current-page="pageNo"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next, jumper"
        @current-change="load"
        @size-change="onFilterChange"
      />
    </div>

    <!-- 日志弹窗 -->
    <el-dialog v-model="logVisible" title="任务日志" width="70%" top="4vh">
      <div v-loading="logLoading" class="log-box">
        <pre>{{ logContent || '暂无日志' }}</pre>
      </div>
      <template #footer>
        <el-button :loading="logLoading" @click="loadLog(true)">加载更多</el-button>
        <el-button type="primary" @click="logVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.ds-monitor {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 10px 12px;
  flex-wrap: wrap;
}

.project-select {
  width: 240px;
}

.range-select {
  width: 130px;
}

.search-input {
  width: 180px;
}

.toolbar-spacer {
  flex: 1;
}

.task-table {
  flex-shrink: 0;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  overflow: hidden;
}

.sub-wrap {
  // 缩进:任务实例从属于上级工作流,不与上级列头对齐
  padding: 8px 8px 8px 48px;
  background: rgba(94, 106, 210, 0.03);
}

.sub-table {
  background: transparent;
  border: 0;
  font-size: 12px;

  :deep(.el-table__header th) {
    font-size: 12px;
    font-weight: 600;
    color: $muted;
    background: transparent;
    padding: 6px 0;
  }

  :deep(.el-table__cell) {
    padding: 4px 0;
    color: $text;
  }
}

.yarn-link {
  font-weight: 600;
  color: $primary;

  &:hover {
    text-decoration: underline;
  }
}

.task-name {
  font-weight: 500;
  color: $text;
}

.app-link {
  margin-left: 10px;
  font-size: 12px;
}

.muted {
  color: $muted;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 8px 12px;
}

.log-box {
  max-height: 60vh;
  overflow: auto;
  background: #1e1e1e;
  border-radius: 4px;
  padding: 10px;
}

.log-box pre {
  margin: 0;
  color: #d4d4d4;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
