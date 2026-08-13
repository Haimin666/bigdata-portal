<template>
  <div class="dleap">
    <!-- 顶部工具条 -->
    <div class="dleap-toolbar">
      <span class="dleap-title">DataLeap 实验 · 文件化数据开发(一个文件 = 一个节点)</span>
      <el-button size="small" type="primary" :icon="Plus" @click="onCreate">新建节点</el-button>
      <el-button size="small" :icon="Refresh" @click="reload">刷新</el-button>
      <el-button size="small" :icon="FolderOpened" @click="openIngest">数据接入</el-button>
      <el-divider direction="vertical" />
      <el-button size="small" :icon="Promotion" :loading="pubLoading" @click="onPublish">发布预览</el-button>
      <el-tag v-if="graph.cycles.length" type="danger" size="small">检测到 {{ graph.cycles.length }} 个依赖环</el-tag>
      <span v-else-if="graph.topoOrder.length" class="topo-hint">拓扑序:{{ topoHint }}</span>
    </div>

    <div class="dleap-main">
      <!-- 左:节点列表 -->
      <div class="dleap-side">
        <div class="side-title">节点({{ nodes.length }})</div>
        <div v-loading="loading" class="node-list">
          <template v-for="group in projectGroups" :key="group[0]">
            <div class="group-title">{{ group[0] }} ({{ group[1].length }})</div>
            <div
              v-for="n in group[1]"
              :key="n.id"
              class="node-item"
              :class="{ active: currentId === n.id }"
              @click="openNode(n.id)"
            >
              <el-icon class="node-icon" :class="n.type"><Document v-if="n.type === 'sql'" /><Cpu v-else-if="n.type === 'spark'" /><Setting v-else /></el-icon>
              <span class="node-name" :title="n.name">{{ n.name }}</span>
              <el-tag size="small" class="node-type" effect="plain">{{ n.type }}</el-tag>
              <el-icon class="del-icon" title="删除" @click.stop="onDelete(n.id)"><Delete /></el-icon>
            </div>
          </template>
          <div v-if="!nodes.length && !loading" class="side-empty">暂无节点,点「新建节点」开始</div>
        </div>
      </div>

      <!-- 中:编辑区 -->
      <div class="dleap-edit">
        <template v-if="current">
          <div class="edit-row">
            <el-input v-model="form.name" size="small" placeholder="节点名称(文件名)" class="name-input" />
            <el-select v-model="form.type" size="small" class="type-select">
              <el-option label="SQL" value="sql" />
              <el-option label="Shell" value="shell" />
              <el-option label="Spark" value="spark" />
            </el-select>
            <el-input v-model="form.cron" size="small" placeholder="调度 cron(可选)" class="cron-input" />
            <el-button size="small" type="primary" :loading="saving" @click="onSave">保存</el-button>
          </div>
          <div class="edit-row">
            <span class="label">数据源</span>
            <el-select v-model="form.db" size="small" filterable clearable placeholder="选择数据源(试跑用)" class="db-select">
              <el-option
                v-for="d in datasources.filter((x) => x.type === 'mysql' || x.type === 'oracle')"
                :key="d.name"
                :label="`${d.label || d.name}${d.label && d.label !== d.name ? ' (' + d.name + ')' : ''}`"
                :value="d.name"
              />
            </el-select>
            <el-button
              size="small"
              type="success"
              :icon="VideoPlay"
              :loading="runLoading"
              :disabled="form.type !== 'sql' && form.type !== 'shell'"
              @click="onRun"
            >试跑</el-button>
          </div>
          <div class="edit-row">
            <span class="label">上游依赖(血缘:依赖的节点先执行)</span>
            <el-select
              v-model="form.deps"
              size="small"
              multiple
              filterable
              collapse-tags
              placeholder="选择上游节点"
              class="deps-select"
            >
              <el-option v-for="n in depCandidates" :key="n.id" :label="n.name" :value="n.id" />
            </el-select>
            <el-button size="small" :disabled="!depsChanged" @click="onSaveDeps">保存依赖</el-button>
          </div>
          <div class="edit-row">
            <span class="label">内容</span>
          </div>
          <el-input
            v-model="form.content"
            type="textarea"
            class="content-area"
            :placeholder="contentPlaceholder"
          />
          <!-- 试跑结果 -->
          <div v-if="runResult || runError" class="run-result">
            <el-alert v-if="runError" type="error" :title="runError" show-icon :closable="false" />
            <template v-else-if="runResult && runResult.kind === 'shell'">
              <div class="run-meta">
                退出码: <el-tag size="small" :type="runResult.exitCode === 0 ? 'success' : 'danger'">{{ runResult.exitCode }}</el-tag>
                · {{ runResult.costMs }}ms
                <template v-if="runResult.timedOut"><el-tag size="small" type="warning">执行超时(30s)</el-tag></template>
              </div>
              <pre class="shell-out" v-if="runResult.stdout">{{ runResult.stdout }}</pre>
              <pre class="shell-err" v-if="runResult.stderr">{{ runResult.stderr }}</pre>
              <div v-if="!runResult.stdout && !runResult.stderr" class="run-meta">(无输出)</div>
            </template>
            <template v-else-if="runResult">
              <div class="run-meta">{{ runResult.rows.length }} 行 · {{ runResult.costMs }}ms<template v-if="runResult.truncated">(已截断)</template></div>
              <el-table :data="runResult.rows" border size="small" max-height="260" class="run-table">
                <el-table-column type="index" label="#" width="50" align="center" />
                <el-table-column
                  v-for="c in runResult.columns"
                  :key="c"
                  :prop="c"
                  :label="c"
                  min-width="120"
                  show-overflow-tooltip
                >
                  <template #default="{ row }">
                    <span :title="`${row[c]}`">{{ row[c] == null ? 'NULL' : row[c] }}</span>
                  </template>
                </el-table-column>
              </el-table>
            </template>
          </div>
        </template>
        <div v-else class="edit-empty">← 选择左侧节点编辑,或新建节点</div>
      </div>

      <!-- 右:血缘 DAG -->
      <div class="dleap-graph">
        <div class="side-title">血缘 DAG(依赖 → 被依赖)</div>
        <div ref="g6El" class="g6-canvas"></div>
      </div>
    </div>

    <!-- 数据接入:选库/表生成 SQL 节点 -->
    <el-dialog v-model="showIngest" title="数据接入(选表生成 SQL 节点)" width="560px">
      <div class="ingest-row">
        <span class="label">数据源</span>
        <el-select v-model="ingestDb" size="small" filterable placeholder="选择数据源" class="ingest-db" @change="loadIngestTables">
          <el-option
            v-for="d in datasources.filter((x) => x.type === 'mysql' || x.type === 'oracle')"
            :key="d.name"
            :label="`${d.label || d.name}${d.label && d.label !== d.name ? ' (' + d.name + ')' : ''}`"
            :value="d.name"
          />
        </el-select>
      </div>
      <div v-loading="ingestLoading" class="ingest-tables">
        <el-input v-model="ingestFilter" size="small" placeholder="过滤表名…" clearable class="ingest-filter" />
        <div class="ingest-list">
          <div
            v-for="t in filteredIngestTables"
            :key="t"
            class="ingest-item"
            @click="onPickTable(t)"
          >
            <el-icon><Grid /></el-icon>
            <span>{{ t }}</span>
            <el-icon class="ingest-plus"><Plus /></el-icon>
          </div>
          <div v-if="!ingestLoading && !filteredIngestTables.length" class="side-empty">选择数据源后展示表列表,点击表生成 SQL 节点</div>
        </div>
      </div>
    </el-dialog>

    <!-- 发布预览结果 -->
    <el-dialog v-model="pubVisible" title="发布预览(序列化,mock 不触发真实操作)" width="720px">
      <el-alert v-if="pubMsg" type="success" :title="pubMsg" show-icon :closable="false" style="margin-bottom: 10px" />
      <pre class="pub-json">{{ pubJson }}</pre>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Promotion, Document, Cpu, Setting, Delete, VideoPlay, FolderOpened, Grid } from '@element-plus/icons-vue'
import { queryDb, listDataSources, listTables, type DbDataSource } from '@/api/db'
import G6 from '@antv/g6'
import {
  listNodes,
  getNode,
  createNode,
  updateNode,
  deleteNode,
  setNodeDeps,
  fetchGraph,
  publishPreview,
  runShell,
  type DleapNode,
  type DleapNodeDetail,
  type DleapNodeType,
  type DleapGraph
} from '@/api/dataleap'

defineOptions({ name: 'DataLeapView' })

// ── 状态 ───────────────────────────────────────────────────
const nodes = ref<DleapNode[]>([])
const graph = ref<DleapGraph>({ nodes: [], edges: [], topoOrder: [], cycles: [] })
const loading = ref(false)
const saving = ref(false)
const pubLoading = ref(false)
const currentId = ref('')
const current = ref<DleapNodeDetail | null>(null)
const form = ref<{ name: string; type: DleapNodeType; project: string; cron: string; content: string; deps: string[]; db: string }>({
  name: '',
  type: 'sql',
  project: '实验项目',
  cron: '',
  content: '',
  deps: [],
  db: ''
})
const pubVisible = ref(false)
const pubMsg = ref('')
const pubJson = ref('')
const datasources = ref<DbDataSource[]>([])
type RunResult =
  | { kind: 'sql'; columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean }
  | { kind: 'shell'; stdout: string; stderr: string; exitCode: number; timedOut: boolean; costMs: number }
const runResult = ref<RunResult | null>(null)
const runLoading = ref(false)
const runError = ref('')
const showIngest = ref(false)
const ingestDb = ref('')
const ingestTables = ref<string[]>([])
const ingestLoading = ref(false)
const ingestFilter = ref('')
const filteredIngestTables = computed(() => {
  const kw = ingestFilter.value.trim().toLowerCase()
  return kw ? ingestTables.value.filter((t) => t.toLowerCase().includes(kw)) : ingestTables.value
})
const g6El = ref<HTMLDivElement>()
let graphInst: any | null = null

const sortedNodes = computed(() => [...nodes.value].sort((a, b) => a.name.localeCompare(b.name)))
const depCandidates = computed(() => sortedNodes.value.filter((n) => n.id !== currentId.value))
const depsChanged = computed(() => {
  if (!current.value) return false
  const a = [...(form.value.deps || [])].sort()
  const b = [...(current.value.deps || [])].sort()
  return a.join(',') !== b.join(',')
})
const topoHint = computed(() => {
  const m = new Map(nodes.value.map((n) => [n.id, n.name]))
  return graph.value.topoOrder.slice(0, 8).map((id) => m.get(id) || id).join(' → ') + (graph.value.topoOrder.length > 8 ? ' …' : '')
})
const contentPlaceholder = computed(() =>
  form.value.type === 'sql' ? '-- SQL 内容\nSELECT ...' : form.value.type === 'spark' ? '// Spark 脚本\nspark.sql("...")' : '#!/bin/bash\n...'
)

// ── 数据加载 ──────────────────────────────────────────────
async function reload() {
  loading.value = true
  try {
    const d = await listNodes()
    nodes.value = d.nodes || []
    const g = await fetchGraph()
    graph.value = g
    await nextTick()
    renderGraph()
    if (currentId.value) {
      const still = nodes.value.find((n) => n.id === currentId.value)
      if (still) await openNode(currentId.value)
      else currentId.value = ''
    }
  } catch (e) {
    ElMessage.error(`加载失败:${e instanceof Error ? e.message : e}`)
  } finally {
    loading.value = false
  }
}

async function openNode(id: string) {
  currentId.value = id
  try {
    const { node } = await getNode(id)
    current.value = node
    form.value = {
      name: node.name,
      type: node.type,
      project: node.project || '实验项目',
      cron: node.cron || '',
      content: node.content || '',
      deps: [...(node.deps || [])],
      db: node.db || ''
    }
    runResult.value = null
    runError.value = ''
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  }
}

async function onCreate() {
  try {
    const { value } = await ElMessageBox.prompt('节点名称', '新建节点', {
      inputValue: 'new_task.sql',
      inputValidator: (v) => (v?.trim() ? true : '名称不能为空')
    })
    const { node } = await createNode({
      name: (value || '').trim(),
      type: 'sql',
      project: '实验项目'
    })
    nodes.value.push(node)
    await openNode(node.id)
    await reload()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(`新建失败:${e instanceof Error ? e.message : e}`)
  }
}

async function onSave() {
  if (!current.value) return
  if (!form.value.name.trim()) return ElMessage.warning('名称不能为空')
  saving.value = true
  try {
    const { node } = await updateNode(current.value.id, {
      name: form.value.name.trim(),
      type: form.value.type,
      cron: form.value.cron.trim(),
      content: form.value.content,
      db: form.value.db
    })
    Object.assign(current.value, node)
    const idx = nodes.value.findIndex((n) => n.id === node.id)
    if (idx >= 0) nodes.value[idx] = node
    ElMessage.success('已保存')
    await reload()
  } catch (e) {
    ElMessage.error(`保存失败:${e instanceof Error ? e.message : e}`)
  } finally {
    saving.value = false
  }
}

async function onSaveDeps() {
  if (!current.value) return
  try {
    const { node } = await setNodeDeps(current.value.id, form.value.deps)
    current.value.deps = node.deps
    const idx = nodes.value.findIndex((n) => n.id === node.id)
    if (idx >= 0) nodes.value[idx] = { ...nodes.value[idx], deps: node.deps }
    ElMessage.success('依赖已保存')
    await reload()
  } catch (e) {
    ElMessage.error(`依赖保存失败:${e instanceof Error ? e.message : e}`)
  }
}

async function onDelete(id: string) {
  try {
    await ElMessageBox.confirm('确定删除该节点?其作为上游的引用会一并清除。', '删除节点', { type: 'warning' })
  } catch {
    return
  }
  try {
    await deleteNode(id)
    if (currentId.value === id) {
      currentId.value = ''
      current.value = null
    }
    ElMessage.success('已删除')
    await reload()
  } catch (e) {
    ElMessage.error(`删除失败:${e instanceof Error ? e.message : e}`)
  }
}

/** 试跑:SQL 经 /api/dbquery/query 只读执行;Shell 在门户服务器执行(30s 超时) */
async function onRun() {
  if (!current.value) return
  if (!form.value.content.trim()) return ElMessage.warning('内容为空')
  runLoading.value = true
  runError.value = ''
  runResult.value = null
  try {
    if (form.value.type === 'shell') {
      const r = await runShell(current.value.id)
      runResult.value = { kind: 'shell', ...r }
    } else if (form.value.type === 'sql') {
      if (!form.value.db) throw new Error('请先选择数据源')
      const r = await queryDb(form.value.db, form.value.content)
      runResult.value = { kind: 'sql', ...r }
    } else {
      throw new Error('Spark 节点执行开发中,暂支持 SQL/Shell')
    }
  } catch (e) {
    runError.value = e instanceof Error ? e.message : String(e)
  } finally {
    runLoading.value = false
  }
}

// 节点按项目分组
const projectGroups = computed(() => {
  const m = new Map<string, DleapNode[]>()
  for (const n of sortedNodes.value) {
    const p = n.project || '未分组'
    if (!m.has(p)) m.set(p, [])
    m.get(p)!.push(n)
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})

/** 数据接入:选库/表 → 自动生成 SQL 查询节点 */
async function openIngest() {
  showIngest.value = true
  ingestDb.value = ''
  ingestTables.value = []
}
async function loadIngestTables() {
  if (!ingestDb.value) return
  ingestLoading.value = true
  try {
    ingestTables.value = await listTables(ingestDb.value)
  } catch (e) {
    ElMessage.error(`加载表失败:${e instanceof Error ? e.message : e}`)
  } finally {
    ingestLoading.value = false
  }
}
async function onPickTable(t: string) {
  try {
    const { node } = await createNode({
      name: `${t}.sql`,
      type: 'sql',
      db: ingestDb.value,
      content: `SELECT * FROM ${t}`
    })
    nodes.value.push(node)
    ElMessage.success(`已生成节点: ${t}.sql`)
    showIngest.value = false
    await openNode(node.id)
    await reload()
  } catch (e) {
    ElMessage.error(`生成失败:${e instanceof Error ? e.message : e}`)
  }
}

async function onPublish() {
  pubLoading.value = true
  try {
    const d = await publishPreview()
    pubMsg.value = d.message
    pubJson.value = JSON.stringify(d.workflow, null, 2)
    pubVisible.value = true
  } catch (e) {
    ElMessage.error(`发布预览失败:${e instanceof Error ? e.message : e}`)
  } finally {
    pubLoading.value = false
  }
}

// ── G6 血缘图 ─────────────────────────────────────────────
function cv(name: string, fb: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb
}
const C = {
  primary: () => cv('--bd-primary', '#00849c'),
  text: () => cv('--bd-text', '#1c2b36'),
  muted: () => cv('--bd-muted', '#5d7a8c'),
  panel: () => cv('--bd-panel', '#fff'),
  border: () => cv('--bd-border', '#c9cdd6')
}
function typeColor(t?: string): string {
  const s = String(t || '').toUpperCase()
  if (s === 'SPARK') return C.primary()
  if (s === 'SHELL') return '#67c23a'
  return '#e6a23c' // sql
}

function registerNodeCard() {
  const name = 'dleap-node'
  if ((G6 as any).getRegisteredNode && (G6 as any).getRegisteredNode()[name]) return
  G6.registerNode(
    name,
    {
      draw(cfg: any, group: any) {
        const W = 150
        const H = 40
        const sel = cfg.__selected
        const key = group.addShape('rect', {
          attrs: {
            x: -W / 2,
            y: -H / 2,
            width: W,
            height: H,
            radius: 6,
            fill: C.panel(),
            stroke: sel ? C.primary() : typeColor(cfg.nodeType),
            lineWidth: sel ? 2.5 : 1.5,
            shadowColor: 'rgba(0,0,0,0.06)',
            shadowBlur: sel ? 8 : 3,
            cursor: 'pointer'
          }
        })
        group.addShape('circle', { attrs: { x: -W / 2 + 12, y: 0, r: 4, fill: typeColor(cfg.nodeType) } })
        const label = String(cfg.label || '')
        const short = label.length > 16 ? label.slice(0, 15) + '…' : label
        group.addShape('text', {
          attrs: { x: -W / 2 + 24, y: 0, text: short, fontSize: 12, fill: C.text(), textAlign: 'left', textBaseline: 'middle' }
        })
        return key
      }
    },
    'single-node'
  )
}

function renderGraph() {
  if (!g6El.value) return
  graphInst?.destroy()
  registerNodeCard()
  const nodesData = graph.value.nodes.map((n) => ({
    id: n.id,
    label: n.name,
    nodeType: n.type,
    __selected: n.id === currentId.value
  }))
  const edgesData = graph.value.edges.map((e) => ({ source: e.source, target: e.target }))
  const hasCycle = graph.value.cycles.length > 0
  graphInst = new G6.Graph({
    container: g6El.value,
    width: g6El.value.clientWidth || 360,
    height: g6El.value.clientHeight || 520,
    fitView: true,
    modes: { default: ['drag-canvas', 'zoom-canvas', 'drag-node'] },
    layout: hasCycle
      ? { type: 'force', preventOverlap: true, nodeSize: 60, linkDistance: 130 }
      : { type: 'dagre', rankdir: 'TB', nodesep: 20, ranksep: 70 },
    defaultEdge: {
      type: 'cubic-vertical',
      style: { stroke: C.border(), lineWidth: 1.5, endArrow: { path: G6.Arrow.triangle(4, 6, 0), d: 0 } }
    }
  })
  graphInst.node((n: any) => ({ type: 'dleap-node', size: [150, 40], label: n.label, nodeType: n.nodeType, __selected: n.__selected }))
  graphInst.data({ nodes: nodesData, edges: edgesData })
  graphInst.render()
  graphInst.fitView(30, true, false)
  graphInst.on('node:click', (evt: any) => {
    const m = evt.item.getModel()
    if (m.id !== currentId.value) void openNode(m.id)
  })
  const ro = new ResizeObserver(() => {
    if (g6El.value) graphInst?.changeSize(g6El.value.clientWidth, g6El.value.clientHeight)
  })
  ro.observe(g6El.value)
  ;(graphInst as any).__ro = ro
}

// 切换选中节点后重渲染高亮
watch(currentId, async () => {
  await nextTick()
  renderGraph()
})

onMounted(async () => {
  void reload()
  try {
    datasources.value = await listDataSources()
  } catch {
    /* 数据源列表不可用不影响节点管理 */
  }
})

onBeforeUnmount(() => {
  ;(graphInst as any)?.__ro?.disconnect()
  graphInst?.destroy()
  graphInst = null
})
</script>

<style scoped lang="scss">
.dleap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 8px;
  gap: 8px;
  background: var(--bd-bg, #eef3f8);
}

.dleap-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bd-panel, #fff);
  border: 1px solid var(--bd-border, #c9cdd6);
  border-radius: 8px;
  flex-shrink: 0;

  .dleap-title {
    font-size: 13px;
    font-weight: 600;
  }

  .topo-hint {
    font-size: 12px;
    color: var(--bd-muted, #888);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.dleap-main {
  display: flex;
  gap: 8px;
  flex: 1;
  min-height: 0;
}

.dleap-side,
.dleap-graph {
  display: flex;
  flex-direction: column;
  width: 240px;
  flex-shrink: 0;
  background: var(--bd-panel, #fff);
  border: 1px solid var(--bd-border, #c9cdd6);
  border-radius: 8px;
  overflow: hidden;

  .side-title {
    padding: 8px 10px;
    font-size: 12px;
    font-weight: 600;
    color: var(--bd-muted, #888);
    border-bottom: 1px solid var(--bd-border, #c9cdd6);
    flex-shrink: 0;
  }
}

.dleap-graph {
  width: 340px;

  .g6-canvas {
    flex: 1;
    min-height: 0;
  }
}

.node-list {
  flex: 1;
  overflow: auto;
  padding: 4px;
}

.node-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;

  &:hover {
    background: var(--bd-table-hover, rgba(0, 132, 156, 0.06));
  }

  &.active {
    background: var(--bd-primary, #00849c);
    color: #fff;

    .node-type {
      color: #fff;
      border-color: rgba(255, 255, 255, 0.5);
    }
  }

  .node-icon {
    flex-shrink: 0;
  }

  .node-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .node-type {
    transform: scale(0.85);
  }

  .del-icon {
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s;

    &:hover {
      color: #f56c6c;
    }
  }

  &:hover .del-icon {
    opacity: 1;
  }
}

.group-title {
  padding: 6px 8px 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--bd-muted, #888);
}

.side-empty,
.edit-empty {
  padding: 24px 12px;
  font-size: 12px;
  color: var(--bd-muted, #888);
  text-align: center;
}

.dleap-edit {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: var(--bd-panel, #fff);
  border: 1px solid var(--bd-border, #c9cdd6);
  border-radius: 8px;

  .edit-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;

    .label {
      font-size: 12px;
      color: var(--bd-muted, #888);
      white-space: nowrap;
    }

    .name-input {
      width: 220px;
    }

    .type-select {
      width: 110px;
    }

    .cron-input {
      width: 160px;
    }

    .deps-select {
      flex: 1;
    }

    .db-select {
      width: 200px;
    }
  }

  .content-area {
    flex: 1;
    min-height: 0;

    :deep(textarea) {
      font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
      font-size: 13px;
      line-height: 1.55;
    }
  }
}

.run-result {
  flex-shrink: 0;
  border: 1px solid var(--bd-border, #c9cdd6);
  border-radius: 6px;
  overflow: hidden;
  background: var(--bd-panel, #fff);
}

.run-meta {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--bd-muted, #888);
}

.run-table {
  width: 100%;
}

.shell-out,
.shell-err {
  margin: 0;
  padding: 8px 10px;
  max-height: 240px;
  overflow: auto;
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  border-top: 1px solid var(--bd-border, #c9cdd6);
}

.shell-out {
  color: var(--bd-text, #1c2b36);
  background: var(--bd-panel, #fff);
}

.shell-err {
  color: #f56c6c;
  background: rgba(245, 108, 108, 0.06);
}

.g6-canvas {
  width: 100%;
  flex: 1;
  min-height: 0;
  background: var(--bd-panel, #fff);
}

.ingest-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;

  .label {
    font-size: 12px;
    color: var(--bd-muted, #888);
  }

  .ingest-db {
    flex: 1;
  }
}

.ingest-tables {
  border: 1px solid var(--bd-border, #c9cdd6);
  border-radius: 6px;
  overflow: hidden;

  .ingest-filter {
    border-bottom: 1px solid var(--bd-border, #c9cdd6);
  }
}

.ingest-list {
  max-height: 360px;
  overflow: auto;
  padding: 4px;
}

.ingest-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    background: var(--bd-table-hover, rgba(0, 132, 156, 0.06));

    .ingest-plus {
      opacity: 1;
    }
  }

  .ingest-plus {
    margin-left: auto;
    opacity: 0;
    color: var(--bd-primary, #00849c);
  }
}

.pub-json {
  max-height: 400px;
  overflow: auto;
  padding: 10px;
  background: var(--bd-bg, #f5f7fa);
  border: 1px solid var(--bd-border, #c9cdd6);
  border-radius: 6px;
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
