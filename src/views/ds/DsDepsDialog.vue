<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import G6 from '@antv/g6'
import {
  fetchWorkflowTree,
  rerunCascade,
  type WorkflowTree,
  type DepNode,
  type CascadeNode
} from '@/api/dsDeps'
import DepBranch from './DepBranch.vue'

defineOptions({ name: 'DsDepsDialog' })

const props = defineProps<{
  modelValue: boolean
  // 当前工作流信息
  processId: number
  processName: string
  projectName: string
  // 当前实例(用于级联重跑)
  instanceId?: number
  instanceName?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'jump', node: DepNode): void
}>()

const tree = ref<WorkflowTree | null>(null)
const loading = ref(false)
const error = ref('')
// 勾选重跑的节点(递归收集下游),默认全选:当前 + 所有下游
const checked = ref<Set<string>>(new Set())
const currentKey = ref('')

// ── G6 依赖图(当前 + 下游,向右树) ──────────────────────────
const g6El = ref<HTMLDivElement>()
let graph: any | null = null

/** 递归收集下游节点 */
function collectDownstream(nodes: DepNode[] | undefined): DepNode[] {
  const out: DepNode[] = []
  for (const n of nodes || []) {
    out.push(n)
    out.push(...collectDownstream(n.downstream))
  }
  return out
}

function toG6Node(n: DepNode): any {
  return {
    id: String(n.processId),
    name: n.processName,
    project: n.projectName,
    state: n.instance?.state || null,
    crontab: n.crontab || '',
    instanceId: n.instance?.instanceId,
    children: (n.downstream || []).map(toG6Node)
  }
}

function buildTreeData(): any {
  return {
    id: String(props.processId),
    name: props.processName,
    project: props.projectName,
    state: 'CURRENT',
    crontab: '',
    children: (tree.value?.downstream || []).map(toG6Node)
  }
}

const stColor = (s: string | null) =>
  s === 'SUCCESS' ? '#67c23a' : s === 'FAILURE' ? '#f56c6c' : s === 'RUNNING' ? '#5e6ad2' : '#c9cdd6'
const stMark = (s: string | null) => (s === 'SUCCESS' ? '✓ 成功' : s === 'FAILURE' ? '✗ 失败' : s === 'RUNNING' ? '● 运行中' : '近1天无实例')
const stText = (s: string | null) => (s === 'SUCCESS' || s === 'FAILURE' || s === 'RUNNING' ? s : '')
const cronText = (c: string | null | undefined) =>
  !c ? '' : c.trim().split(/\s+/).length === 5 ? `⏱ ${c.split(/\s+/)[0]} ${c.split(/\s+/)[1]} 每天` : `⏱ ${c}`

/** 注册自定义卡片节点(与手写卡片一致的视觉) */
function registerDepCard() {
  if ((G6 as any).getRegisteredNode && (G6 as any).getRegisteredNode()['dep-card']) return
  G6.registerNode(
    'dep-card',
    {
      draw(cfg: any, group: any) {
        const W = 190
        const H = 66
        const st = cfg.state
        const proj = cfg.project
        const crt = cfg.crontab
        const cur = cfg.isCurrent
        const name = cfg.label || cfg.name || cfg.id
        const sel = cfg.__selected
        const border = cur ? '#5e6ad2' : stColor(st)

        const key = group.addShape('rect', {
          attrs: {
            x: -W / 2,
            y: -H / 2,
            width: W,
            height: H,
            radius: 8,
            fill: cur ? 'rgba(94,106,210,0.06)' : '#fff',
            stroke: border,
            lineWidth: cur ? 2.5 : 1.5,
            shadowColor: 'rgba(0,0,0,0.08)',
            shadowBlur: cur ? 12 : 4,
            cursor: 'pointer'
          }
        })

        // 名称(当前加 ★)
        group.addShape('text', {
          attrs: {
            x: -W / 2 + 10,
            y: -H / 2 + 14,
            text: (cur ? '★ ' : '') + name,
            fontSize: 12,
            fontWeight: cur ? 700 : 500,
            fill: cur ? '#5e6ad2' : '#333',
            textAlign: 'left',
            textBaseline: 'middle'
          }
        })

        // 项目 + 状态
        group.addShape('text', {
          attrs: {
            x: -W / 2 + 10,
            y: -H / 2 + 32,
            text: `${proj}  ${stMark(st)}${stText(st) ? ' ' + stText(st) : ''}`,
            fontSize: 10,
            fill: '#888',
            textAlign: 'left',
            textBaseline: 'middle'
          }
        })

        // cron(有调度才显示)
        if (cronText(crt)) {
          group.addShape('text', {
            attrs: {
              x: -W / 2 + 10,
              y: -H / 2 + 50,
              text: cronText(crt),
              fontSize: 10,
              fill: '#a8abb2',
              textAlign: 'left',
              textBaseline: 'middle'
            }
          })
        }

        // 重跑勾选按钮(右下角,非当前节点)
        if (!cur) {
          group.addShape('rect', {
            name: 'rerun-bg',
            attrs: {
              x: W / 2 - 42,
              y: -H / 2 + 20,
              width: 32,
              height: 18,
              radius: 4,
              fill: sel ? '#5e6ad2' : '#fff',
              stroke: '#5e6ad2',
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
              fill: sel ? '#fff' : '#5e6ad2',
              textAlign: 'center',
              textBaseline: 'middle',
              cursor: 'pointer'
            }
          })
        }

        return key
      }
    },
    'single-node'
  )
}

function renderChart() {
  if (!g6El.value || !tree.value) return
  graph?.destroy()
  registerDepCard()
  const data = buildTreeData()
  graph = new G6.TreeGraph({
    container: g6El.value,
    width: g6El.value.clientWidth || 800,
    height: g6El.value.clientHeight || 500,
    fitView: true,
    modes: {
      default: ['drag-canvas', 'zoom-canvas', 'drag-node']
    },
    defaultEdge: {
      type: 'cubic-horizontal',
      style: { stroke: '#b9c2d0', lineWidth: 1.5, endArrow: { path: G6.Arrow.triangle(4, 6, 0), d: 0 } }
    },
    layout: {
      type: 'compactBox',
      direction: 'LR',
      getId(d: any) {
        return d.id
      },
      getWidth: () => 190,
      getHeight: () => 66,
      getVGap: () => 16,
      getHGap: () => 70
    }
  })

  graph.node((node: any) => ({
    type: 'dep-card',
    size: [190, 66],
    label: node.name,
    state: node.state,
    project: node.project,
    crontab: node.crontab,
    isCurrent: node.id === currentKey.value,
    __selected: checked.value.has(node.id)
  }))

  graph.data(data)
  graph.render()
  graph.fitView(30, true, false)

  // 单击:重跑按钮 → 勾选/取消;卡片主体 → 折叠/展开子树
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
    // 折叠/展开
    if (model.children && model.children.length) {
      model.collapsed = !model.collapsed
      graph?.updateChildren(model)
    }
  })

  // 双击节点 → 跳转到任务监控对应实例
  graph.on('node:dblclick', (evt: any) => {
    const id = evt.item.getModel().id
    const findNode = (nodes: DepNode[] | undefined): DepNode | null => {
      for (const n of nodes || []) {
        if (String(n.processId) === id) return n
        const f = findNode(n.downstream)
        if (f) return f
      }
      return null
    }
    const node = findNode(tree.value?.downstream)
    if (node) onJump(node)
    else ElMessage.info('当前节点')
  })

  // 窗口 resize 自适应
  graph.on('canvas:click', () => {})
  const ro = new ResizeObserver(() => {
    if (g6El.value) graph?.changeSize(g6El.value.clientWidth, g6El.value.clientHeight)
  })
  ro.observe(g6El.value)
  ;(graph as any).__ro = ro
}

async function load() {
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
  } finally {
    loading.value = false
  }
}

function toggle(processId: number) {
  const k = String(processId)
  const s = new Set(checked.value)
  if (s.has(k)) s.delete(k)
  else s.add(k)
  checked.value = s
}

/** 点击节点卡片 → 关闭弹窗并跳转到任务监控对应工作流实例 */
function onJump(node: DepNode) {
  emit('update:modelValue', false)
  emit('jump', node)
}

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

async function doRerun() {
  if (!props.instanceId && !checked.value.has(currentKey.value)) {
    ElMessage.warning('缺少当前实例')
    return
  }
  const nodes: CascadeNode[] = []
  if (checked.value.has(currentKey.value)) {
    nodes.push({ projectName: props.projectName, processId: props.processId, processName: props.processName, instanceId: props.instanceId })
  }
  for (const n of collectDownstream(tree.value?.downstream)) {
    if (checked.value.has(String(n.processId))) {
      nodes.push({ projectName: n.projectName, processId: n.processId, processName: n.processName, instanceId: n.instance?.instanceId })
    }
  }
  if (!nodes.length) {
    ElMessage.warning('未勾选可重跑节点')
    return
  }
  try {
    const results = await rerunCascade(nodes)
    // 结果与 nodes 顺序一一对应,合并项目名标记(项目-工作流)
    rerunResult.value = results.map((r, i) => ({
      ok: r.ok,
      msg: r.msg,
      projectName: nodes[i]?.projectName || '',
      processName: r.name || nodes[i]?.processName || '',
      instanceId: r.instanceId,
      newInstance: r.newInstance
    }))
    rerunResultVisible.value = true
    const ok = results.filter((r) => r.ok).length
    const fail = results.length - ok
    if (fail) ElMessage.warning(`${fail} 个工作流执行失败,详见结果列表`)
  } catch (e) {
    ElMessage.error(`重跑失败:${e instanceof Error ? e.message : e}`)
  }
}

onMounted(() => {
  if (props.modelValue) load()
})

onBeforeUnmount(() => {
  ;(graph as any)?.__ro?.disconnect()
  graph?.destroy()
  graph = null
})
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="工作流依赖与级联重跑"
    width="94vw"
    top="4vh"
    @update:model-value="emit('update:modelValue', $event)"
    @open="load"
  >
    <div v-loading="loading" class="deps-body">
      <div v-if="error" class="deps-error">{{ error }}</div>
      <template v-if="tree">
        <!-- 上游(左):保留 DepBranch 简单展示 -->
        <div v-if="tree.upstream?.length" class="upstream-wrap">
          <div class="dep-section-title">上游依赖(仅展示,不参与重跑)</div>
          <div class="mindmap-up">
            <DepBranch
              :nodes="tree.upstream"
              direction="left"
              :current-key="currentKey"
              :checked="checked"
              @toggle="toggle"
              @jump="onJump"
            />
          </div>
        </div>
        <!-- 下游(右):G6 树(当前为根,默认全选重跑) -->
        <div class="dep-section-title">下游依赖(点击卡片折叠/展开,双击跳转,点「重跑」勾选)</div>
        <div ref="g6El" class="g6-canvas"></div>
        <div v-if="!tree.upstream?.length && !tree.downstream?.length" class="dep-empty">该工作流无上下游依赖</div>
      </template>
      <div v-else-if="!loading" class="dep-empty">暂无依赖数据(联系运维在服务器执行全量刷新)</div>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button v-if="instanceId" type="primary" :disabled="!checked.size" @click="doRerun">
        级联重跑({{ checked.size }})
      </el-button>
    </template>
  </el-dialog>

  <!-- 级联重跑结果弹窗:列出每个被执行的工作流(项目-工作流) -->
  <el-dialog v-model="rerunResultVisible" title="级联重跑结果" width="680px">
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
</template>

<style scoped lang="scss">
.deps-body {
  max-height: 62vh;
  overflow: auto;
}

/* 上游横向分支(左) */
.upstream-wrap {
  margin-bottom: 8px;
}

.mindmap-up {
  display: flex;
  align-items: center;
  min-width: max-content;
  padding: 4px;
  overflow-x: auto;
}

.dep-section-title {
  font-size: 12px;
  font-weight: 600;
  color: $muted;
  margin: 4px 0;
}

/* G6 画布 */
.g6-canvas {
  width: 100%;
  height: 48vh;
  min-height: 320px;
  border: 1px solid $border;
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
}

.deps-error {
  color: #f56c6c;
  padding: 8px;
}

.dep-empty {
  color: $muted;
  font-size: 12px;
  padding: 8px;
}
</style>
