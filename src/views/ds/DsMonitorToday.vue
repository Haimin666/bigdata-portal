<template>
  <div class="mt">
    <header class="mt__head">
      <div class="mt__title">
        <span class="mt__logo">◈</span>
        <h1>任务监控 · 当日</h1>
        <span class="mt__sub">当天 00:00:00 → 现在</span>
      </div>
      <div class="mt__meta">
        <span class="mt__range">{{ rangeText }}</span>
        <button class="mt__btn" :disabled="loading" @click="load">↻ 刷新</button>
      </div>
    </header>

    <!-- 统计概览 -->
    <section class="mt__stats" v-if="stats">
      <div class="stat" v-for="s in statCards" :key="s.label" :style="{ borderColor: s.color }">
        <div class="stat__num" :style="{ color: s.color }">{{ s.value }}</div>
        <div class="stat__label">{{ s.label }}</div>
      </div>
    </section>

    <!-- 筛选 -->
    <section class="mt__filters">
      <el-select v-model="projectName" placeholder="全部项目" clearable filterable size="small" class="mt__sel" @change="onProjectChange">
        <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.name" />
      </el-select>
      <el-radio-group v-model="viewMode" size="small" @change="onFilterChange">
        <el-radio-button value="process">工作流实例</el-radio-button>
        <el-radio-button value="task">任务实例</el-radio-button>
      </el-radio-group>
      <el-input v-model="keyword" size="small" placeholder="搜索名称" clearable class="mt__kw" @input="onFilterChange" />
      <el-select v-model="stateType" placeholder="全部状态" clearable size="small" class="mt__sel" @change="onFilterChange">
        <el-option v-for="o in stateOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
    </section>

    <div v-if="error" class="mt__err">⚠ {{ error }}</div>

    <!-- 列表 -->
    <el-table
      v-loading="loading"
      :data="rows"
      class="mt__table"
      size="small"
      :max-height="520"
      @sort-change="onSortChange"
      @row-click="onRowClick"
    >
      <el-table-column prop="projectName" label="项目" width="140" sortable>
        <template #default="{ row }">
          <span class="mt__proj">{{ row._projectName || row.projectName || projectName || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" label="名称" min-width="220" show-overflow-tooltip sortable>
        <template #default="{ row }">
          {{ viewMode === 'task' ? row.name : (row.name || row.processInstanceName) }}
        </template>
      </el-table-column>
      <el-table-column prop="state" label="状态" width="120" sortable>
        <template #default="{ row }">
          <el-tag :type="stateBadgeProps(row.state).type" :color="stateBadgeProps(row.state).color" size="small" effect="dark">
            {{ dsStateLabel(row.state) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="startTime" label="开始" width="170" sortable />
      <el-table-column prop="endTime" label="结束" width="170" sortable />
      <el-table-column prop="duration" label="时长" width="110" sortable>
        <template #default="{ row }">{{ formatDuration(row.duration || 0) }}</template>
      </el-table-column>
      <el-table-column label="负责人" width="120">
        <template #default="{ row }">{{ row.executorName || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click.stop="openDeps(row)">依赖级联</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="mt__foot" v-if="!loading && rows.length">
      共 {{ total }} 条 · 当前页 {{ rows.length }} 条
    </div>
    <div class="mt__empty" v-if="!loading && !rows.length && !error">当天暂无符合条件的实例</div>

    <!-- 工作流依赖 DAG 弹窗 -->
    <DsDepsDagDialog
      v-model="depVisible"
      :process-id="depTarget?.processId"
      :process-name="depTarget?.processName"
      :project-name="depTarget?.projectName"
      :process-instance-id="depTarget?.processInstanceId"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { listProjects, listProcessInstances, listTaskInstances, type DsProject, type DsProcessInstance, type DsTaskInstance } from '@/api/ds'
import DsDepsDagDialog from './DsDepsDagDialog.vue'

// ── 状态选项(与正式模块一致)──
interface StateOption { label: string; value: string; color?: string; type?: 'success' | 'failure' | 'paused' | 'stopped' | 'neutral'; running?: boolean }
const stateOptions: StateOption[] = [
  { label: '成功', value: 'SUCCESS', type: 'success' },
  { label: '失败', value: 'FAILURE', type: 'failure' },
  { label: '运行中', value: 'RUNNING_EXEUTION', color: '#3b82f6', running: true },
  { label: '已提交', value: 'SUBMITTED_SUCCESS', color: '#3b82f6', running: true },
  { label: '等待运行', value: 'WAITTING_THREAD', color: '#f59e0b' },
  { label: '暂停', value: 'PAUSE', type: 'paused' },
  { label: '停止', value: 'STOP', type: 'stopped' },
  { label: '终止', value: 'KILL', type: 'stopped' },
]
const extraStateLabels: Record<string, string> = {
  DELAY_EXECUTION: '延时执行', SERIAL_WAIT: '串行等待', NEED_FAULT_TOLERANCE: '需容错', FORBIDDEN: '禁用',
}
function dsStateLabel(state: string): string {
  return stateOptions.find((o) => o.value === state)?.label || extraStateLabels[state] || state
}
function stateBadgeProps(state: string): { type?: 'success' | 'failure' | 'paused' | 'stopped' | 'neutral'; color?: string } {
  const o = stateOptions.find((x) => x.value === state)
  if (o) return { type: o.type, color: o.color }
  return { type: 'neutral' }
}
function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '—'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60)
  return `${h}h ${m}m`
}

// ── 时间窗:当天 00:00:00 → now ──
function todayRange(): { start: string; end: string } {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const end = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  const start = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 00:00:00`
  return { start, end }
}
const rangeText = computed(() => {
  const { start, end } = todayRange()
  return `${start} → ${end}`
})

// ── 数据 ──
const loading = ref(false)
const error = ref('')
const total = ref(0)
const projects = ref<DsProject[]>([])
const projectName = ref('')
const viewMode = ref<'process' | 'task'>('process')
const keyword = ref('')
const stateType = ref('')
const processRows = ref<DsProcessInstance[]>([])
const taskRows = ref<DsTaskInstance[]>([])
const rows = computed<any[]>(() => (viewMode.value === 'task' ? taskRows.value : processRows.value))

// ── 工作流依赖 DAG 弹窗 ──
const depVisible = ref(false)
const depTarget = ref<{ processId?: number; processName?: string; projectName?: string; processInstanceId?: number } | null>(null)

let loadSeq = 0
async function load() {
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  try {
    const { start, end } = todayRange()
    const common = { pageNo: 1, pageSize: 500, stateType: stateType.value || undefined, startDate: start, endDate: end }
    if (viewMode.value === 'task') {
      if (!projectName.value) { taskRows.value = []; total.value = 0; if (seq === loadSeq) loading.value = false; return }
      const d = await listTaskInstances(projectName.value, { ...common, taskName: keyword.value || undefined })
      if (seq !== loadSeq) return
      taskRows.value = (d.totalList || []).map((x: any) => ({ ...x, projectName: projectName.value }))
      total.value = d.total || 0
    } else {
      if (!projectName.value) {
        // 全部项目:用项目列表逐个查询(限并发),避免 dolphin 全局搜索打垮
        const list = projects.value
        const all: any[] = []
        let cursor = 0
        const worker = async () => {
          while (cursor < list.length) {
            const p = list[cursor++]
            try {
              const dd = await listProcessInstances(p.name, { ...common, searchVal: keyword.value || undefined })
              all.push(...(dd.totalList || []).map((x: any) => ({ ...x, _projectName: p.name, projectName: p.name })))
            } catch { /* skip */ }
          }
        }
        await Promise.all([worker(), worker(), worker()])
        if (seq !== loadSeq) return
        processRows.value = all
        total.value = all.length
      } else {
        const d = await listProcessInstances(projectName.value, { ...common, searchVal: keyword.value || undefined })
        if (seq !== loadSeq) return
        processRows.value = (d.totalList || []).map((x: any) => ({ ...x, _projectName: projectName.value, projectName: projectName.value }))
        total.value = d.total || 0
      }
    }
  } catch (e) {
    if (seq !== loadSeq) return
    error.value = e instanceof Error ? e.message : String(e)
    ElMessage.error(error.value)
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

// ── 统计概览(基于当前结果集)──
const stats = computed(() => rows.value.length > 0)
const statCards = computed(() => {
  const list = rows.value
  const n = list.length
  const cnt = (s: string) => list.filter((i) => i.state === s).length
  const success = cnt('SUCCESS'); const failed = cnt('FAILURE'); const running = cnt('RUNNING_EXEUTION')
  const done = success + failed
  const rate = done > 0 ? ((success / done) * 100).toFixed(1) + '%' : '—'
  const avg = n > 0 ? Math.round(list.reduce((a, i) => a + (i.duration || 0), 0) / n) : 0
  return [
    { label: '总数', value: n, color: 'var(--bd-primary)' },
    { label: '成功', value: success, color: '#10b981' },
    { label: '失败', value: failed, color: '#ef4444' },
    { label: '运行中', value: running, color: '#3b82f6' },
    { label: '成功率', value: rate, color: '#10b981' },
    { label: '平均时长', value: formatDuration(avg), color: '#f59e0b' },
  ]
})

function onProjectChange() { load() }
function onFilterChange() { load() }
function onRowClick() { /* demo:可选扩展跳转详情 */ }

// ── 打开工作流依赖 DAG(任务实例:按 processInstanceId 反查;工作流实例:按 processId 直接查)──
function openDeps(row: any) {
  if (viewMode.value === 'task') {
    depTarget.value = {
      projectName: row._projectName || projectName.value,
      processInstanceId: row.processInstanceId,
      processName: row.processInstanceName
    }
  } else {
    depTarget.value = {
      processId: row.processDefinitionId,
      processName: row.name || row.processName || row.processInstanceName,
      projectName: row._projectName || projectName.value,
      processInstanceId: row.processDefinitionId ? undefined : (row.id || undefined)
    }
  }
  depVisible.value = true
}

// ── 表头排序(前端排序,基于当前结果集)──
const sortBy = ref<{ prop: string; order: string } | null>(null)
function onSortChange({ prop, order }: { prop: string; order: string }) {
  sortBy.value = order ? { prop, order } : null
  const list = rows.value
  if (!sortBy.value) return
  const { prop: p, order: o } = sortBy.value
  const factor = o === 'descending' ? -1 : 1
  const val = (r: any) => {
    const v = r[p]
    return typeof v === 'number' ? v : String(v ?? '').toLowerCase()
  }
  const aux = [...list].sort((a, b) => {
    const x = val(a); const y = val(b)
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * factor
    return x < y ? -factor : x > y ? factor : 0
  })
  if (viewMode.value === 'task') taskRows.value = aux as any
  else processRows.value = aux as any
}

onMounted(async () => {
  try {
    projects.value = await listProjects()
    // demo 默认选中第一个项目,确保一进页面就有当日数据展示
    if (projects.value.length) projectName.value = projects.value[0].name
  } catch { /* 无项目列表也能按单项目查 */ }
  load()
})
</script>

<style scoped lang="scss">
.mt { padding: 16px 20px; color: var(--bd-text); }
.mt__head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.mt__title { display: flex; align-items: baseline; gap: 10px; }
.mt__logo { color: var(--bd-primary); font-size: 18px; }
.mt__title h1 { font-size: 18px; margin: 0; font-weight: 600; }
.mt__sub { color: var(--bd-muted); font-size: 12px; }
.mt__meta { display: flex; align-items: center; gap: 12px; }
.mt__range { font-size: 12px; color: var(--bd-muted); font-family: monospace; }
.mt__btn { background: var(--bd-panel); border: 1px solid var(--bd-border); color: var(--bd-text); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
.mt__btn:hover:not(:disabled) { border-color: var(--bd-primary); color: var(--bd-primary); }
.mt__btn:disabled { opacity: .5; cursor: default; }
.mt__stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 16px; }
.stat { background: var(--bd-panel); border: 1px solid var(--bd-border); border-left-width: 3px; border-radius: 8px; padding: 12px 14px; }
.stat__num { font-size: 22px; font-weight: 700; font-family: monospace; }
.stat__label { font-size: 12px; color: var(--bd-muted); margin-top: 4px; }
.mt__filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.mt__sel { width: 180px; }
.mt__kw { width: 200px; }
.mt__table { background: var(--bd-panel); border-radius: 8px; }
.mt__proj { color: var(--bd-muted); font-size: 12px; }
.mt__err { color: #ef4444; background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.25); padding: 10px 14px; border-radius: 6px; margin-bottom: 12px; }
.mt__foot { color: var(--bd-muted); font-size: 12px; margin-top: 10px; }
.mt__empty { color: var(--bd-muted); text-align: center; padding: 40px; }
</style>
