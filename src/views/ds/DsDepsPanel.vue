<template>
  <div class="dp">
    <div class="dp__head">
      <div class="dp__title">
        <span class="dp__logo">◈</span>
        工作流依赖 · {{ props.processName || '' }}
        <span class="dp__proj" v-if="props.projectName">[{{ props.projectName }}]</span>
      </div>
      <div class="dp__meta">
        <el-button link type="primary" size="small" :loading="loading" @click="load">↻ 刷新</el-button>
      </div>
    </div>

    <div class="dp__keys">
      <span class="dk"><i class="dk__i" style="background:#10b981"></i>成功</span>
      <span class="dk"><i class="dk__i" style="background:#ef4444"></i>失败</span>
      <span class="dk"><i class="dk__i" style="background:#3b82f6"></i>运行中</span>
      <span class="dk"><i class="dk__i" style="background:#7c3aed"></i>当前工作流</span>
      <span class="dk"><i class="dk__i" style="background:#64748b"></i>未执行</span>
    </div>

    <div class="dp__body">
      <div v-if="!props.processId" class="dp__empty">← 在左侧选择一条工作流实例,查看其跨项目依赖 DAG</div>
      <div v-else-if="error" class="dp__err">⚠ {{ error }}</div>
      <div v-else-if="loading && !tree" class="dp__empty" v-loading="true">加载依赖图…</div>
      <template v-else-if="tree">
        <div class="dp__sec-title">
          上下游依赖 DAG(节点标最新实例状态;点「重跑」勾选参与级联,上游仅展示;双击节点跳转)
        </div>
        <div ref="g6El" class="dp__g6" v-loading="loading"></div>
        <div v-if="!hasDep" class="dp__empty">该工作流无上下游依赖</div>
      </template>
      <div v-else class="dp__empty">暂无依赖数据(联系运维在服务器执行全量刷新)</div>
    </div>

    <!-- 节点右键菜单 -->
    <div v-show="ctx.show" class="dp__ctx" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }">
      <div class="dp__ctx-title">{{ ctx.processName }}</div>
      <div class="dp__ctx-item" @click="copyName">复制工作流名称</div>
      <div class="dp__ctx-item" @click="runFrom(ctx.node)">执行当前及以后节点任务</div>
    </div>

    <!-- 节点 hover 提示:开始/结束时间 -->
    <div v-show="tip.show" class="dp__tip" :style="{ left: tip.x + 'px', top: tip.y + 'px' }">
      <div class="dp__tip-name">{{ tip.processName }}</div>
      <div class="dp__tip-row">开始: {{ tip.startTime }}</div>
      <div class="dp__tip-row">结束: {{ tip.endTime }}</div>
    </div>

    <div class="dp__foot">
      <el-button link @click="checked = new Set()">清空勾选</el-button>
      <el-button type="primary" size="small" :disabled="!checked.size" @click="doRerun">
        一键级联调起({{ checked.size }})
      </el-button>
    </div>

    <!-- 级联重跑结果弹窗 -->
    <el-dialog v-model="rerunResultVisible" title="级联调起结果" width="680px" append-to-body>
      <el-table :data="rerunResult" border size="small" max-height="420">
        <el-table-column type="index" label="#" width="50" align="center" />
        <el-table-column label="状态" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.ok ? 'success' : 'danger'" size="small">{{ row.ok ? '已执行' : '失败' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="项目" prop="projectName" min-width="120" show-overflow-tooltip />
        <el-table-column label="工作流" prop="processName" min-width="180" show-overflow-tooltip />
        <el-table-column label="实例ID" width="110">
          <template #default="{ row }">
            <span>{{ row.instanceId || (row.newInstance ? '新建' : '—') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="信息" prop="msg" min-width="120" show-overflow-tooltip />
      </el-table>
      <template #footer>
        <el-button @click="rerunResultVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import G6 from '@antv/g6'
import {
  fetchWorkflowTree,
  rerunCascade,
  type WorkflowTree,
  type DepNode,
  type CascadeNode
} from '@/api/dsDeps'

defineOptions({ name: 'DsDepsPanel' })

const props = defineProps<{
  /** 当前工作流信息(为空时面板显示空态) */
  processId?: number
  processName?: string
  projectName?: string
  /** 当前实例(用于级联重跑) */
  instanceId?: number
}>()

const emit = defineEmits<{
  (e: 'jump', node: DepNode): void
}>()

const tree = ref<WorkflowTree | null>(null)
const loading = ref(false)
const error = ref('')
// 勾选重跑的节点(递归收集下游),当前 + 下游默认全选;上游仅展示
const checked = ref<Set<string>>(new Set())
const currentKey = ref('')

// 依赖状态查询固定在当天(00:00→现在);不做日期范围选择
const g6El = ref<HTMLDivElement>()
let graph: any | null = null
let ro: ResizeObserver | null = null

// 节点对象引用(供双击跳转)
const nodeRefMap = new Map<string, DepNode>()

// 右键菜单状态(相对 .dp 定位)
const ctx = ref<{ show: boolean; x: number; y: number; node: DepNode | null; processName: string }>({
  show: false, x: 0, y: 0, node: null, processName: ''
})
// hover 提示状态(开始/结束时间)
const tip = ref<{ show: boolean; x: number; y: number; processName: string; startTime: string; endTime: string }>({
  show: false, x: 0, y: 0, processName: '', startTime: '', endTime: ''
})

/** 深空主题取色:运行时读 CSS 变量(切换主题后重渲染即生效) */
function cv(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}
const C = {
  primary: () => cv('--bd-primary', '#5e6ad2'),
  text: () => cv('--bd-text', '#333'),
  muted: () => cv('--bd-muted', '#888'),
  panel: () => cv('--bd-panel', '#fff'),
  bg: () => cv('--bd-bg', '#f5f7fa'),
  border: () => cv('--bd-border', '#c9cdd6')
}

// 状态集合(与当日页一致):运行态含 RUNNING_EXECUTION/SUBMITTED_SUCCESS 等
const RUNNING_STATES = ['RUNNING', 'RUNNING_EXECUTION', 'SUBMITTED_SUCCESS', 'DELAY_EXECUTION', 'SERIAL_WAIT', 'WAITTING_THREAD']
const FAILURE_STATES = ['FAILURE', 'KILL', 'STOP']
const isRunning = (s: string | null) => !!s && RUNNING_STATES.includes(s)
const isFailure = (s: string | null) => !!s && FAILURE_STATES.includes(s)
const stColor = (s: string | null) =>
  s === 'SUCCESS' ? '#10b981' : isFailure(s) ? '#ef4444' : isRunning(s) ? '#3b82f6' : '#64748b'
const stMark = (s: string | null) =>
  s === 'SUCCESS' ? '成功' : isFailure(s) ? '失败' : isRunning(s) ? '运行中' : '未执行'
const formatDur = (sec?: number | null) => {
  if (!sec || sec <= 0) return ''
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${h}h ${m}m`
}

// ── 把依赖树展平成 DAG 有向图(上游 → 当前 → 下游) ─────────
interface DagNode {
  id: string
  processName: string
  projectName: string
  state: string | null
  isCurrent: boolean
  isUpstream: boolean
  /** G6 节点数据 */
  [k: string]: unknown
}

function toDagData() {
  const nodes = new Map<string, DagNode>()
  const edges = new Set<string>() // `${from}|${to}`
  nodeRefMap.clear()

  const addNode = (
    n: { processId: number; processName: string; projectName: string },
    isCurrent = false,
    isUpstream = false
  ) => {
    const key = String(n.processId)
    let existing = nodes.get(key)
    if (!existing) {
      existing = {
        id: key,
        processName: n.processName,
        projectName: n.projectName,
        state: null,
        isCurrent,
        isUpstream: false
      }
      nodes.set(key, existing)
    }
    if (isCurrent) existing.isCurrent = true
    if (isUpstream) existing.isUpstream = true
  }
  const setState = (n: { processId: number; instance?: DepNode['instance'] }) => {
    const cur = nodes.get(String(n.processId))
    if (cur) cur.state = n.instance?.state ?? null
    if (n.instance) nodeRefMap.set(String(n.processId), n as DepNode)
  }
  const addEdge = (from: number, to: number) => edges.add(`${from}|${to}`)

  if (!tree.value) return { nodes: [], edges: [] }
  const t = tree.value
  addNode(t, true)
  setState(t)
  // 上游树:更上游 → 当前 (仅展示)
  const walkU = (list: DepNode[] | undefined, parentId: number) => {
    for (const n of list || []) {
      addNode(n, false, true)
      setState(n)
      addEdge(n.processId, parentId)
      walkU(n.upstream, n.processId)
    }
  }
  // 下游树:当前 → 下游 → 更下游 (可勾选重跑)
  const walkD = (list: DepNode[] | undefined, parentId: number) => {
    for (const n of list || []) {
      addNode(n, false, false)
      setState(n)
      addEdge(parentId, n.processId)
      walkD(n.downstream, n.processId)
    }
  }
  walkU(t.upstream, t.processId)
  walkD(t.downstream, t.processId)

  return {
    nodes: [...nodes.values()],
    edges: [...edges].map((e) => {
      const [s, to] = e.split('|')
      return { source: s, target: to }
    })
  }
}

/** 递归收集下游节点(用于级联重跑默认勾选) */
function collectDownstream(nodes: DepNode[] | undefined): DepNode[] {
  const out: DepNode[] = []
  for (const n of nodes || []) {
    out.push(n)
    out.push(...collectDownstream(n.downstream))
  }
  return out
}

/** 收集节点自身 + 其所有下游子孙(右键"执行当前及以后"用),按树去重 */
function collectSelfAndDownstream(node: DepNode): DepNode[] {
  const out: DepNode[] = []
  const seen = new Set<string>()
  const walk = (n: DepNode) => {
    const k = String(n.processId)
    if (seen.has(k)) return
    seen.add(k)
    out.push(n)
    for (const child of n.downstream || []) walk(child)
  }
  walk(node)
  return out
}

// ── 注册 DAG 卡片节点 ──────────────────────────
function registerDepCard() {
  if ((G6 as any).getRegisteredNode && (G6 as any).getRegisteredNode()['deps-dag-card']) return
  const W = 190
  const H = 66
  G6.registerNode(
    'deps-dag-card',
    {
      draw(cfg: any, group: any) {
        const cur = cfg.isCurrent
        const st = cfg.state
        const border = cur ? '#8b5cf6' : stColor(st)
        const fill = cur ? 'rgba(139,92,246,0.10)' : C.panel()
        const sel = cfg.__selected

        group.addShape('rect', {
          attrs: {
            x: -W / 2,
            y: -H / 2,
            width: W,
            height: H,
            radius: 8,
            fill,
            stroke: border,
            lineWidth: cur ? 3 : 1.5,
            shadowColor: cur ? 'rgba(139,92,246,0.3)' : 'rgba(0,0,0,0.08)',
            shadowBlur: cur ? 16 : 4,
            cursor: 'pointer'
          }
        })
        // 状态圆点
        group.addShape('circle', {
          attrs: {
            x: -W / 2 + 12,
            y: -H / 2 + 13,
            r: 4,
            fill: stColor(st),
            cursor: 'pointer'
          }
        })
        // 工作流名称
        group.addShape('text', {
          attrs: {
            x: -W / 2 + 22,
            y: -H / 2 + 13,
            text: (cur ? '★ ' : '') + cfg.processName,
            fontSize: 12,
            fontWeight: cur ? 700 : 500,
            fill: cur ? '#7c3aed' : C.text(),
            textAlign: 'left',
            textBaseline: 'middle',
            cursor: 'pointer'
          }
        })
        // 项目 · 状态
        group.addShape('text', {
          attrs: {
            x: -W / 2 + 10,
            y: -H / 2 + 33,
            text: `${cfg.projectName}  ·  ${stMark(st)}`,
            fontSize: 10,
            fill: C.muted(),
            textAlign: 'left',
            textBaseline: 'middle'
          }
        })
        // 执行耗时(底部行,只显示耗时秒数不显示时间点)
        const durText = cfg.duration ? `⏱ 耗时 ${formatDur(cfg.duration)}` : ''
        if (durText) {
          group.addShape('text', {
            attrs: {
              x: -W / 2 + 10,
              y: -H / 2 + 51,
              text: durText,
              fontSize: 9,
              fill: C.muted(),
              textAlign: 'left',
              textBaseline: 'middle'
            }
          })
        }
        // 重跑勾选按钮(右下角,非当前节点且非上游)
        if (!cur && !cfg.isUpstream) {
          group.addShape('rect', {
            name: 'rerun-bg',
            attrs: {
              x: W / 2 - 42,
              y: -H / 2 + 20,
              width: 32,
              height: 18,
              radius: 4,
              fill: sel ? C.primary() : C.panel(),
              stroke: C.primary(),
              lineWidth: 1,
              cursor: 'pointer'
            }
          })
          group.addShape('text', {
            name: 'rerun-text',
            attrs: {
              x: W / 2 - 26,
              y: -H / 2 + 29,
              text: sel ? '已选' : '重跑',
              fontSize: 10,
              fill: sel ? C.bg() : C.primary(),
              textAlign: 'center',
              textBaseline: 'middle',
              cursor: 'pointer'
            }
          })
        }
        return group
      }
    },
    'single-node'
  )
}

function renderChart() {
  if (!g6El.value || !tree.value) return
  graph?.destroy()
  registerDepCard()
  const data = toDagData()
  // 回填实例信息:最近执行时间 / 执行时长 / 启停时间(工具提示用)
  for (const n of data.nodes) {
    const dep = nodeRefMap.get(n.id)
    n.instanceTime = dep?.instance?.startTime ? dep.instance.startTime.replace('T', ' ').slice(5, 16) : ''
    n.duration = dep?.instance?.duration ?? null
    n.startTime = dep?.instance?.startTime ?? null
    n.endTime = dep?.instance?.endTime ?? null
    n.instance = dep?.instance ?? null
    n.depNode = dep ?? null
  }

  graph = new G6.Graph({
    container: g6El.value,
    width: g6El.value.clientWidth || 800,
    height: g6El.value.clientHeight || 480,
    fitView: true,
    fitViewPadding: 30,
    modes: { default: ['drag-canvas', 'zoom-canvas', 'drag-node'] },
    layout: { type: 'dagre', rankdir: 'LR', nodesep: 40, ranksep: 90 },
    defaultNode: { type: 'deps-dag-card', size: [190, 66] },
    defaultEdge: {
      type: 'cubic-horizontal',
      style: { stroke: C.border(), lineWidth: 1.5, endArrow: { path: G6.Arrow.triangle(6, 8, 0), fill: C.border() } }
    }
  })
  graph.data(data)
  graph.render()
  graph.fitView(30, true, false)

  // 单击:重跑按钮勾选/取消;卡片主体折叠/展开子树(树路径节点才支持)
  graph.on('node:click', (evt: any) => {
    const target = evt.target
    const name = target.get ? target.get('name') : ''
    const item = evt.item
    const model = item.getModel()
    if (name === 'rerun-bg' || name === 'rerun-text') {
      const k = String(model.id)
      const s = new Set(checked.value)
      if (s.has(k)) s.delete(k)
      else s.add(k)
      checked.value = s
      model.__selected = s.has(k)
      graph?.refreshItem(item)
      return
    }
  })

  // 双击节点 → 跳转到任务监控对应实例
  graph.on('node:dblclick', (evt: any) => {
    const id = evt.item.getModel().id
    const node = nodeRefMap.get(id)
    if (node) emit('jump', node)
    else ElMessage.info('当前节点')
  })

  // 右键节点 → 弹出菜单(复制名称 / 执行当前及以后)
  graph.on('node:contextmenu', (evt: any) => {
    evt.preventDefault?.()
    evt.originalEvent?.preventDefault?.()
    const model = evt.item.getModel()
    let node = nodeRefMap.get(model.id) || null
    // 当前工作流节点可能无 nodeRef 记录(无实例时),用合成节点以便"执行当前及以后"
    if (!node && String(model.id) === currentKey.value && tree.value) {
      node = {
        processId: tree.value.processId,
        processName: tree.value.processName,
        projectName: tree.value.projectName,
        downstream: tree.value.downstream
      }
    }
    ctx.value = {
      show: true,
      x: evt.clientX ?? evt.originalEvent?.clientX ?? 0,
      y: evt.clientY ?? evt.originalEvent?.clientY ?? 0,
      node,
      processName: model.processName || ''
    }
  })
  // 画布/空白点击 → 关闭菜单
  graph.on('canvas:click', () => { ctx.value.show = false })

  // hover 节点 → 显示开始/结束时间
  graph.on('node:mouseenter', (evt: any) => {
    const model = evt.item.getModel()
    const fmt = (t?: string | null) => (t ? t.replace('T', ' ').slice(0, 19) : '—')
    const cx = evt.clientX ?? evt.originalEvent?.clientX ?? 0
    const cy = evt.clientY ?? evt.originalEvent?.clientY ?? 0
    tip.value = {
      show: true,
      x: cx + 14,
      y: cy + 14,
      processName: model.processName || '',
      startTime: fmt(model.startTime),
      endTime: fmt(model.endTime)
    }
  })
  graph.on('node:mouseleave', () => { tip.value.show = false })
}

function destroyChart() {
  graph?.destroy()
  graph = null
  ro?.disconnect()
  ro = null
}

async function load() {
  if (!props.processId) {
    destroyChart()
    tree.value = null
    checked.value = new Set()
    return
  }
  loading.value = true
  error.value = ''
  try {
    tree.value = await fetchWorkflowTree(props.processId)
    currentKey.value = String(props.processId)
    // 默认勾选:当前 + 所有下游(上游不重跑)
    const downs = collectDownstream(tree.value?.downstream)
    checked.value = new Set([currentKey.value, ...downs.map((n) => String(n.processId))])
    await nextTick()
    renderChart()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    tree.value = null
  } finally {
    loading.value = false
  }
}

/** 点击节点卡片 → 跳转到任务监控对应工作流实例 */
/** 级联重跑:勾选的节点,有实例重跑/无实例后端自动新建 */
interface RerunDisplayItem {
  ok: boolean
  msg: string
  projectName: string
  processName: string
  instanceId?: number
  newInstance?: boolean
}
const rerunResult = ref<RerunDisplayItem[]>([])
const rerunResultVisible = ref(false)

/** 级联重跑/执行公共函数:确认 + 调 rerunCascade + 展示结果 */
async function runCascadeNodes(nodes: CascadeNode[], title = '级联重跑确认') {
  if (!nodes.length) {
    ElMessage.warning('没有可执行的节点')
    return
  }
  // 操作确认:会真实触发实例重跑/新建(无实例自动新建),误触影响生产工作流
  const newCount = nodes.filter((n) => !n.instanceId).length
  const list = nodes.map((n) => `· ${n.processName}${n.instanceId ? `(实例 ${n.instanceId})` : '(将新建实例)'}`)
  const preview = list.length > 10 ? [...list.slice(0, 10), `… 等共 ${list.length} 个`] : list
  try {
    await ElMessageBox.confirm(
      `确定对以下 ${nodes.length} 个工作流执行吗?\n${preview.join('\n')}` +
        (newCount ? `\n(其中 ${newCount} 个今日无实例,将自动新建)` : ''),
      title,
      { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    const results = await rerunCascade(nodes)
    rerunResult.value = results.map((r) => ({
      ok: r.ok,
      msg: r.msg || (r.ok ? 'success' : 'failed'),
      projectName: r.projectName || '',
      processName: r.processName || r.name || '',
      instanceId: r.instanceId,
      newInstance: r.newInstance
    }))
    rerunResultVisible.value = true
  } catch (e) {
    ElMessage.error(`执行失败:${e instanceof Error ? e.message : e}`)
  }
}

async function doRerun() {
  if (!props.instanceId && !checked.value.has(currentKey.value)) {
    ElMessage.warning('缺少当前实例')
    return
  }
  const nodes: CascadeNode[] = []
  if (checked.value.has(currentKey.value)) {
    nodes.push({
      projectName: props.projectName || '',
      processId: props.processId || 0,
      processName: props.processName || '',
      instanceId: props.instanceId
    })
  }
  for (const n of collectDownstream(tree.value?.downstream)) {
    if (checked.value.has(String(n.processId))) {
      nodes.push({ projectName: n.projectName, processId: n.processId, processName: n.processName, instanceId: n.instance?.instanceId })
    }
  }
  await runCascadeNodes(nodes, '级联重跑确认')
}

/** 右键菜单:复制工作流名称 */
async function copyName() {
  const name = ctx.value.processName
  ctx.value.show = false
  if (!name) return
  try {
    await navigator.clipboard.writeText(name)
    ElMessage.success('已复制工作流名称')
  } catch {
    ElMessage.error('复制失败,请手动复制')
  }
}

/** 右键菜单:执行当前节点及以后(其所有下游)节点任务 */
async function runFrom(node: DepNode | null) {
  ctx.value.show = false
  if (!node) {
    ElMessage.warning('无法定位该节点')
    return
  }
  const targets = collectSelfAndDownstream(node)
  const nodes: CascadeNode[] = targets.map((n) => ({
    projectName: n.projectName,
    processId: n.processId,
    processName: n.processName,
    instanceId: n.instance?.instanceId
  }))
  await runCascadeNodes(nodes, `执行「${node.processName}」及其后 ${nodes.length - 1} 个下游节点`)
}

// 当前工作流变化 → 重新加载
watch(
  () => props.processId,
  () => load()
)

// 尺寸自适应
onMounted(() => {
  // 初进即有 processId(抽屉/右侧面板场景)时自动加载依赖 DAG,无需手动刷新
  if (props.processId) load()
  if (g6El.value) {
    ro = new ResizeObserver(() => {
      if (g6El.value && graph) {
        graph.changeSize(g6El.value.clientWidth, g6El.value.clientHeight)
        graph.fitView(30, true, false)
      }
    })
    ro.observe(g6El.value)
  }
})
onBeforeUnmount(destroyChart)

const hasDep = computed(() => Boolean(tree.value && (tree.value.upstream?.length || tree.value.downstream?.length)))
</script>

<style scoped lang="scss">
.dp {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1;
  position: relative;
  box-sizing: border-box;
}

.dp__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.dp__logo {
  color: $primary;
  margin-right: 4px;
}

.dp__title {
  font-weight: 600;
  font-size: 14px;
}

.dp__proj {
  color: $muted;
  font-size: 12px;
  margin-left: 4px;
}

.dp__meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dp__range {
  color: $muted;
  font-size: 12px;
}

.dp__keys {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.dk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: $muted;
}
.dk__i {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  display: inline-block;
}

.dp__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 10px;
  overflow: hidden;
  box-sizing: border-box;
}

.dp__sec-title {
  font-size: 12px;
  font-weight: 600;
  color: $muted;
  margin: 4px 0;
}

.dp__g6 {
  flex: 1;
  min-height: 320px;
  border: 1px dashed $border;
  border-radius: 6px;
  background: $panel;
}

.dp__empty {
  color: $muted;
  font-size: 12px;
  padding: 16px;
  text-align: center;
}

.dp__err {
  color: #f56c6c;
  padding: 8px;
}

.dp__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 8px 12px;
}

/* 节点右键菜单 */
.dp__ctx {
  position: fixed;
  z-index: 999;
  min-width: 180px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  padding: 4px;
}
.dp__ctx-title {
  font-size: 11px;
  color: #94a3b8;
  padding: 6px 10px 4px;
  border-bottom: 1px solid #334155;
  margin-bottom: 2px;
  word-break: break-all;
}
.dp__ctx-item {
  padding: 7px 10px;
  font-size: 13px;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
}
.dp__ctx-item:hover {
  background: rgba(139, 92, 246, 0.25);
  color: #fff;
}

/* 节点 hover 提示(开始/结束时间) */
.dp__tip {
  position: fixed;
  z-index: 999;
  min-width: 220px;
  max-width: 300px;
  background: rgba(15, 23, 42, 0.96);
  border: 1px solid #334155;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  padding: 8px 10px;
  pointer-events: none;
}
.dp__tip-name {
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
  margin-bottom: 4px;
  word-break: break-all;
}
.dp__tip-row {
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.6;
}
</style>
