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
      <el-button size="small" type="success" :icon="Position" :loading="pubDsLoading" @click="onPublishDs">发布到 DS</el-button>
      <el-button size="small" type="danger" plain :icon="VideoPlay" :loading="runAllLoading" @click="onRunAll">按拓扑执行全部</el-button>
      <el-button size="small" :icon="Clock" @click="openRuns">执行历史</el-button>
      <el-tag v-if="graph.cycles.length" type="danger" size="small">检测到 {{ graph.cycles.length }} 个依赖环</el-tag>
      <span v-else-if="graph.topoOrder.length" class="topo-hint">拓扑序:{{ topoHint }}</span>
    </div>

    <div class="dleap-main">
      <!-- 左:节点列表 -->
      <div class="dleap-side">
        <div class="side-title">节点({{ nodes.length }})</div>
        <div v-loading="loading" class="node-list">
          <el-input
            v-model="searchText"
            size="small"
            placeholder="搜索文件…"
            clearable
            class="tree-search"
          >
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <el-tree
            v-if="nodes.length"
            ref="treeRef"
            :data="treeData"
            node-key="id"
            default-expand-all
            highlight-current
            :props="{ label: 'name', children: 'children', isLeaf: (d: TreeItem) => !d.dir }"
            :current-node-key="currentId"
            :filter-node-method="treeFilter"
            class="dleap-tree"
            @node-click="onTreeNodeClick"
          >
            <template #default="{ data }">
              <div class="tree-node">
                <el-icon :class="data.dir ? '' : data.node?.type">
                  <Folder v-if="data.dir" /><Document v-else-if="data.node?.type === 'sql'" /><Cpu v-else-if="data.node?.type === 'spark'" /><Setting v-else />
                </el-icon>
                <span class="node-name" :title="data.name">{{ data.name }}</span>
                <el-tag v-if="!data.dir" size="small" class="node-type" effect="plain">{{ data.node?.type }}</el-tag>
                <el-icon v-if="!data.dir" class="del-icon" title="删除" @click.stop="onDelete(data.id)"><Delete /></el-icon>
              </div>
            </template>
          </el-tree>
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
            <el-input v-model="form.dir" size="small" placeholder="目录(可选)" class="dir-input" />
            <CronSetter v-model="form.cron" class="cron-setter-w" />
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
              :disabled="form.type !== 'sql' && form.type !== 'shell' && form.type !== 'spark'"
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

    <!-- 新建节点(名称/类型/目录) -->
    <el-dialog v-model="showCreate" title="新建节点" width="420px">
      <div class="create-row">
        <span class="label">名称</span>
        <el-input v-model="createForm.name" size="small" placeholder="如 ods_xxx.sql" @keyup.enter="submitCreate" />
      </div>
      <div class="create-row">
        <span class="label">类型</span>
        <el-radio-group v-model="createForm.type" size="small">
          <el-radio-button value="sql">SQL</el-radio-button>
          <el-radio-button value="shell">Shell</el-radio-button>
          <el-radio-button value="spark">Spark</el-radio-button>
        </el-radio-group>
      </div>
      <div class="create-row">
        <span class="label">目录</span>
        <el-input v-model="createForm.dir" size="small" placeholder="如 ods/etl,留空=根目录" />
      </div>
      <template #footer>
        <el-button size="small" @click="showCreate = false">取消</el-button>
        <el-button size="small" type="primary" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

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

    <!-- 按拓扑执行结果 -->
    <el-dialog v-model="runAllVisible" title="执行结果(按依赖拓扑串行)" width="720px">
      <el-table :data="runAllResult" border size="small" max-height="420">
        <el-table-column type="index" label="#" width="45" align="center" />
        <el-table-column label="节点" prop="name" min-width="140" show-overflow-tooltip />
        <el-table-column label="类型" width="80" align="center">
          <template #default="{ row }"><el-tag size="small" effect="plain">{{ row.type }}</el-tag></template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.ok ? 'success' : 'danger'">{{ row.ok ? '成功' : '失败' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="输出/行数" min-width="140">
          <template #default="{ row }">
            <span v-if="row.rows != null">{{ row.rows }} 行</span>
            <span v-else-if="row.stdout" class="cell-out">{{ row.stdout.slice(0, 120) }}</span>
            <span v-else-if="row.stderr" class="cell-err">{{ row.stderr.slice(0, 120) }}</span>
            <span v-else-if="row.error" class="cell-err">{{ row.error.slice(0, 120) }}</span>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="耗时" width="80" align="right">
          <template #default="{ row }"><span v-if="row.costMs != null">{{ row.costMs }}ms</span></template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <!-- 任务执行历史(实例运维) -->
    <el-dialog v-model="runsVisible" title="任务执行历史(实例运维)" width="860px" top="5vh">
      <div class="run-filter">
        <el-select v-model="runFilter.trigger" size="small" placeholder="触发方式" clearable style="width:110px" @change="loadRuns">
          <el-option label="全部" value="" />
          <el-option label="单节点" value="single" />
          <el-option label="按拓扑" value="topo" />
          <el-option label="定时(cron)" value="cron" />
          <el-option label="失败重跑" value="rerun" />
        </el-select>
        <el-select v-model="runFilter.status" size="small" placeholder="状态" clearable style="width:100px" @change="loadRuns">
          <el-option label="全部" value="" />
          <el-option label="成功" value="ok" />
          <el-option label="失败" value="fail" />
        </el-select>
        <el-input v-model="runFilter.keyword" size="small" placeholder="节点名搜索…" clearable style="width:180px" @keyup.enter="loadRuns" @clear="loadRuns" />
        <el-button size="small" @click="loadRuns">查询</el-button>
        <el-button size="small" text @click="resetRunFilter">重置</el-button>
      </div>
      <div v-loading="runsLoading">
        <el-table v-if="runRecords.length" :data="runRecords" border size="small" max-height="52vh">
          <el-table-column type="expand">
            <template #default="{ row }">
              <el-table :data="row.results || []" border size="small">
                <el-table-column prop="name" label="节点" min-width="150" show-overflow-tooltip />
                <el-table-column prop="type" label="类型" width="70" align="center" />
                <el-table-column label="状态" width="70" align="center">
                  <template #default="{ r }"><el-tag size="small" :type="r.ok ? 'success' : 'danger'">{{ r.ok ? '成功' : '失败' }}</el-tag></template>
                </el-table-column>
                <el-table-column label="输出/日志" min-width="220">
                  <template #default="{ r }">
                    <span v-if="r.stdout" class="cell-out">{{ r.stdout.slice(0, 120) }}</span>
                    <span v-else-if="r.stderr || r.error" class="cell-err">{{ (r.stderr || r.error || '').slice(0, 120) }}</span>
                    <span v-else-if="r.rows != null">{{ r.rows }} 行</span>
                    <span v-else>—</span>
                  </template>
                </el-table-column>
                <el-table-column label="耗时" width="70" align="right">
                  <template #default="{ r }"><span v-if="r.costMs != null">{{ r.costMs }}ms</span></template>
                </el-table-column>
              </el-table>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="80" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="row.ok ? 'success' : 'danger'" effect="plain">{{ row.ok ? '成功' : '失败' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="触发" width="90" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.trigger === 'topo' ? '按拓扑' : row.trigger === 'cron' ? '定时' : row.trigger === 'rerun' ? '失败重跑' : '单节点' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="nodeName" label="节点/批次" min-width="140" show-overflow-tooltip />
          <el-table-column prop="summary" label="摘要" min-width="120" show-overflow-tooltip />
          <el-table-column label="时间" width="150">
            <template #default="{ row }"><span class="run-ts">{{ fmtTs(row.ts) }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="90" align="center">
            <template #default="{ row }">
              <el-button
                v-if="hasFailed(row)"
                size="small"
                text
                type="danger"
                :loading="rerunningId === row.id"
                @click="onRerunRun(row)"
              >重跑失败</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-else-if="!runsLoading" class="side-empty">暂无执行记录(调整筛选条件)</div>
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
import { useResizeObserver } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Promotion, Document, Cpu, Setting, Delete, VideoPlay, FolderOpened, Grid, Clock, Search, Position } from '@element-plus/icons-vue'
import { queryDb, listDataSources, listTables, querySpark, type DbDataSource } from '@/api/db'
import CronSetter from './components/CronSetter.vue'
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
  runAll,
  fetchRuns,
  rerunRun,
  publishDs,
  type RunAllItem,
  type RunRecord,
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
const pubDsLoading = ref(false)
const currentId = ref('')
const current = ref<DleapNodeDetail | null>(null)
const form = ref<{ name: string; type: DleapNodeType; project: string; cron: string; content: string; deps: string[]; db: string; dir: string }>({
  name: '',
  type: 'sql',
  project: '实验项目',
  cron: '',
  content: '',
  deps: [],
  db: '',
  dir: ''
})
const pubVisible = ref(false)
const pubMsg = ref('')
const pubJson = ref('')
const runAllVisible = ref(false)
const runAllLoading = ref(false)
const runAllResult = ref<RunAllItem[]>([])
const runsVisible = ref(false)
const runsLoading = ref(false)
const runRecords = ref<RunRecord[]>([])
const runFilter = ref({ trigger: '', status: '', keyword: '' })
const rerunningId = ref('')
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

interface TreeItem {
  id: string
  name: string
  dir: boolean
  children?: TreeItem[]
  node?: DleapNode
}

function buildTree(items: DleapNode[]): TreeItem[] {
  const root: TreeItem[] = []
  const dirMap = new Map<string, TreeItem>()
  const ensureDir = (path: string): TreeItem => {
    const hit = dirMap.get(path)
    if (hit) return hit
    const parts = path.split('/')
    const name = parts[parts.length - 1]
    const parentPath = parts.slice(0, -1).join('/')
    const item: TreeItem = { id: `dir:${path}`, name, dir: true, children: [] }
    dirMap.set(path, item)
    if (parentPath) ensureDir(parentPath).children!.push(item)
    else root.push(item)
    return item
  }
  for (const n of items) if (n.dir) ensureDir(n.dir)
  for (const n of items) {
    const file: TreeItem = { id: n.id, name: n.name, dir: false, node: n }
    if (n.dir) ensureDir(n.dir).children!.push(file)
    else root.push(file)
  }
  const sort = (arr: TreeItem[]) => {
    arr.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    for (const it of arr) if (it.children) sort(it.children)
  }
  sort(root)
  return root
}

const treeData = computed(() => buildTree(nodes.value))
const treeRef = ref()
const searchText = ref('')
function treeFilter(value: string, data: TreeItem): boolean {
  if (!value) return true
  return String(data.name || '').toLowerCase().includes(value.toLowerCase())
}
watch(searchText, (v) => treeRef.value?.filter(v))
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
      db: node.db || '',
      dir: node.dir || ''
    }
    runResult.value = null
    runError.value = ''
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  }
}

function onTreeNodeClick(data: TreeItem) {
  if (!data.dir && data.node) void openNode(data.node.id)
}

const showCreate = ref(false)
const createForm = ref({ name: '', type: 'sql' as DleapNodeType, dir: '' })
async function onCreate() {
  createForm.value = { name: '', type: 'sql', dir: '' }
  showCreate.value = true
}
async function submitCreate() {
  if (!createForm.value.name.trim()) return ElMessage.warning('名称不能为空')
  try {
    const { node } = await createNode({
      name: createForm.value.name.trim(),
      type: createForm.value.type,
      project: '实验项目',
      dir: createForm.value.dir.trim()
    })
    nodes.value.push(node)
    showCreate.value = false
    await openNode(node.id)
    await reload()
  } catch (e) {
    ElMessage.error(`新建失败:${e instanceof Error ? e.message : e}`)
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
      db: form.value.db,
      dir: form.value.dir
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
    } else if (form.value.type === 'spark') {
      // Spark 节点:经门户 /api/spark/query 执行 SQL(只读 SELECT 无需解锁;写操作需解锁走现有交互)
      const r = await querySpark(form.value.content)
      runResult.value = { kind: 'sql', ...r }
    } else {
      throw new Error('未知节点类型')
    }
  } catch (e) {
    runError.value = e instanceof Error ? e.message : String(e)
  } finally {
    runLoading.value = false
  }
}

async function openIngest() {
  showIngest.value = true
  ingestDb.value = ''
  ingestTables.value = []
}
async function loadIngestTables() {
  if (!ingestDb.value) return
  ingestLoading.value = true
  try {
    ingestTables.value = (await listTables(ingestDb.value)) as string[]
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

/** 按依赖拓扑执行全部节点(串行;真实执行,由用户触发) */
async function onRunAll() {
  if (!nodes.value.length) return ElMessage.warning('暂无节点')
  try {
    await ElMessageBox.confirm('将按依赖拓扑顺序串行执行全部节点(SQL/Spark 只读查询,Shell 本地运行)。确认执行?', '按拓扑执行全部', { type: 'warning' })
  } catch {
    return
  }
  runAllLoading.value = true
  try {
    const d = await runAll()
    runAllResult.value = d.results || []
    ElMessage.success(d.message || '执行完成')
    runAllVisible.value = true
  } catch (e) {
    ElMessage.error(`执行失败:${e instanceof Error ? e.message : e}`)
  } finally {
    runAllLoading.value = false
  }
}

/** 打开执行历史(实例运维) */
async function openRuns() {
  runsVisible.value = true
  await loadRuns()
}
async function loadRuns() {
  runsLoading.value = true
  try {
    const d = await fetchRuns({
      limit: 100,
      trigger: runFilter.value.trigger || undefined,
      status: runFilter.value.status || undefined,
      keyword: runFilter.value.keyword || undefined
    })
    runRecords.value = d.runs || []
  } catch (e) {
    ElMessage.error(`加载历史失败:${e instanceof Error ? e.message : e}`)
  } finally {
    runsLoading.value = false
  }
}
function hasFailed(r: RunRecord): boolean {
  return (r.results || []).some((x: RunAllItem) => !x.ok)
}
function resetRunFilter() {
  runFilter.value = { trigger: '', status: '', keyword: '' }
  void loadRuns()
}
/** 重跑实例的失败节点 */
async function onRerunRun(r: RunRecord) {
  if (!(r.results || []).some((x: RunAllItem) => !x.ok)) return
  try {
    await ElMessageBox.confirm(`重跑该实例的 ${r.results.filter((x) => !x.ok).length} 个失败节点?`, '重跑失败节点', { type: 'warning' })
  } catch {
    return
  }
  rerunningId.value = r.id
  try {
    const d = await rerunRun(r.id)
    ElMessage.success(d.message || '重跑完成')
    await loadRuns()
  } catch (e) {
    ElMessage.error(`重跑失败:${e instanceof Error ? e.message : e}`)
  } finally {
    rerunningId.value = ''
  }
}

function fmtTs(ts: string): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return ts
  }
}

/** 发布到 DS:统一创建到 whm-test 测试项目,不污染原始项目 */
async function onPublishDs() {
  if (!nodes.value.length) return ElMessage.warning('暂无节点')
  try {
    await ElMessageBox.confirm(
      `将把 ${nodes.value.length} 个节点作为一个工作流创建到 DS 测试项目「whm-test」(不会动其他项目)。确认发布?`,
      '发布到 DS',
      { type: 'warning', confirmButtonText: '发布', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  pubDsLoading.value = true
  try {
    const d = await publishDs()
    ElMessage.success(d.message || '发布成功')
    pubMsg.value = d.message || ''
    pubJson.value = JSON.stringify({ project: d.project, workflowName: d.workflowName, dsData: d.dsData }, null, 2)
    pubVisible.value = true
  } catch (e) {
    ElMessage.error(`发布失败:${e instanceof Error ? e.message : e}`)
  } finally {
    pubDsLoading.value = false
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
        const W = 168
        const H = 52
        const sel = cfg.__selected
        const hover = cfg.__hover
        const border = sel ? C.primary() : hover ? C.primary() : typeColor(cfg.nodeType)
        const key = group.addShape('rect', {
          attrs: {
            x: -W / 2,
            y: -H / 2,
            width: W,
            height: H,
            radius: 8,
            fill: C.panel(),
            stroke: border,
            lineWidth: sel ? 2.5 : hover ? 2 : 1.5,
            shadowColor: 'rgba(0,0,0,0.08)',
            shadowBlur: sel || hover ? 10 : 3,
            cursor: 'pointer'
          }
        })
        group.addShape('circle', { attrs: { x: -W / 2 + 11, y: -14, r: 4, fill: typeColor(cfg.nodeType) } })
        const label = String(cfg.label || '')
        const short = label.length > 16 ? label.slice(0, 15) + '…' : label
        group.addShape('text', {
          attrs: { x: -W / 2 + 22, y: -14, text: short, fontSize: 12, fill: C.text(), textAlign: 'left', textBaseline: 'middle' }
        })
        // 副行:类型 · cron · 依赖数
        const subParts = [String(cfg.nodeType || '').toUpperCase()]
        if (cfg.cron) subParts.push('⏱')
        if (cfg.depCount != null) subParts.push(`↳${cfg.depCount}`)
        group.addShape('text', {
          attrs: {
            x: -W / 2 + 22,
            y: 14,
            text: subParts.join(' · '),
            fontSize: 10,
            fill: C.muted(),
            textAlign: 'left',
            textBaseline: 'middle'
          }
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
  const depCount = new Map<string, number>()
  for (const e of graph.value.edges) depCount.set(e.source, (depCount.get(e.source) || 0) + 1)
  const nodesData = graph.value.nodes.map((n) => ({
    id: n.id,
    label: n.name,
    nodeType: n.type,
    cron: n.cron,
    depCount: depCount.get(n.id) || 0,
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
  graphInst.node((n: any) => ({
    type: 'dleap-node',
    size: [168, 52],
    label: n.label,
    nodeType: n.nodeType,
    cron: n.cron,
    depCount: n.depCount,
    __selected: n.__selected
  }))
  graphInst.data({ nodes: nodesData, edges: edgesData })
  graphInst.render()
  graphInst.fitView(30, true, false)

  // 单击打开编辑;双击复制名称
  graphInst.on('node:click', (evt: any) => {
    const m = evt.item.getModel()
    if (m.id !== currentId.value) void openNode(m.id)
  })
  graphInst.on('node:dblclick', (evt: any) => {
    const m = evt.item.getModel()
    navigator.clipboard?.writeText(String(m.label || '')).catch(() => {})
    ElMessage.info(`已复制节点名: ${m.label}`)
  })
  // hover 高亮邻接上下游(边 + 节点)
  const clearHover = () => {
    graphInst.getNodes().forEach((no: any) => {
      no.getModel().__hover = false
      graphInst.refreshItem(no)
    })
    graphInst.getEdges().forEach((ed: any) => {
      ed.getModel().__hover = false
      graphInst.refreshItem(ed)
    })
  }
  graphInst.on('node:mouseenter', (evt: any) => {
    const id = evt.item.getModel().id
    clearHover()
    const related = new Set<string>([id])
    for (const e of graph.value.edges) {
      if (e.source === id) related.add(e.target)
      if (e.target === id) related.add(e.source)
    }
    graphInst.getNodes().forEach((no: any) => {
      if (related.has(no.getModel().id)) {
        no.getModel().__hover = true
        graphInst.refreshItem(no)
      }
    })
    graphInst.getEdges().forEach((ed: any) => {
      const m = ed.getModel()
      if (related.has(m.source) && related.has(m.target)) {
        m.__hover = true
        ed.getKeyShape().attr('stroke', C.primary())
        ed.getKeyShape().attr('lineWidth', 2.5)
      } else {
        ed.getKeyShape().attr('stroke', C.border())
        ed.getKeyShape().attr('lineWidth', 1.5)
      }
    })
  })
  graphInst.on('node:mouseleave', clearHover)
  useResizeObserver(g6El, () => {
    if (g6El.value) graphInst?.changeSize(g6El.value.clientWidth, g6El.value.clientHeight)
  })
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

    .dir-input {
      width: 140px;
    }

    .cron-setter-w {
      width: 340px;
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

.create-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;

  .label {
    font-size: 12px;
    color: var(--bd-muted, #888);
    width: 40px;
    flex-shrink: 0;
  }
}

.tree-search {
  margin-bottom: 4px;
}

.dleap-tree {
  background: transparent;

  :deep(.el-tree-node__content) {
    height: 28px;
    border-radius: 6px;

    &:hover {
      background: var(--bd-table-hover, rgba(0, 132, 156, 0.06));
    }
  }
}

.tree-node {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  font-size: 12px;

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

.run-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.runs-list {
  max-height: 60vh;
  overflow: auto;
}

.run-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  width: 100%;
  padding-right: 10px;

  .run-name {
    font-weight: 600;
  }

  .run-summary {
    color: var(--bd-muted, #888);
  }

  .run-ts {
    margin-left: auto;
    color: var(--bd-muted, #888);
    font-size: 11px;
  }
}

.cell-out {
  color: var(--bd-text, #1c2b36);
}

.cell-err {
  color: #f56c6c;
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
