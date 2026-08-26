<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/store/auth'
import { CaretRight, Loading, MagicStick, Sunny, Moon, DocumentChecked, Document, Plus, VideoPause, Promotion } from '@element-plus/icons-vue'
import * as monaco from 'monaco-editor'
import { useMonaco } from '@/editor/useMonaco'
import { setCompletionDb } from '@/editor/sqlCompletion'
import type { PendingEdit, QueryResultItem } from './queryTypes'
import { useDebounceFn } from '@vueuse/core'
import { listDataSources, saveScriptContent, getScriptContent, createScriptNode, queryDb, explainSql, listFields, sparkStatus, setSparkExecutors, type DbDataSource, type ScriptNode, type TableFieldDetail, type ExplainNode } from '@/api/db'
import { getTheme } from '@/utils/theme'
import SqlTreePanel from './SqlTreePanel.vue'
import ResultGrid from './components/ResultGrid.vue'
import { useSparkLogPolling } from './composables/useSparkLogPolling'
import { useRunner, setHistUser } from './composables/useRunner'
const treePanelRef = ref<InstanceType<typeof SqlTreePanel>>()
import FlinkConnectorDialog from './FlinkConnectorDialog.vue'
import FlinkPreJobDialog from './FlinkPreJobDialog.vue'
import SparkLogPanel from './components/SparkLogPanel.vue'
import ExplainDialog from './components/ExplainDialog.vue'
// Spark 日志面板:容器高度→保留行数计算在组件内,父级在轮询后调用其方法
const sparkLogPanelRef = ref<InstanceType<typeof SparkLogPanel>>()

defineOptions({ name: 'DbQueryView' })

const authStore = useAuthStore()

// ── 状态 ─────────────────────────────────────────────────────
const datasources = ref<DbDataSource[]>([])
const engine = ref<'mysql' | 'oracle' | 'sparksql' | 'pyspark' | 'flinksql' | ''>('')
const db = ref('')
// Spark executor 数量设置(0=动态分配;5/10/15/20=固定常驻),仅 sparksql 引擎显示
const sparkExecutors = ref(0)
const sparkExecutorsLoading = ref(false)
const loading = ref(false)
const error = ref('')

// ── 多文件 tab(最多 10 个)──────────────────────────────────
const MAX_TABS = 10
interface EditorTab {
  id: string
  file: ScriptNode | null // 绑定的文件;null = 未命名查询
  name: string
  content: string // 内容快照(自动保存/草稿用;编辑实时内容在 model 里)
  dirty: boolean
  /** 每文件独立 Monaco 文档模型:独立撤销历史(Cmd+Z 不串文件)+ 光标位置 */
  model?: monaco.editor.ITextModel
}
let tabSeq = 0
function newTab(name: string, content: string, id?: string): EditorTab {
  return {
    id: id || `tab-${++tabSeq}`,
    file: null,
    name,
    content,
    dirty: false
  }
}
/** 创建/复用 tab 的文档模型(语言按文件后缀;model 生命周期随 tab 关闭统一释放) */
function ensureTabModel(t: { name: string; content: string; model?: monaco.editor.ITextModel }): monaco.editor.ITextModel {
  if (!t.model || t.model.isDisposed()) {
    const lang = t.name.toLowerCase().endsWith('.py') ? 'python' : 'sql'
    t.model = monaco.editor.createModel(t.content, lang)
  }
  return t.model
}

/** 把 tab 的文档挂到编辑器(model 即 tab 文档,独立撤销历史);替代旧 setValue 整体替换方案 */
function showTabInEditor(t: EditorTab) {
  if (!ed) return
  ensureTabModel(t)
  setModel(t.model ?? null) // 程序性挂载(不标 dirty);setModel 会触发 change → 参数行自动重建
}

// ── 临时 query 草稿(未命名 tab 也自动保存到 localStorage)──────
const TEMP_KEY = 'db-query-temp-tabs'
interface TempDraft {
  id: string
  name: string
  content: string
  ts: number
}
function readTempDrafts(): TempDraft[] {
  try {
    const raw = localStorage.getItem(TEMP_KEY)
    if (!raw) return []
    const p = JSON.parse(raw)
    return Array.isArray(p) ? p.filter((d) => d && typeof d.content === 'string') : []
  } catch {
    return []
  }
}
function writeTempDrafts(list: TempDraft[]) {
  try {
    localStorage.setItem(TEMP_KEY, JSON.stringify(list.slice(0, MAX_TABS)))
  } catch {
    /* localStorage 不可用(Safari 隐私模式等)时静默忽略 */
  }
}
/** 保存/更新一个临时 tab 草稿(刷新页面后可恢复) */
function saveTempDraft(tab: EditorTab) {
  const list = readTempDrafts().filter((d) => d.id !== tab.id)
  list.unshift({ id: tab.id, name: tab.name, content: tab.content, ts: Date.now() })
  writeTempDrafts(list)
}
function removeTempDraft(id: string) {
  writeTempDrafts(readTempDrafts().filter((d) => d.id !== id))
}

/** 初始化 tab:优先恢复上次会话的临时草稿(最多 MAX_TABS 个,最近在前);没有草稿则建一个空 tab */
function initTabs() {
  const drafts = readTempDrafts()
  if (drafts.length) {
    for (const d of drafts) {
      tabs.value.push(newTab(d.name || '未命名查询', d.content, d.id))
      if (tabs.value.length >= MAX_TABS) break
    }
    activeTabId.value = tabs.value[tabs.value.length - 1].id // 激活最近一次编辑的草稿
  } else {
    tabs.value.push(newTab('未命名查询', ''))
    activeTabId.value = tabs.value[0].id
  }
}

/** 防抖自动保存:停止输入 2s 后落盘(绑定文件)或写草稿(临时 query) */
// 自动保存:2s 防抖(VueUse useDebounceFn,卸载自动取消挂起调用)
const scheduleAutoSave = useDebounceFn((tab: EditorTab) => {
  void autoSaveTab(tab)
}, 2000)
async function autoSaveTab(tab: EditorTab) {
  if (!tabs.value.includes(tab)) return // tab 已关闭
  // 仅当该 tab 仍是活跃 tab 时才读编辑器实时内容;否则用切换时已写回的快照。
  // 否则迟到的防抖定时器会把别的 tab 内容存进本 tab,覆盖磁盘上的原文件!
  if (activeTab.value === tab) tab.content = getValue()
  if (tab.file) {
    try {
      await saveScriptContent(tab.file.id, tab.content)
      tab.dirty = false
    } catch {
      // 自动保存失败静默保留 dirty;手动 Ctrl+S 仍可重试并提示
    }
  } else {
    saveTempDraft(tab)
    tab.dirty = false
  }
}
const tabs = ref<EditorTab[]>([])
const activeTabId = ref('')
const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null)
// 初始 tab(优先恢复临时草稿)
initTabs()

/** 把当前编辑器内容写回当前 tab(切换/关闭前调用) */
function flushActiveContent() {
  const t = activeTab.value
  if (t) t.content = getValue()
}

/** 切换 tab:写回当前内容 → 挂载目标文档(独立撤销历史) */
function switchTab(id: string) {
  if (id === activeTabId.value) return
  const prev = activeTab.value
  flushActiveContent()
  if (prev?.dirty) void autoSaveTab(prev) // 切走即保存,防编辑丢失/迟到定时器串内容
  activeTabId.value = id
  const next = tabs.value.find((t) => t.id === id)
  if (next) {
    showTabInEditor(next)
    if (next.file?.name.toLowerCase().endsWith('.py')) engine.value = 'pyspark'
  }
  edRef.value?.focus()
}

/** 关闭 tab:有未保存修改先确认;关闭后激活相邻 tab,全关则新建一个未命名 tab */
async function closeTab(id: string) {
  const tab = tabs.value.find((t) => t.id === id)
  if (!tab) return
  if (tab.dirty) {
    try {
      await ElMessageBox.confirm(`「${tab.name}」有未保存的修改,关闭后将丢失。确定关闭?`, '关闭确认', { type: 'warning' })
    } catch {
      return
    }
  }
  const idx = tabs.value.indexOf(tab)
  flushActiveContent()
  tabs.value.splice(idx, 1)
  if (!tab.file) removeTempDraft(tab.id) // 临时 tab 关闭即丢弃草稿
  if (activeTabId.value === id) {
    if (tabs.value.length === 0) {
      const nt = newTab('未命名查询', '')
      tabs.value.push(nt)
      activeTabId.value = nt.id
      showTabInEditor(nt)
    } else {
      const next = tabs.value[Math.min(idx, tabs.value.length - 1)]
      activeTabId.value = next.id
      showTabInEditor(next)
    }
  }
  edRef.value?.focus()
}

/** 新建查询:追加一个未命名 tab(最多 MAX_TABS 个) */
function newQuery() {
  if (tabs.value.length >= MAX_TABS) {
    ElMessage.warning(`最多同时打开 ${MAX_TABS} 个 tab`)
    return
  }
  flushActiveContent()
  const nt = newTab('未命名查询', '')
  tabs.value.push(nt)
  activeTabId.value = nt.id
  showTabInEditor(nt)
  edRef.value?.focus()
}

/** 保存当前所有临时 tab 草稿(离开页面前兜底,防抖未触发时) */
function flushTempDrafts() {
  flushActiveContent()
  for (const t of tabs.value) {
    if (!t.file) saveTempDraft(t)
  }
}

/** 打开文件:已打开则切到对应 tab;否则新开 tab(最多 MAX_TABS 个) */
async function onOpenFile(node: ScriptNode) {
  const existing = tabs.value.find((t) => t.file?.id === node.id)
  if (existing) {
    switchTab(existing.id)
    return
  }
  if (tabs.value.length >= MAX_TABS) {
    ElMessage.warning(`最多同时打开 ${MAX_TABS} 个文件,请先关闭部分 tab`)
    return
  }
  try {
    const { content } = await getScriptContent(node.id)
    flushActiveContent()
    const tab: EditorTab = {
      id: `file-${node.id}`,
      file: node,
      name: node.name,
      content,
      dirty: false,
      model: undefined // model 由 showTabInEditor→ensureTabModel 按需创建
    }
    tabs.value.push(tab)
    activeTabId.value = tab.id
    showTabInEditor(tab)
    // .py 文件自动切到 PySpark 引擎(python 编辑器)
    if (node.name.toLowerCase().endsWith('.py')) {
      engine.value = 'pyspark'
    }
    ElMessage.success(`已打开 ${node.name}`)
  } catch (e) {
    ElMessage.error(`打开失败:${e instanceof Error ? e.message : e}`)
  }
}

/** 表目录点击 → 在光标处插入表名/字段名 */
function onInsert(text: string) {
  if (!ed) return
  insertAtCursor(text) // 光标处插入,光标停文本尾并聚焦(useMonaco 封装)
}

/** 历史/收藏条目点击(SqlTreePanel runSql 事件):历史是缓存,只回填编辑器不自动执行;
 *  有结果快照时直接开一个「缓存」结果 tab 免重查展示 */
function onRunHistorySql(sql: string, result?: { columns: string[]; rows: Record<string, unknown>[] }) {
  if (!ed) return
  const s = String(sql || '')
  if (!s.trim()) return
  setValue(s) // 程序性回填:不标 dirty(历史是缓存)
  ed.focus()
  if (result && Array.isArray(result.columns) && Array.isArray(result.rows)) {
    results.value.push({
      sql: s,
      columns: [...result.columns],
      rows: result.rows,
      costMs: 0,
      truncated: false,
      running: false,
      cached: true
    } as QueryResultItem)
    if (results.value.length > MAX_RESULTS) {
      results.value.splice(0, results.value.length - MAX_RESULTS)
    }
    activePane.value = results.value.length // 切到刚推入的结果面板(pane 0 是日志)
  }
}

/** 双击表目录中的表:新开/复用预览 tab,自动执行 SELECT * 前 100 行 */
async function onOpenTable(payload: { db: string; table: string }) {
  if (tabs.value.length >= MAX_TABS) {
    ElMessage.warning(`最多同时打开 ${MAX_TABS} 个 tab,请先关闭部分 tab`)
    return
  }
  const src = datasources.value.find((d) => d.name === payload.db)
  const isOracle = src?.type === 'oracle'
  const targetEngine = isOracle ? 'oracle' : 'mysql'
  // 引擎与库切到预览目标(Oracle 用 FETCH FIRST,MySQL 用 LIMIT;标识符按方言加引号)
  // 仅引擎值变化时置抑制位:watch(engine) 触发后会把 db 覆盖回该引擎第一个源,
  // 需抑制以免预览跑错库;引擎不变则 watch 不触发,也不残留标志(防后续手动切引擎失灵)
  if (engine.value !== targetEngine) {
    suppressEngineDbSync = true
    engine.value = targetEngine
  }
  db.value = payload.db
  const ident = isOracle ? `"${payload.table}"` : `\`${payload.table}\``
  const sql = isOracle ? `SELECT * FROM ${ident} FETCH FIRST 100 ROWS ONLY` : `SELECT * FROM ${ident} LIMIT 100`
  const tabId = `tbl-${payload.db}.${payload.table}`
  const existing = tabs.value.find((t) => t.id === tabId)
  flushActiveContent()
  if (existing) {
    // 该 tab 已打开:若用户改过预览 SQL(未保存),重新生成预览会覆盖修改 → 只聚焦不覆盖
    if (existing.dirty) {
      ElMessage.warning('该 tab 已有未保存修改,预览未重新生成(避免覆盖编辑)')
      switchTab(existing.id)
      return
    }
    switchTab(existing.id)
  } else {
    const tab: EditorTab = {
      id: tabId,
      file: null,
      name: `${payload.db}.${payload.table}`,
      content: sql,
      dirty: false,
      model: undefined // model 由 showTabInEditor→ensureTabModel 按需创建
    }
    tabs.value.push(tab)
    activeTabId.value = tab.id
    showTabInEditor(tab)
  }
  setValue(sql) // 预览 SQL 覆盖当前文档(程序性写入:不标 dirty)
  await runQuery()
  // 预览结果标记为可编辑(行内编辑),并异步取主键列;校验 SQL 匹配防误标旧结果(runQuery 可能因互斥被拒)
  const r = results.value[results.value.length - 1]
  if (r && !r.error && r.sql.trim() === sql.trim()) {
    r.editable = true
    r.db = payload.db
    r.table = payload.table
    r.engine = isOracle ? 'oracle' : 'mysql'
    r.pendingEdits = []
    void loadPreviewPk(r, payload.db, payload.table, isOracle)
  }
}

/** 异步取表主键列(listFields detail 中 key==='PRI';Oracle 主键列转大写比较,名字原样存) */
async function loadPreviewPk(r: QueryResultItem, dbName: string, tableName: string, isOracle: boolean) {
  try {
    const fields = (await listFields(dbName, tableName, true)) as TableFieldDetail[]
    const pks = (fields || []).filter((f) => String(f.key || '').toUpperCase() === 'PRI').map((f) => f.name)
    // Oracle 元数据列名通常为大写;比较时统一转大写,存储保持原样
    r.pkCols = isOracle ? pks.map((p) => p.toUpperCase()) : pks
  } catch {
    r.pkCols = []
  }
}

/** 保存当前活跃 tab(Ctrl/Cmd + S):绑定文件直接保存;未命名时输入文件名保存到根目录 */
async function saveActive() {
  const tab = activeTab.value
  if (!tab) return
  if (tab.file) {
    try {
      await saveScriptContent(tab.file.id, getValue())
      tab.dirty = false
      ElMessage.success(`已保存 ${tab.name}`)
      treePanelRef.value?.reloadMy()
    } catch (e) {
      ElMessage.error(`保存失败:${e instanceof Error ? e.message : e}`)
    }
    return
  }
  // 未命名 tab → 命名保存到根目录
  try {
    const { value } = await ElMessageBox.prompt('文件名(默认保存到根目录)', '保存 SQL 文件', {
      inputValue: 'query.sql',
      inputValidator: (v) => (v?.trim() ? true : '名称不能为空')
    })
    let name = (value || '').trim()
    if (!name.toLowerCase().endsWith('.sql')) name += '.sql'
    const node = await createScriptNode(null, name, 'file')
    await saveScriptContent(node.id, getValue())
    tab.file = node
    tab.name = name
    tab.dirty = false
    ElMessage.success(`已保存到根目录 ${name}`)
    treePanelRef.value?.reloadMy()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(`保存失败:${e instanceof Error ? e.message : e}`)
  }
}

// 左侧目录宽度(可拖拽,持久化)
const SIDE_KEY = 'db-query-side-width'
const sideWidth = ref(parseInt(localStorage.getItem(SIDE_KEY) || '240', 10) || 240)

function onSideDragStart(e: MouseEvent) {
  const startX = e.clientX
  const startW = sideWidth.value
  const onMove = (ev: MouseEvent) => {
    const w = Math.min(460, Math.max(180, startW + (ev.clientX - startX)))
    sideWidth.value = w
  }
  const onUp = () => {
    localStorage.setItem(SIDE_KEY, String(sideWidth.value))
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// SparkSQL 虚拟数据源(db-proxy 引擎,不在 /acl 中)
const SPARK_SOURCE: DbDataSource = { name: 'spark', label: 'SparkSQL', type: 'sparksql', host: '', port: 0, user: '' }
// PySpark 虚拟数据源(python 编辑器,走 db-proxy execute_code 通道)
const PYSPARK_SOURCE: DbDataSource = { name: 'pyspark', label: 'PySpark', type: 'pyspark', host: '', port: 0, user: '' }
// FlinkSQL 虚拟数据源(走 db-proxy → Flink SQL Gateway)
const FLINK_SOURCE: DbDataSource = { name: 'flink', label: 'FlinkSQL', type: 'flinksql', host: '', port: 0, user: '' }

// 引擎过滤后的数据源(sparksql/pyspark/flinksql 为虚拟源,不进左侧树)
const filteredDbs = computed(() => {
  if (engine.value === 'sparksql') return [SPARK_SOURCE]
  if (engine.value === 'pyspark') return [PYSPARK_SOURCE]
  if (engine.value === 'flinksql') return [FLINK_SOURCE]
  return engine.value ? datasources.value.filter((d) => d.type === engine.value) : datasources.value
})

// 左侧树排除 spark/flink 虚拟源(db-proxy 无此库,拉表会报错)
const treeDbs = computed(() => datasources.value.filter((d) => d.type !== 'sparksql' && d.type !== 'pyspark' && d.type !== 'flinksql'))

// ── Monaco 编辑器 ───────────────────────────────────────────
const cmRef = ref<HTMLElement>()
const canvasRef = ref<HTMLElement>()
// useMonaco 薄层:创建/销毁/主题/字号/读写/快捷键(编辑器层与业务层解耦,见 src/editor/)
const {
  editor: edRef,
  getValue,
  setValue,
  setModel,
  insertAtCursor,
  getSelectionText,
  getCursorOffset,
  setLanguage,
  setTheme,
  setFontSize,
  onContentChange,
  addCommands
} = useMonaco(cmRef, { language: 'sql', fontSize: parseInt(localStorage.getItem('db-query-fontsize') || '15', 10) || 15 })
/** 当前编辑器实例(useMonaco 在 onMounted 创建;模板 ref 同名绑定) */
let ed: monaco.editor.IStandaloneCodeEditor | null = null

// 编辑器主题:dark(默认)/ light,持久化到 localStorage
// 只作用于本页 sql-canvas 画布(Monaco portal-dark/light 主题),与全局主题解耦:
// 初始跟随全局(getTheme),之后用户按按钮仅切画布,不影响全局
const THEME_KEY = 'db-query-theme'
const themeMode = ref<'dark' | 'light'>(
  localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
)

// 字体大小(px),默认 15(比原 13 大 2),持久化
const FONT_KEY = 'db-query-fontsize'
const fontSize = ref(parseInt(localStorage.getItem(FONT_KEY) || '15', 10) || 15)
const MIN_FONT = 11
const MAX_FONT = 24

function toggleTheme() {
  themeMode.value = themeMode.value === 'dark' ? 'light' : 'dark'
  localStorage.setItem(THEME_KEY, themeMode.value)
  // 仅切换画布主题(portal-dark/light),不调 applyTheme,避免污染全局主题
  setTheme(themeMode.value)
}

function adjustFont(delta: number) {
  fontSize.value = Math.min(MAX_FONT, Math.max(MIN_FONT, fontSize.value + delta))
  localStorage.setItem(FONT_KEY, String(fontSize.value))
  setFontSize(fontSize.value) // Monaco 实时生效(替代 CSS 变量+refresh)
}

/** 初始化编辑器业务侧:内容变化→dirty/自动保存/参数行;快捷键绑定(useMonaco 已创建实例) */
function initEditor() {
  if (!edRef.value || ed) return
  ed = edRef.value
  // 首次挂载:把初始 tab 的文档挂上(恢复草稿/文件内容),并应用持久化的画布主题/字号
  const initial = activeTab.value
  if (initial) {
    ensureTabModel(initial)
    ed.setModel(initial.model!)
    monaco.editor.setModelLanguage(initial.model!, initial.name.toLowerCase().endsWith('.py') ? 'python' : 'sql')
  }
  setTheme(themeMode.value)
  setFontSize(fontSize.value)
  // 文件内容变更 → 未保存标记(仅用户输入)+ 参数行同步(程序性写入也需同步 ${var})
  onContentChange((programmatic) => {
    syncRunVarBar()
    if (programmatic) return // setValue/setModel(切换 tab/打开文件)不触发自动保存
    const t = activeTab.value
    if (t) {
      t.dirty = true
      t.content = getValue() // 立即同步快照,防抖触发时即使已切走也不会取错内容
      scheduleAutoSave(t)
    }
  })
  // 快捷键:Ctrl/Cmd+Enter 执行 · Ctrl/Cmd+S 保存 · Cmd/Ctrl+Shift+F 格式化 · Cmd/Ctrl+/ 注释切换
  addCommands([
    { key: monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run: () => void runQuery() },
    { key: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, run: () => void saveActive() },
    { key: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, run: formatSql },
    { key: monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash, run: toggleCommentSelection }
  ])
}

onMounted(() => {
  initEditor()
})


onUnmounted(() => {
  flushTempDrafts()
  stopSparkLogPolling()
  // 编辑器销毁由 useMonaco 的 onBeforeUnmount 负责(dispose);此处释放各 tab 文档模型防泄漏
  for (const t of tabs.value) t.model?.dispose()
})

// 画布高度(可拖拽)
const canvasHeight = ref(280)
const MIN_H = 120

function onDragStart(e: MouseEvent) {
  const startY = e.clientY
  const startH = canvasHeight.value
  // 画布最大高度:视口的 75%(结果区最低可缩至约 1/4),下限 480 避免小屏异常
  const maxH = Math.max(480, Math.floor(window.innerHeight * 0.75))
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  const onMove = (ev: MouseEvent) => {
    canvasHeight.value = Math.min(maxH, Math.max(MIN_H, startH + ev.clientY - startY))
  }
  const onUp = () => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

import { splitSqlSegments, sqlLiteral, findRowKey, maskFormatSql } from './composables/useSqlParse'

/**
 * 待执行内容:优先选中;未选中时 SQL 取光标所在段(分号切分),python 取全文。
 * 找不到段(如全文只有注释)回退全文。
 */
function getSqlToRun(): string {
  // 1. 有选区 → 执行选中
  const sel = getSelectionText().trim()
  if (sel) return sel
  // 2. python 编辑器:无选区执行全文(整段提交,不做分号切分)
  if (engine.value === 'pyspark') return getValue()
  // 3. 无选区 → 光标所在段(getCursorOffset 为全文偏移,与 splitSqlSegments 同一坐标系)
  const cursorIdx = getCursorOffset()
  for (const seg of splitSqlSegments(getValue())) {
    if (seg.start <= cursorIdx && cursorIdx <= seg.end) {
      const s = seg.sql.trim()
      if (s) return s
    }
  }
  return getValue()
}

// ── SQL 格式化(简单:关键字换行缩进;python 模式不支持)─────────────────────────
/** 注释/取消注释选中 SQL(Monaco 行级操作:选区覆盖的每行行首加/去 "-- ",再按一次取消;无选区仅当前行) */
function toggleCommentSelection() {
  const ed0 = ed
  if (!ed0) return
  ed0.getAction('editor.action.commentLine')?.run()
}

/** 结果表格签名:表预览用 库.表,否则用 SQL 前 40 字符(列宽按表格持久化) */
const engineLabel = computed(() => {
  const m: Record<string, string> = { mysql: 'MySQL', oracle: 'Oracle', sparksql: 'SparkSQL', pyspark: 'PySpark', flinksql: 'FlinkSQL' }
  return m[engine.value] || engine.value || '—'
})

function formatSql() {
  if (!ed) return
  if (engine.value === 'pyspark') {
    ElMessage.info('Python 模式暂不支持格式化')
    return
  }
  const s = getValue().trim()
  if (!s) return
  setValue(maskFormatSql(s)) // 程序性写入:不标 dirty(格式化可撤销)
}

// ── 查询执行 ─────────────────────────────────────────────────

const results = ref<QueryResultItem[]>([])
// 结果最多保留多少条(每次执行追加一个新结果 tab,超出裁掉最旧)
const MAX_RESULTS = 20
// 当前激活面板:0 = 日志 tab;1..n = 结果 tab(对应 results[i],pane = i + 1)
const activePane = ref(0)
const currentResult = computed(() => (activePane.value > 0 ? results.value[activePane.value - 1] : null) ?? null)

// ── Spark driver 日志透传(执行 spark 查询时轮询展示)───────────
// 展示层(容器高度→保留行数/贴底滚动/Stage 进度条渲染)在 components/SparkLogPanel.vue;
// 轮询状态与裁剪逻辑迁至 composables/useSparkLogPolling.ts(下方 useSparkLogPolling() 装配)。
const {
  sparkLogText,
  sparkStageData,
  logEmptyHint,
  pollSparkLogs,
  startSparkLogPolling: _startSparkPolling,
  stopSparkLogPolling,
  clearSparkLogs
} = useSparkLogPolling({
  engine,
  loading,
  activePane,
  results,
  panelRef: sparkLogPanelRef
})
/** 查询开始时的日志启动入口:固定切到第一个 tab(日志)再开轮询(保持原行为) */
function startSparkLogPolling() {
  activePane.value = 0
  _startSparkPolling()
}

// ── 执行编排(useRunner;执行器/批次互斥/历史在 composable,展示状态在此注入)──
// 历史按用户名隔离:登录用户变化时同步给 runner(与 SqlTreePanel 的 histKey 一致)
watch(() => authStore.username, (u) => setHistUser(u || 'default'), { immediate: true })
const runner = useRunner({
  engine,
  db,
  loading,
  error,
  results,
  activePane,
  maxResults: MAX_RESULTS,
  filteredDbs: () => filteredDbs.value,
  getSqlToRun,
  collectRunVars,
  expandSqlVars,
  startSparkLogPolling,
  stopSparkLogPolling,
  pollSparkLogs: () => pollSparkLogs(),
  clearSparkLogs
})
const { runQuery, stopQuery, flinkMode, execDb, ensureDb } = runner

// 激活日志面板(切回/首次显示)时滚到底:滚动逻辑在 SparkLogPanel 内部,
// 这里仅触发其贴底方法(避免面板停在上方需手动下拖)。
// 注意:必须在 activePane 声明之后定义,watch 创建时会立即同步读取源 getter,
// 若放在 activePane 之前会因 const 的 TDZ 报 "Cannot access before initialization"。
watch(() => activePane.value, (pane) => {
  if (pane === 0) nextTick(() => sparkLogPanelRef.value?.updateMaxLogLines())
})
function selectPane(pane: number) {
  activePane.value = pane // 分页复位在 ResultGrid 内部(watch activePane)
}

/** 关闭某个结果 tab(从 results 移除;日志 tab 恒为第 0 个不可关;激活态修正在此,分页/编辑态归 ResultGrid) */
function closeResultTab(idx: number) {
  if (idx < 0 || idx >= results.value.length) return
  results.value.splice(idx, 1)
  if (activePane.value === idx + 1) {
    activePane.value = results.value.length === 0 ? 0 : Math.min(idx + 1, results.value.length)
  } else if (activePane.value > idx + 1) {
    activePane.value -= 1 // 关闭的 tab 在当前面板之前,后面面板整体前移
  }
}

/** ResultGrid 提交行内修改:逐条执行 UPDATE 后清空并重查该结果 tab(编排留在宿主) */
async function onCommitEdits(r: QueryResultItem) {
  const stmts = buildUpdateSql(r)
  if (!stmts.length) {
    ElMessage.warning('没有可提交的修改(主键列无法定位)')
    return
  }
  loading.value = true // 提交期间互斥,防用户同时执行新查询导致 rerunResult 竞态
  try {
    for (const sql of stmts) {
      await queryDb(r.db || db.value, sql) // 网关/db-proxy 单语句语义,逐条执行
    }
    ElMessage.success(`已提交 ${r.pendingEdits?.length ?? 0} 处修改`)
    r.pendingEdits = []
    await rerunResult(r) // 自动重查:直接刷新该结果 tab,不打断编辑器
  } catch (e) {
    ElMessage.error(`提交失败:${e instanceof Error ? e.message : e}`)
  } finally {
    loading.value = false
  }
}

/** ResultGrid 挂载日志面板实例后回填 ref(useSparkLogPolling 裁剪/贴底依赖它) */
function onLogPanelMounted(p: unknown) {
  sparkLogPanelRef.value = p as InstanceType<typeof SparkLogPanel> | undefined
}

// ── 行内编辑 SQL 生成(MySQL 反引号 / Oracle 双引号;主键取行内值;NULL 主键整行跳过)──
/** 按 row 分组生成 UPDATE 语句数组(每条单语句) */
function buildUpdateSql(r: QueryResultItem): string[] {
  if (!r.table || !r.pkCols?.length || !r.pendingEdits?.length) return []
  const isOracle = r.engine === 'oracle'
  const q = (id: string) => (isOracle ? `"${id}"` : `\`${id}\``)
  const tbl = q(r.table)
  const byRow = new Map<number, { row: Record<string, unknown>; edits: PendingEdit[] }>()
  for (const p of r.pendingEdits) {
    const item = r.rows[p.row]
    if (!item) continue
    const grp = byRow.get(p.row) || { row: item, edits: [] }
    grp.edits.push(p)
    byRow.set(p.row, grp)
  }
  const stmts: string[] = []
  for (const [, { row, edits }] of byRow) {
    const sets = edits.map((p) => `${q(findRowKey(row, p.col))} = ${sqlLiteral(p.newVal, isOracle)}`).join(', ')
    const wheres: string[] = []
    for (const pk of r.pkCols) {
      const key = findRowKey(row, pk)
      const v = row[key]
      if (v == null) {
        wheres.length = 0 // NULL 主键无法定位,整行跳过(WHERE pk IS NULL 风险高)
        break
      }
      wheres.push(`${q(key)} = ${sqlLiteral(v, isOracle)}`)
    }
    if (!wheres.length) continue
    stmts.push(`UPDATE ${tbl} SET ${sets} WHERE ${wheres.join(' AND ')}`)
  }
  return stmts
}

/** 重新执行某结果 tab 对应的原 SQL(提交修改后自动重查)。
 *  直接走 execDb(预览 SQL 必为 mysql/oracle SELECT,无需经过 engine 分支判定;
 *  临时切 db 到结果记录的库,执行后恢复,避免 watch(engine) 干扰) */
async function rerunResult(r: QueryResultItem) {
  const idx = results.value.indexOf(r)
  if (idx < 0) return
  const seq = runner.beginBatch() // 开新批次:使旧批在途结果失效(runner 内部状态)
  loading.value = true
  const savedDb = db.value
  if (r.db) db.value = r.db
  try {
    let res
    try {
      res = await execDb(r.sql)
    } catch (e) {
      if (seq === runner.seq) {
        results.value[idx] = {
          ...results.value[idx],
          sql: r.sql,
          columns: [],
          rows: [],
          costMs: 0,
          truncated: false,
          pendingEdits: [],
          running: false,
          error: e instanceof Error ? e.message : String(e)
        }
        activePane.value = idx + 1
      }
      return
    }
    if (seq !== runner.seq) return
    // 保留编辑元数据,清空待提交修改
    results.value[idx] = { ...results.value[idx], sql: r.sql, ...res, pendingEdits: [], running: false }
    if (seq === runner.seq) activePane.value = idx + 1
  } finally {
    db.value = savedDb
    loading.value = false
  }
}

// ── EXPLAIN 执行计划面板 ─────────────────────────────────────
const showExplain = ref(false)
const explainLoading = ref(false)
const explainError = ref('')
const explainTree = ref<ExplainNode | null>(null)
const explainTable = ref<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null)

/** 取当前活动 tab 编辑器选中文本;空则取全文第一条语句 */
function getExplainSql(): string {
  const sel = getSelectionText().trim()
  if (sel) return sel
  const segs = splitSqlSegments(getValue()).map((s) => s.sql.trim()).filter(Boolean)
  return segs[0] || ''
}

/** 执行计划节点展示文本已随 ExplainDialog 组件迁出(2026-08);数据获取留在本组件 */

/** 触发 EXPLAIN:取当前数据源 + 当前编辑器选中/首条 SQL,弹结果面板 */
async function runExplain() {
  if (!ensureDb()) {
    ElMessage.warning('请先选择数据库')
    return
  }
  if (engine.value !== 'mysql' && engine.value !== 'oracle') {
    ElMessage.warning('EXPLAIN 仅支持 MySQL / Oracle')
    return
  }
  const rawExplain = getExplainSql()
  if (!rawExplain.trim()) {
    ElMessage.warning('没有可分析的 SQL(请选中或输入语句)')
    return
  }
  const varVals = collectRunVars(rawExplain)
  const sql = expandSqlVars(rawExplain, varVals)
  showExplain.value = true
  explainLoading.value = true
  explainError.value = ''
  explainTree.value = null
  explainTable.value = null
  try {
    const data = await explainSql({ db: db.value, sql })
    if (data.kind === 'tree') explainTree.value = data.root
    else {
      // MySQL 回退为普通行;Oracle 无列时是文本行列表,统一转成单列对象
      const cols = data.columns?.length ? data.columns : ['line']
      const rows = (data.rows || []).map((r) =>
        r && typeof r === 'object' ? (r as Record<string, unknown>) : { line: String(r) }
      )
      explainTable.value = { columns: cols, rows }
    }
  } catch (e) {
    explainError.value = e instanceof Error ? e.message : String(e)
  } finally {
    explainLoading.value = false
  }
}

// Schema 补全(表名/点语法列/关键字/文中词)已迁 src/editor/sqlCompletion.ts 并注册为
// Monaco 全局 provider;当前 db 经 setCompletionDb 注入(下方 watch 同步),按库缓存策略不变。

// ── Flink 流批模式与弹窗(flinkMode 状态在 useRunner)────────
const showFlinkConn = ref(false)
const showFlinkPreJob = ref(false)

/** 连接器弹窗生成 DDL → 插入编辑器(多段用空行分隔) */
function onInsertFlinkDdl(ddls: string[]) {
  if (!ed || !ddls.length) return
  insertAtCursor(ddls.join('\n\n'))
  ElMessage.success(`已插入 ${ddls.length} 条 CREATE TABLE`)
}

// ── $ 传参:自动识别 SQL 中全部 ${var},画布下方参数行内联填值,执行时替换 ─────
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_-]*)\}/g // 变量名:字母/下划线开头

/** 当前编辑器内容检测到的变量(有序去重;空数组时参数行不渲染) */
const runVarNames = ref<string[]>([])
/** 各变量当前输入值(参数行内联输入框 v-model) */
const runVarValues = reactive<Record<string, string>>({})
/** 会话内记忆:上次执行用过的取值,同名变量再现时自动预填 */
const varMemory = new Map<string, string>()

/** 编辑器内容变化/tab 切换后同步参数行:新增变量预填上次值,消失变量清输入 */
function syncRunVarBar() {
  const sql = getValue()
  VAR_RE.lastIndex = 0
  const names: string[] = []
  let m: RegExpExecArray | null
  while ((m = VAR_RE.exec(sql))) if (!names.includes(m[1])) names.push(m[1])
  for (const n of names) {
    if (!(n in runVarValues) && varMemory.has(n)) runVarValues[n] = varMemory.get(n)!
  }
  for (const k of Object.keys(runVarValues)) {
    if (!names.includes(k)) delete runVarValues[k]
  }
  runVarNames.value = names
}

/**
 * 执行前收集参数值:只看本次要执行的 SQL 段里出现的变量(画布其他段的变量不拦截);
 * 已填值的替换,未填值的保持 ${var} 原样交由引擎报错感知 —— 不因缺参阻断执行。
 */
function collectRunVars(rawSql: string): Map<string, string> {
  const values = new Map<string, string>()
  VAR_RE.lastIndex = 0
  const names = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = VAR_RE.exec(rawSql))) names.add(m[1])
  for (const n of names) {
    const v = (runVarValues[n] ?? '').trim()
    if (!v) continue // 未填:原样传给引擎
    values.set(n, v)
    varMemory.set(n, v)
  }
  return values
}

/** 画布 SQL 变量替换:${var} → 参数行填写的值(无值保持原样) */
function expandSqlVars(sql: string, values?: Map<string, string>): string {
  return sql.replace(VAR_RE, (all, name: string) => values?.get(name) ?? all)
}


// ── 初始化 ───────────────────────────────────────────────────
onMounted(async () => {
  // 编辑器主题与全局主题对齐(全局 dark 时编辑器默认 dark,除非用户单独设置过)
  if (!localStorage.getItem(THEME_KEY)) {
    themeMode.value = getTheme() === 'dark' ? 'dark' : 'light'
  }
  try {
    datasources.value = await listDataSources()
    if (datasources.value.length) {
      const first = datasources.value.find(
        (d) => d.type === 'mysql' || d.type === 'oracle' || d.type === 'sparksql'
      )
      engine.value = first ? first.type as 'mysql' | 'oracle' | 'sparksql' | 'pyspark' | 'flinksql' : ''
      db.value = filteredDbs.value[0]?.name || ''
    } else {
      ElMessage.warning('未配置数据库源(检查网关 DB_PROXY_URL)')
    }
  } catch (e) {
    ElMessage.error(`加载数据源失败:${e instanceof Error ? e.message : e}`)
  }
  // 读取 Spark 引擎当前 executor 配置回显(失败静默,不影响主流程)
  try {
    const st = (await sparkStatus()) as { config?: { executorInstances?: number } }
    sparkExecutors.value = st.config?.executorInstances ?? 0
  } catch {
    /* 引擎未启用或不可达时忽略 */
  }
})

/** onOpenTable 双击预览时置位:抑制 watch(engine) 自动回切 db(预览显式指定了目标库),
 *  一次性消费,后续手动切引擎仍恢复原行为 */
let suppressEngineDbSync = false

// 当前库 → Monaco SQL 补全上下文(schema 按库缓存,切库即切换候选集)
watch(db, (v) => setCompletionDb(v || ''))

watch(engine, async (val) => {
  // 写权限密码验证已移除,切换引擎不再要求解锁
  if (!val) return
  if (!suppressEngineDbSync) {
    const first = filteredDbs.value.find((d) => d.type === val)
    db.value = first?.name || ''
  }
  suppressEngineDbSync = false
  // python 编辑器切换为 python 模式,其余为 SQL 模式(Monaco 按当前文档语言高亮)
  setLanguage(val === 'pyspark' ? 'python' : 'sql')
})

/** 切换 Spark executor 数量:调后端存配置,停会话下次查询自动重建 */
async function onSparkExecutorsChange(val: number) {
  if (sparkExecutorsLoading.value) return
  sparkExecutorsLoading.value = true
  try {
    await setSparkExecutors(val)
    if (val === 0) ElMessage.info('已切换为动态分配;下次 sparksql 查询生效')
    else ElMessage.info(`已设置固定 ${val} 个 executor;下次 sparksql 查询生效(需重建会话)`)
  } catch (e) {
    ElMessage.error(`设置失败:${e instanceof Error ? e.message : e}`)
    sparkExecutors.value = 0 // 回退
  } finally {
    sparkExecutorsLoading.value = false
  }
}

/** 单元格是否数值(右对齐) */
</script>

<template>
  <div class="db-query">
    <!-- 左目录面板 + 右查询区 -->
    <div class="db-main">
      <div class="db-side" :style="{ width: sideWidth + 'px' }">
        <SqlTreePanel ref="treePanelRef" :dbs="treeDbs" @open="onOpenFile" @insert="onInsert" @open-table="onOpenTable" @run-sql="onRunHistorySql" />
      </div>
      <div class="db-resizer" title="拖拽调整目录宽度" @mousedown.prevent="onSideDragStart" />
      <div class="db-right">
    <!-- 顶部工具条 -->
    <div class="toolbar">
      <el-select v-model="engine" class="engine-select" placeholder="引擎" clearable @change="db = filteredDbs[0]?.name || ''">
        <el-option label="MySQL" value="mysql" />
        <el-option label="Oracle" value="oracle" />
        <el-option label="SparkSQL" value="sparksql" />
        <el-option label="PySpark" value="pyspark" />
        <el-option label="FlinkSQL" value="flinksql" />
      </el-select>
      <el-select
        v-if="engine === 'sparksql'"
        v-model="sparkExecutors"
        class="executor-select"
        placeholder="Executor 数量"
        :loading="sparkExecutorsLoading"
        @change="onSparkExecutorsChange"
      >
        <el-option label="动态分配(自适应)" :value="0" />
        <el-option label="5 个" :value="5" />
        <el-option label="10 个" :value="10" />
        <el-option label="15 个" :value="15" />
        <el-option label="20 个" :value="20" />
      </el-select>
      <el-select v-model="db" class="db-select" placeholder="选择数据库" filterable>
        <el-option v-for="d in filteredDbs" :key="d.name" :label="`${d.label || d.name}${d.label && d.label !== d.name ? ` (${d.name})` : ''}`" :value="d.name" />
      </el-select>
      <div class="toolbar-spacer" />
      <el-tooltip content="保存脚本(Cmd+S)" placement="top">
        <el-button
          :icon="DocumentChecked"
          class="save-btn"
          :disabled="loading"
          @click="saveActive"
        />
      </el-tooltip>
      <el-tooltip content="减小字号" placement="top">
        <el-button class="font-btn" text @click="adjustFont(-1)">A−</el-button>
      </el-tooltip>
      <el-tooltip content="增大字号" placement="top">
        <el-button class="font-btn" text @click="adjustFont(1)">A+</el-button>
      </el-tooltip>
      <el-divider direction="vertical" />
      <template v-if="engine === 'flinksql'">
        <el-radio-group v-model="flinkMode" size="small" class="flink-mode">
          <el-radio-button value="batch">批</el-radio-button>
          <el-radio-button value="stream">流</el-radio-button>
        </el-radio-group>
        <el-tooltip content="连接器管理" placement="top"><el-button size="small" :icon="MagicStick" @click="showFlinkConn = true" /></el-tooltip>
        <el-tooltip content="PreJob 提交/管理" placement="top"><el-button size="small" :icon="Promotion" @click="showFlinkPreJob = true" /></el-tooltip>
        <el-divider direction="vertical" />
      </template>
      <el-tooltip content="格式化 SQL(Cmd+Shift+F)" placement="top"><el-button :icon="MagicStick" @click="formatSql" /></el-tooltip>
      <el-tooltip content="执行计划(EXPLAIN)" placement="top"><el-button :icon="Promotion" @click="runExplain" /></el-tooltip>
      <el-tooltip v-if="loading" content="停止" placement="top"><el-button type="danger" :icon="VideoPause" @click="stopQuery" /></el-tooltip>
      <el-tooltip content="执行(Cmd+Enter)" placement="top"><el-button type="primary" :icon="CaretRight" @click="runQuery" /></el-tooltip>
      <el-divider direction="vertical" />
      <el-tooltip :content="themeMode === 'dark' ? '切换到浅色' : '切换到深色'" placement="top">
        <el-button class="theme-btn" text @click="toggleTheme">
          <el-icon><Sunny v-if="themeMode === 'dark'" /><Moon v-else /></el-icon>
        </el-button>
      </el-tooltip>
    </div>

    <!-- SQL 文件 tab 栏(最多 10 个) -->
    <div class="file-tabs">
      <div
        v-for="t in tabs"
        :key="t.id"
        class="file-tab"
        :class="{ active: t.id === activeTabId }"
        :title="t.name"
        @click="switchTab(t.id)"
      >
        <el-icon class="file-tab-icon"><Document /></el-icon>
        <span class="file-tab-name">{{ t.name }}</span>
        <span v-if="t.dirty" class="file-tab-dirty" title="有未保存的修改">●</span>
        <el-tooltip content="关闭" placement="top"><el-icon class="file-tab-close" @click.stop="closeTab(t.id)"><Close /></el-icon></el-tooltip>
      </div>
      <div class="file-tab file-tab-add" title="新建查询" @click="newQuery">
        <el-icon><Plus /></el-icon>
      </div>
      <span class="file-tabs-spacer" />
    </div>

    <!-- SQL 画布(Monaco;主题/字号由编辑器层管理,容器只管高度) -->
    <div ref="canvasRef" class="sql-canvas" :style="{ height: canvasHeight + 'px' }">
      <div ref="cmRef" class="sql-editor"></div>
    </div>

    <!-- 拖拽分割条 -->
    <div class="sql-dragbar" @mousedown="onDragStart">
      <span class="drag-dots">⠿</span>
    </div>
    <!-- $ 传参行:自动识别 ${var},内联填值后执行;无变量时不占位 -->
    <div v-if="runVarNames.length" class="sql-varbar">
      <span class="varbar-title">SQL 参数</span>
      <span v-for="n in runVarNames" :key="n" class="var-item">
        <code class="var-name">{{ '${' + n + '}' }}</code>
        <el-input v-model="runVarValues[n]" class="var-input" size="small" placeholder="填写值" clearable />
      </span>
      <span class="varbar-tip">填写后 Ctrl/Cmd + Enter 执行</span>
    </div>

    <!-- 错误提示 -->
    <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" class="err-alert" />

    <!-- 结果区(tab 栏+日志+表格+翻页+工具条,整体拆至 components/ResultGrid.vue) -->
    <ResultGrid
      v-if="results.length"
      class="results-wrap"
      :results="results"
      :active-pane="activePane"
      :loading="loading"
      :spark-log-text="sparkLogText"
      :log-empty-hint="logEmptyHint"
      :spark-stage-data="sparkStageData"
      :spark-log-active="activePane === 0"
      @select-pane="selectPane"
      @close-tab="closeResultTab"
      @commit-edits="onCommitEdits"
      @open-flink-jobs="showFlinkPreJob = true"
      @poll-logs="pollSparkLogs()"
      @clear-logs="clearSparkLogs()"
      @panel-mounted="onLogPanelMounted"
    />

    <!-- 空状态 -->
    <div v-else-if="!loading && !error" class="empty-state">
      <el-empty description="选择数据库,编写 SQL 后执行(Ctrl/Cmd + Enter)" />
    </div>
      </div>
    </div>

    <!-- 底部全局状态栏(DataGrip 式):引擎/库/结果统计/主题 -->
    <div class="statusbar">
      <span class="sb-item"><span class="sb-label">引擎</span>{{ engineLabel }}</span>
      <span class="sb-item"><span class="sb-label">库</span>{{ db || '—' }}</span>
      <template v-if="currentResult && !currentResult.error && !currentResult.jobId">
        <span class="sb-item sb-stats">
          {{ currentResult.rows.length }} 行 · {{ currentResult.columns.length }} 列 · {{ currentResult.costMs }}ms
          <span v-if="currentResult.truncated" class="sb-trunc">· 已截断</span>
        </span>
        <span v-if="currentResult.running" class="sb-item sb-running"><el-icon class="tab-spin"><Loading /></el-icon> 执行中…</span>
      </template>
      <span v-else-if="loading" class="sb-item sb-running"><el-icon class="tab-spin"><Loading /></el-icon> 执行中…</span>
      <span class="sb-spacer" />
      <span class="sb-item sb-hints">Ctrl/Cmd + Enter 执行 · Tab 缩进 · Ctrl/Cmd + Space 补全 · 拖拽分割条调整画布高度</span>
      <span class="sb-item">{{ themeMode === 'dark' ? '深色' : '浅色' }}主题</span>
    </div>
  </div>

  <!-- Flink 连接器批量建表弹窗 -->
  <FlinkConnectorDialog v-model="showFlinkConn" @insert="onInsertFlinkDdl" />

  <!-- Flink PreJob 提交/管理弹窗 -->
  <FlinkPreJobDialog v-model="showFlinkPreJob" />

  <!-- EXPLAIN 执行计划面板(展示逻辑在 components/ExplainDialog.vue;数据获取留在本组件 runExplain) -->
  <ExplainDialog
    v-model="showExplain"
    :loading="explainLoading"
    :error="explainError"
    :tree="explainTree"
    :table="explainTable"
  />
</template>

<style scoped lang="scss">
.db-query {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden; /* 整体不滚:画布/结果区各自内滚 */
}

/* 左目录面板 + 右查询区 */
.db-main {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 10px;
}

.db-side {
  width: 240px;
  flex-shrink: 0;
  border: 1px solid $border;
  border-radius: 6px;
  overflow: hidden;
}

/* 拖拽条 */
.db-resizer {
  width: 4px;
  cursor: col-resize;
  flex-shrink: 0;
  border-radius: 3px;
  background: $border;
  transition: background 0.15s;

  &:hover {
    background: $primary;
    opacity: 0.6;
  }
}

.db-right {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  gap: 6px;
}

.save-btn {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── SQL 文件 tab 栏 ───────────────────────────────────── */
.file-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 2px 4px;
  flex-shrink: 0;
  overflow-x: auto;
}

.file-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  font-size: 12px;
  color: $muted;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;

  &.active {
    background: var(--bd-table-hover);
    color: $text;
    font-weight: 600;
  }

  &:hover {
    color: $primary;
  }
}

.file-tab-icon {
  font-size: 13px;
  color: $primary;
}

.file-tab-dirty {
  color: #e6a23c;
  font-size: 10px;
}

.file-tab-close {
  font-size: 12px;
  color: $muted;
  border-radius: 3px;
  padding: 1px;
  cursor: pointer;

  &:hover {
    color: #f56c6c;
    background: rgba(245, 108, 108, 0.12);
  }
}

.file-tab-add {
  padding: 3px 6px;
  color: $muted;

  &:hover {
    color: $primary;
  }
}

.file-tabs-spacer {
  flex: 1;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 4px 6px;
  flex-shrink: 0;

  /* 按钮瘦身 */
  :deep(.el-button) {
    padding: 5px 8px;
  }

  :deep(.el-select__wrapper) {
    min-height: 28px;
    padding: 0 8px;
  }
}

.engine-select {
  width: 96px;
}

.executor-select {
  width: 120px;
}

.db-select {
  width: 200px;
}

.toolbar-spacer {
  flex: 1;
}

.font-btn {
  min-width: 28px;
  padding: 0 6px;
  font-weight: 700;
}

.theme-btn {
  padding: 4px;
  font-size: 16px;
}

.exec-kbd {
  margin-left: 6px;
  padding: 1px 5px;
  font-size: 11px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.15);
}

/* ── SQL 画布(Monaco) ───────────────────────────────────── */
.sql-canvas {
  position: relative;
  display: flex;
  background: #34373c;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
}

.sql-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  /* Monaco 自带滚动/行号/高亮,字体在 useMonaco 中设置;此处仅保证撑满容器 */
}

/* Monaco 补全建议浮层跟随画布明暗(编辑器 shadow DOM 外的 overlay,按 html.dark 调) */
:global(html.dark) .sql-editor .suggest-widget,
:global(html.dark) .sql-editor .monaco-editor-overlaymessage {
  border-radius: 8px;
}

/* Monaco 建议浮层(suggest-widget 挂在编辑器 shadow root 外,主题由 Monaco 自管;
   此处仅调圆角与层级,保证画布在弹窗内也能浮出) */
.sql-editor .suggest-widget {
  z-index: 3000;
  border-radius: 8px;
}

/* 拖拽分割条 */
.sql-dragbar {
  height: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: row-resize;
  color: $muted;
  flex-shrink: 0;
  user-select: none;
  background: $panel;
  border-top: 1px solid $border;
  border-bottom: 1px solid $border;
  border-radius: 3px;

  &:hover {
    color: $primary;
    background: var(--bd-table-hover);
  }
}

.drag-dots {
  font-size: 12px;
  letter-spacing: 2px;
}

/* $ 传参行:变量 chip + 内联输入框(无变量时不渲染) */
.sql-varbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 4px 10px;
  font-size: 12px;
  color: $muted;
  background: $panel;
  border-top: 1px solid $border;
  flex-shrink: 0;

  .varbar-title {
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  .var-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .var-name {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(127, 127, 127, 0.14);
  }

  .var-input {
    width: 130px;
  }
}

.err-alert {
  flex-shrink: 0;
}

/* 结果区容器高度(ResultGrid 根元素由宿主布局控制) */
.results-wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  border: 1px solid $border;
  border-radius: 8px;
  overflow: hidden;
  background: $bg;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.err-alert {
  flex-shrink: 0;
}


/* ── 底部全局状态栏(DataGrip 式) ─────────────────────────── */
.statusbar {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 26px;
  padding: 0 12px;
  font-size: 12px;
  color: $muted;
  background: $panel;
  border-top: 1px solid $border;
  user-select: none;

  .sb-label {
    color: $muted;
    margin-right: 4px;
  }

  .sb-stats {
    color: $text;
    font-variant-numeric: tabular-nums;
  }

  .sb-trunc {
    color: #e6a23c;
  }

  .sb-running {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: $primary;
  }

  .sb-spacer {
    flex: 1;
  }

  .sb-hints {
    font-size: 11px;
    opacity: 0.75;
  }
}

/* JSON 单元格值弹窗 + 折叠标签 */
.dbq-json-dialog .dbq-json {
  max-height: 60vh;
  overflow: auto;
  margin: 0;
  padding: 10px;
  font-family: var(--el-font-family-mono, monospace);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}

.cell-json {
  display: inline-block;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  color: #d97706;
  background: rgba(217, 119, 6, 0.12);
  cursor: pointer;
  user-select: none;

  &:hover {
    background: rgba(217, 119, 6, 0.22);
  }
}

/* Spark 引擎日志透传面板 */
.spark-logs-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 120px; /* 确保展开后可见,不被结果区挤没 */
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}
.spark-logs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}
/* 注:上方 .spark-logs-head 仍被本组件外层头部使用,勿删;
   Stage 进度/日志体样式已随 SparkLogPanel、EXPLAIN 弹窗样式已随 ExplainDialog 组件迁出(2026-08) */

/* 提交修改确认弹窗中的完整 SQL 预览 */
.edit-sql-preview {
  max-height: 320px;
  margin: 0;
  overflow: auto;
  padding: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: 4px;
}
</style>
