<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CaretRight, Download, Loading, MagicStick, Sunny, Moon, DocumentChecked, Document, Plus, Close, VideoPause, Promotion, CopyDocument, Grid } from '@element-plus/icons-vue'
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/sql/sql.js'
import 'codemirror/mode/python/python.js'
// 官方 addon(静态 import,Vite 下以 CJS 转换后挂到同一 CodeMirror 实例):
// 补全 / 折叠 / 括号匹配与自动闭合 / 光标行 / 选中高亮 / 容器自适应刷新
import 'codemirror/addon/hint/show-hint.js'
import 'codemirror/addon/hint/sql-hint.js'
import 'codemirror/addon/hint/anyword-hint.js'
import 'codemirror/addon/hint/show-hint.css'
import 'codemirror/addon/fold/foldcode.js'
import 'codemirror/addon/fold/foldgutter.js'
import 'codemirror/addon/fold/indent-fold.js'
import 'codemirror/addon/fold/brace-fold.js'
import 'codemirror/addon/fold/comment-fold.js'
import 'codemirror/addon/fold/foldgutter.css'
import 'codemirror/addon/edit/matchbrackets.js'
import 'codemirror/addon/edit/closebrackets.js'
import 'codemirror/addon/selection/active-line.js'
import 'codemirror/addon/search/match-highlighter.js'
import 'codemirror/addon/display/autorefresh.js'
import { listDataSources, queryFlink, cancelFlink, sparkLogs, sparkStages, cancelSpark, submitSparkJob, getSparkJob, cancelSparkJob, submitDbJob, getDbJob, cancelDbJob, saveScriptContent, getScriptContent, createScriptNode, queryDb, getSchema, explainSql, listFields, type DbDataSource, type ScriptNode, type TableFieldDetail, type ExplainNode, type SparkStage } from '@/api/db'
import { getTheme } from '@/utils/theme'
import { copyText } from '@/utils/clipboard'
import SqlTreePanel from './SqlTreePanel.vue'
const treePanelRef = ref<InstanceType<typeof SqlTreePanel>>()
import FlinkConnectorDialog from './FlinkConnectorDialog.vue'
import FlinkJobsDialog from './FlinkJobsDialog.vue'
import FlinkPreJobDialog from './FlinkPreJobDialog.vue'

defineOptions({ name: 'DbQueryView' })

// ── 状态 ─────────────────────────────────────────────────────
const datasources = ref<DbDataSource[]>([])
const engine = ref<'mysql' | 'oracle' | 'sparksql' | 'pyspark' | 'flinksql' | ''>('')
const db = ref('')
const loading = ref(false)
const error = ref('')

// 写权限密码验证已移除(由网关库权限矩阵管控 + 数据源 readOnly 兜底),以下直接执行
/** 判定 SQL 是否可能为写操作(与后端 server/index.js 的 isSparkWriteSql 保持一致):
 *  只读关键字开头放行;WITH 前缀且无写关键字放行;含分号/其余一律视为写。
 *  引号感知切分(字符串内分号不算多语句),并拦截 SELECT INTO OUTFILE/LOAD_FILE 走私 */
function isSparkWriteSql(sql: string): boolean {
  const raw = String(sql)
  // MySQL/MariaDB 可执行注释 /*! ... */ 与 /*M! ... */ 会被数据库执行,绝不能当普通注释删除 —— 检测到一律视为写
  if (/\*[Mm]?!/.test(raw)) return true
  let s = raw
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '')
    .trim()
  if (!s) return false
  // 引号感知切分:跳过单引号字符串内的分号
  const parts: string[] = []
  let cur = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1]
      i++
      continue
    }
    if (c === "'") {
      inStr = !inStr
      cur += c
      continue
    }
    if (c === ';' && !inStr) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  parts.push(cur)
  const last = parts[parts.length - 1].trim()
  if (parts.length > 2 || (parts.length === 2 && last !== '')) return true
  s = last || parts[0].trim()
  // SELECT 前缀走私(INTO OUTFILE/DUMPFILE、LOAD_FILE)视为写
  if (/\bINTO\s+(OUTFILE|DUMPFILE)\b|\bLOAD_FILE\s*\(/i.test(s)) return true
  if (/^(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|SET|USE)\b/i.test(s)) return false
  if (/^WITH\b/i.test(s) && !/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|MSCK|REFRESH|LOAD|OVERWRITE)\b/i.test(s)) return false
  return true
}

/** 当前 Spark 异步任务的 jobId(供停止按钮精确取消) */
const currentSparkJobId = ref('')

/** Spark 执行:异步任务模式 —— 提交即返回 jobId,前端轮询结果。
 *  动机:公司网关固定 60s 读超时,同步长请求(大查询可能跑数十分钟/小时)
 *  必被掐断 504;异步化后提交/查状态都是秒级往返,永不撞超时。
 *  SQL 写语句或 pyspark(任意代码)未解锁时先弹密码框;只读 SQL 直接执行。 */
async function execSpark(sql: string, kind: 'sql' | 'pyspark' = 'sql'): Promise<{ columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean }> {
  const needsAuth = kind === 'pyspark' || (kind === 'sql' && isSparkWriteSql(sql))
  if (needsAuth) {
    // 写权限密码验证已移除(网关库权限矩阵管控),直接执行
  }
  const { jobId } = await submitSparkJob(sql, undefined, kind, 7200000)
  currentSparkJobId.value = jobId
  const deadline = Date.now() + 7200000 // 上限 2 小时
  while (Date.now() < deadline) {
    if (batchCancelled) {
      try {
        await cancelSparkJob(jobId)
      } catch {
        /* 忽略 */
      }
      throw new Error('已取消')
    }
    const j = await getSparkJob(jobId)
    if (j.state === 'done') {
      currentSparkJobId.value = ''
      return j.result as { columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean }
    }
    if (j.state === 'failed') {
      currentSparkJobId.value = ''
      throw new Error(j.error || '任务执行失败')
    }
    await new Promise((r) => setTimeout(r, 3000)) // 3s 轮询(低频)
  }
  try {
    await cancelSparkJob(jobId)
  } catch {
    /* 忽略 */
  }
  currentSparkJobId.value = ''
  throw new Error('任务超时(2 小时),已自动取消')
}

// ── 多文件 tab(最多 10 个)──────────────────────────────────
const MAX_TABS = 10
interface EditorTab {
  id: string
  file: ScriptNode | null // 绑定的文件;null = 未命名查询
  name: string
  content: string // 内容快照(切换 tab 时写回/读取)
  dirty: boolean
}
let tabSeq = 0
function newTab(name: string, content: string, id?: string): EditorTab {
  return { id: id || `tab-${++tabSeq}`, file: null, name, content, dirty: false }
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
let autoSaveTimer: number | undefined
function scheduleAutoSave(tab: EditorTab) {
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = window.setTimeout(() => {
    autoSaveTimer = undefined
    void autoSaveTab(tab)
  }, 2000)
}
async function autoSaveTab(tab: EditorTab) {
  if (!tabs.value.includes(tab)) return // tab 已关闭
  tab.content = cm?.getValue() ?? tab.content
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
  if (t) t.content = cm?.getValue() ?? ''
}

/** 切换 tab:写回当前内容 → 加载目标内容 */
function switchTab(id: string) {
  if (id === activeTabId.value) return
  flushActiveContent()
  activeTabId.value = id
  const next = tabs.value.find((t) => t.id === id)
  if (next) {
    cm?.setValue(next.content)
    if (next.file?.name.toLowerCase().endsWith('.py')) engine.value = 'pyspark'
  }
  cm?.focus()
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
      cm?.setValue('')
    } else {
      const next = tabs.value[Math.min(idx, tabs.value.length - 1)]
      activeTabId.value = next.id
      cm?.setValue(next.content)
    }
  }
  cm?.focus()
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
  cm?.setValue('')
  cm?.focus()
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
    const tab: EditorTab = { id: `file-${node.id}`, file: node, name: node.name, content, dirty: false }
    tabs.value.push(tab)
    activeTabId.value = tab.id
    cm?.setValue(content || '')
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
  const c = cm
  if (!c) return
  const cur = c.getCursor()
  c.replaceRange(text, cur)
  c.setCursor({ line: cur.line, ch: cur.ch + text.length })
  c.focus()
}

/** 历史/收藏条目点击(SqlTreePanel runSql 事件):历史是缓存,只回填编辑器,不自动执行 */
function onRunHistorySql(sql: string) {
  const c = cm
  if (!c) return
  const s = String(sql || '')
  if (!s.trim()) return
  c.setValue(s)
  c.focus()
}

/** 双击表目录中的表:新开/复用预览 tab,自动执行 SELECT * 前 100 行 */
async function onOpenTable(payload: { db: string; table: string }) {
  if (tabs.value.length >= MAX_TABS) {
    ElMessage.warning(`最多同时打开 ${MAX_TABS} 个 tab,请先关闭部分 tab`)
    return
  }
  const src = datasources.value.find((d) => d.name === payload.db)
  const isOracle = src?.type === 'oracle'
  // 引擎与库切到预览目标(Oracle 用 FETCH FIRST,MySQL 用 LIMIT;标识符按方言加引号)
  engine.value = isOracle ? 'oracle' : 'mysql'
  db.value = payload.db
  const ident = isOracle ? `"${payload.table}"` : `\`${payload.table}\``
  const sql = isOracle ? `SELECT * FROM ${ident} FETCH FIRST 100 ROWS ONLY` : `SELECT * FROM ${ident} LIMIT 100`
  const tabId = `tbl-${payload.db}.${payload.table}`
  const existing = tabs.value.find((t) => t.id === tabId)
  flushActiveContent()
  if (existing) {
    switchTab(existing.id)
  } else {
    const tab: EditorTab = { id: tabId, file: null, name: `${payload.db}.${payload.table}`, content: sql, dirty: false }
    tabs.value.push(tab)
    activeTabId.value = tab.id
  }
  cm?.setValue(sql)
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
      await saveScriptContent(tab.file.id, cm?.getValue() ?? '')
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
    await saveScriptContent(node.id, cm?.getValue() ?? '')
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

// ── CodeMirror 编辑器 ───────────────────────────────────────
const cmRef = ref<HTMLElement>()
const canvasRef = ref<HTMLElement>()
let cm: CodeMirror.Editor | null = null
let completionTimer: number | null = null

// 默认 SQL:清空(用户自行编写)
const DEFAULT_SQL = ''

// 编辑器主题:dark(默认)/ light,持久化到 localStorage
// 只作用于本页 sql-canvas 画布(CodeMirror 区域),与全局主题解耦:
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
  // 仅切换画布 class(.sql-canvas.dark / .light),不调 applyTheme,避免污染全局主题
  nextTick(() => cm?.refresh())
}

function adjustFont(delta: number) {
  fontSize.value = Math.min(MAX_FONT, Math.max(MIN_FONT, fontSize.value + delta))
  localStorage.setItem(FONT_KEY, String(fontSize.value))
}

async function initEditor() {
  if (!cmRef.value || cm) return
  cm = CodeMirror(cmRef.value, {
    value: activeTab.value?.content ?? DEFAULT_SQL,
    mode: 'text/x-sql',
    lineNumbers: true,
    indentWithTabs: false,
    tabSize: 2,
    indentUnit: 2,
    lineWrapping: true,
    theme: 'default',
    // ── 官方 addon 增强 ──────────────────────────────
    // 括号匹配与自动闭合(替换自实现)
    matchBrackets: true,
    autoCloseBrackets: true,
    // 光标行高亮 + 选中词高亮
    styleActiveLine: true,
    highlightSelectionMatches: true,
    // 代码折叠(SQL 子查询/CTE、python 函数体)
    foldGutter: true,
    gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
    foldOptions: {
      rangeFinder: CodeMirror.fold.combine(CodeMirror.fold.brace, CodeMirror.fold.indent, CodeMirror.fold.comment)
    },
    // 容器尺寸变化自动 refresh(tab 常驻池中非激活创建也能正确布局)
    autoRefresh: true
  })
  // 首次挂载若容器尺寸未稳定(如 tab 常驻池中非激活创建),内容会挤到行号前。
  // 等 DOM 稳定后强制 refresh 重算布局。
  await nextTick()
  cm.refresh()
  // 文件内容变更 → 未保存标记(仅跟踪当前活跃 tab)+ 防抖自动保存
  cm.on('change', (_c, change) => {
    if (change.origin === 'setValue') return // 程序性 setValue(切换 tab/打开文件)不触发自动保存
    const t = activeTab.value
    if (t) {
      t.dirty = true
      t.content = cm?.getValue() ?? t.content // 立即同步快照,防抖触发时即使已切走也不会取错内容
      scheduleAutoSave(t)
    }
  })
  // ── 补全触发:输入字母/下划线后 300ms 防抖弹出(仅候选非空);浮层打开时 Tab 选词 ──
  cm.on('inputRead', (c: CodeMirror.Editor, change: CodeMirror.EditorChange) => {
    if (change.origin !== '+input') return
    const ch = change.text[0] || ''
    if (!/[\w.]/.test(ch)) return
    if (completionTimer) clearTimeout(completionTimer)
    completionTimer = window.setTimeout(() => {
      // pyspark 用内置单词补全;SQL 用 schema 感知补全(表名/列名/关键字)
      c.showHint({
        completeSingle: false,
        hint: engine.value === 'pyspark' ? CodeMirror.hint.anyword : sqlSchemaHint
      })
    }, 300)
  })
  // Ctrl/Cmd + Enter 执行;Tab 缩进(浮层打开时选词,否则多行逐行缩进);Shift+Tab 反缩进;Ctrl/Cmd + S 保存
  cm.setOption('extraKeys', {
    'Ctrl-Enter': () => {      void runQuery()
    },
    'Cmd-Enter': () => {
      void runQuery()
    },
    'Ctrl-S': () => {
      void saveActive()
    },
    'Cmd-S': () => {
      void saveActive()
    },
    'Ctrl-Space': (c: CodeMirror.Editor) => {
      // pyspark 用内置单词补全;SQL 用 schema 感知补全
      c.showHint({
        completeSingle: false,
        hint: engine.value === 'pyspark' ? CodeMirror.hint.anyword : sqlSchemaHint
      })
    },
    'Cmd-Shift-F': () => {
      formatSql()
    },
    'Ctrl-Shift-F': () => {
      formatSql()
    },
    'Cmd-/': (c: CodeMirror.Editor) => commentSelection(c),
    'Ctrl-/': (c: CodeMirror.Editor) => commentSelection(c),
    Tab: (c: CodeMirror.Editor) => {
      // 补全浮层打开时:交给 show-hint 选词(不要缩进)
      if (c.state.completionActive) return
      const from = c.getCursor('from')
      const to = c.getCursor('to')
      c.operation(() => {
        if (from.line !== to.line) {
          // 多行选中:每行行首插入两个空格(不破坏选中内容)
          for (let l = from.line; l <= to.line; l++) {
            c.replaceRange('  ', { line: l, ch: 0 }, { line: l, ch: 0 })
          }
        } else {
          // 单行/无选中:在光标处插入两个空格
          const cur = c.getCursor()
          c.replaceSelection('  ')
          c.setCursor({ line: cur.line, ch: cur.ch + 2 })
        }
      })
    },
    'Shift-Tab': (c: CodeMirror.Editor) => {
      const from = c.getCursor('from')
      const to = c.getCursor('to')
      c.operation(() => {
        // 每行行首去掉最多两个空格
        for (let l = from.line; l <= to.line; l++) {
          const line = c.getLine(l)
          const lead = line.match(/^ {0,2}/)?.[0].length ?? 0
          if (lead > 0) c.replaceRange('', { line: l, ch: 0 }, { line: l, ch: lead })
        }
      })
    }
  })
}

onMounted(() => {
  void initEditor()
})

onUnmounted(() => {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = undefined
  }
  flushTempDrafts()
  stopSparkLogPolling()
  logResizeObserver?.disconnect()
  logResizeObserver = null
  if (cm) {
    const el = cm.getWrapperElement()
    el.remove()
    cm = null
  }
})

// ── Spark driver 日志透传(执行 spark 查询时轮询展示)───────────
const sparkLogText = ref('')
const sparkLogOffsets = ref<{ jvm: number; audit: number }>({ jvm: 0, audit: 0 })
const sparkLogBox = ref<HTMLElement | null>(null)
/** Spark job/stage 进度(statusTracker,3s 与日志同节奏轮询) */
const sparkStageData = ref<{ activeJobs: Array<{ jobId: number; status: string; stageIds: number[] }>; stages: SparkStage[]; numActiveJobs: number; numActiveStages: number }>({
  activeJobs: [],
  stages: [],
  numActiveJobs: 0,
  numActiveStages: 0
})
function stagePct(s: SparkStage): number {
  return s.numTasks > 0 ? Math.round((s.completedTasks / s.numTasks) * 100) : 0
}
function stageProgressStatus(s: SparkStage): '' | 'success' | 'exception' {
  if (s.status === 'FAILED') return 'exception'
  if (s.status === 'SUCCEEDED') return 'success'
  return ''
}
function stageStatusClass(s: string): string {
  return String(s || 'UNKNOWN').toLowerCase()
}
const maxLogLines = ref(200) // 日志保留行数:按日志容器可视高度动态计算,填满即滚动打印
let sparkLogTimer: number | null = null
let sparkLogSeq = 0 // 查询批次标记:丢弃在途旧轮询响应,防止旧日志污染新查询
let logResizeObserver: ResizeObserver | null = null
const LOG_LINE_HEIGHT = 20 // 12px 字体 × 1.55 行高 ≈ 18.6px,取整留余量

// 日志面板大小变化 → 重算保留行数:可视区能显示多少行就保留多少行(终端式滚动打印),
// 容器被拖高/放大时能看到更多历史,缩小/折叠时自动收敛内存。
function updateMaxLogLines() {
  const el = sparkLogBox.value
  if (!el) return
  const visible = Math.floor((el.clientHeight - 24) / LOG_LINE_HEIGHT) // 减 padding 上下 12px×2
  maxLogLines.value = Math.max(50, Math.min(500, visible))
}

// 引擎日志按布局高度自动贴底滚动:只要日志面板处于激活态,内容增量/切换/挂载后
// 都自动滚到最底部让最新日志始终可见,无需手动拖拽滚动条到底。
// 大块日志追加后 DOM 未就绪时 scrollHeight 是旧值,须等两帧再滚才能精确到底。
function scrollLogToBottom() {
  const el = sparkLogBox.value
  if (!el) return
  void nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (sparkLogBox.value) sparkLogBox.value.scrollTop = sparkLogBox.value.scrollHeight
  })))
}

// 激活日志面板(切回/首次显示)时滚到底,避免面板停在上方需手动下拖
// 用 getter 形式避免在 activePane 声明(见下)之前同步读取导致 TDZ 报错
watch(() => activePane.value, (pane) => {
  if (pane === 0) scrollLogToBottom()
})
// 日志容器挂载(首次渲染)后滚到底,并挂 ResizeObserver 跟踪容器尺寸变化
watch(sparkLogBox, (el) => {
  logResizeObserver?.disconnect()
  logResizeObserver = null
  if (el) {
    updateMaxLogLines()
    logResizeObserver = new ResizeObserver(() => updateMaxLogLines())
    logResizeObserver.observe(el)
    if (activePane.value === 0) scrollLogToBottom()
  }
})
// 日志内容增量/清空/裁剪时跟随最新(仅日志面板激活时)
watch(sparkLogText, () => {
  if (activePane.value === 0) scrollLogToBottom()
})

/** 拉取 spark 日志增量并追加 */
async function pollSparkLogs() {
  const seq = sparkLogSeq
  try {
    const data = await sparkLogs(sparkLogOffsets.value)
    if (seq !== sparkLogSeq) return // 已有新查询/已清空,丢弃过期响应
    if (data.content) {
      sparkLogText.value += data.content
      // 保留行数按日志容器可视高度动态计算:填满当前页面即滚动打印(终端式)
      const lines = sparkLogText.value.split('\n')
      if (lines.length > maxLogLines.value) sparkLogText.value = lines.slice(-maxLogLines.value).join('\n')
    }
    sparkLogOffsets.value = data.offsets
    // spark 引擎:同节奏轮询 job/stage 进度(statusTracker)
    if (engine.value === 'sparksql' || engine.value === 'pyspark') {
      try {
        const st = await sparkStages()
        if (seq === sparkLogSeq) sparkStageData.value = st
      } catch {
        /* stage 接口不可用不影响日志 */
      }
    }
  } catch {
    /* 日志接口失败不打断查询 */
  }
}

function startSparkLogPolling() {
  stopSparkLogPolling()
  activePane.value = 0 // 查询时固定切到第一个 tab(日志)
  void pollSparkLogs()
  sparkLogTimer = window.setInterval(() => void pollSparkLogs(), 3000)
}

function stopSparkLogPolling() {
  if (sparkLogTimer != null) {
    window.clearInterval(sparkLogTimer)
    sparkLogTimer = null
  }
}

function clearSparkLogs() {
  sparkLogSeq++ // 使在途 pollSparkLogs 响应失效
  sparkLogText.value = ''
  sparkLogOffsets.value = { jvm: 0, audit: 0 }
  sparkStageData.value = { activeJobs: [], stages: [], numActiveJobs: 0, numActiveStages: 0 }
}

/** 日志空状态提示:区分执行中/成功/失败,避免“查询成功时面板看起来像收起” */
const logEmptyHint = computed(() => {
  if (engine.value !== 'sparksql' && engine.value !== 'pyspark' && engine.value !== 'flinksql') {
    return '(该引擎不产生引擎日志)'
  }
  if (loading.value) return '(等待引擎输出…)'
  const cur = activePane.value > 0 ? results.value[activePane.value - 1] : null
  if (cur?.error) return '(查询失败,详见结果 tab 错误信息;下方为引擎日志)'
  return '(查询成功,无引擎日志输出)'
})

// 画布高度(可拖拽)
const canvasHeight = ref(280)
const MIN_H = 120
const MAX_H = 560

function onDragStart(e: MouseEvent) {
  const startY = e.clientY
  const startH = canvasHeight.value
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  const onMove = (ev: MouseEvent) => {
    canvasHeight.value = Math.min(MAX_H, Math.max(MIN_H, startH + ev.clientY - startY))
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

/** 当前 SQL 文本 */
function getSql(): string {
  return cm ? cm.getValue() : ''
}

/** 按分号切分 SQL 段(跳过字符串/反引号/注释内的分号) */
function splitSqlSegments(text: string): { start: number; end: number; sql: string }[] {
  const segs: { start: number; end: number; sql: string }[] = []
  let segStart = 0
  let i = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
    } else if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
    } else if (inSingle) {
      if (ch === "'") {
        if (next === "'") i++
        else inSingle = false
      }
    } else if (inDouble) {
      if (ch === '"') inDouble = false
    } else if (inBacktick) {
      // MySQL 反引号标识符(可含分号,如 `a;b`),遇到闭合反引号退出
      if (ch === '`') inBacktick = false
    } else {
      if (ch === '-' && next === '-') {
        inLineComment = true
        i++
      } else if (ch === '/' && next === '*') {
        inBlockComment = true
        i++
      } else if (ch === "'") {
        inSingle = true
      } else if (ch === '"') {
        inDouble = true
      } else if (ch === '`') {
        inBacktick = true
      } else if (ch === ';') {
        segs.push({ start: segStart, end: i + 1, sql: text.slice(segStart, i + 1) })
        segStart = i + 1
      }
    }
    i++
  }
  if (segStart < text.length) {
    segs.push({ start: segStart, end: text.length, sql: text.slice(segStart) })
  }
  return segs
}

/**
 * 待执行内容:优先选中;未选中时 SQL 取光标所在段(分号切分),python 取全文。
 * 找不到段(如全文只有注释)回退全文。
 */
function getSqlToRun(): string {
  if (!cm) return getSql()
  // 1. 有选区 → 执行选中
  const sel = cm.getSelection()
  if (sel.trim()) return sel
  // 2. python 编辑器:无选区执行全文(整段提交,不做分号切分)
  if (engine.value === 'pyspark') return cm.getValue()
  // 3. 无选区 → 光标所在段
  const cursorIdx = cm.indexFromPos(cm.getCursor())
  for (const seg of splitSqlSegments(cm.getValue())) {
    if (seg.start <= cursorIdx && cursorIdx <= seg.end) {
      const s = seg.sql.trim()
      if (s) return s
    }
  }
  return cm.getValue()
}

// ── SQL 格式化(简单:关键字换行缩进;python 模式不支持)─────────────────────────
/** 注释/取消注释选中 SQL(每行前加 -- ) */
function commentSelection(c: CodeMirror.Editor) {
  const sel = c.getSelection()
  c.replaceSelection(`-- ${sel}`, 'end')
}

/** 结果表格签名:表预览用 库.表,否则用 SQL 前 40 字符(列宽按表格持久化) */
function colSig(): string {
  const r = currentResult.value
  if (!r) return 'default'
  const base = `${r.db || ''}.${r.table || ''}`
  return base !== '.' ? base : (r.sql || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'adhoc'
}
/** el-table 初始列宽:优先 localStorage 持久化的宽度 */
function colInitWidth(c: string): number {
  const n = parseInt(localStorage.getItem(`db-query-colw.${colSig()}.${encodeURIComponent(c)}`) || '', 10)
  return n > 60 ? n : 140
}
/** el-table 列宽拖拽结束(header-dragend):持久化到 localStorage */
function onColResize(newWidth: number, column: { property?: string }) {
  if (!column.property) return
  localStorage.setItem(`db-query-colw.${colSig()}.${encodeURIComponent(column.property)}`, String(Math.round(newWidth)))
}
/** JSON 复合值折叠查看(弹窗展示格式化文本) */
async function showJson(v: unknown) {
  const text = JSON.stringify(v, null, 2) ?? String(v)
  await ElMessageBox.alert(`<pre class="dbq-json">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`, '单元格值 (JSON)', {
    dangerouslyUseHTMLString: true,
    customClass: 'dbq-json-dialog'
  }).catch(() => {})
}
const engineLabel = computed(() => {
  const m: Record<string, string> = { mysql: 'MySQL', oracle: 'Oracle', sparksql: 'SparkSQL', pyspark: 'PySpark', flinksql: 'FlinkSQL' }
  return m[engine.value] || engine.value || '—'
})

function formatSql() {
  if (!cm) return
  if (engine.value === 'pyspark') {
    ElMessage.info('Python 模式暂不支持格式化')
    return
  }
  const s = cm.getValue().trim()
  if (!s) return
  // 先屏蔽字符串字面量/注释(替换为占位符),避免关键字误替换破坏字面量内容
  const protectedParts: string[] = []
  const masked = s.replace(
    /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|--[^\n]*|\/\*[\s\S]*?\*\//g,
    (m) => {
      protectedParts.push(m)
      return `\u0000${protectedParts.length - 1}\u0000`
    }
  )
  const keywords = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'UNION', 'FETCH', 'OFFSET']
  let out = masked
  for (const kw of keywords) {
    out = out.replace(new RegExp(`\\b${kw}\\b`, 'gi'), (m: string) => `\n${m.toUpperCase()}`)
  }
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => protectedParts[Number(i)] ?? '')
  cm.setValue(out.replace(/\n{2,}/g, '\n').trim())
}

// ── 查询执行 ─────────────────────────────────────────────────
/** 单元格待提交修改(row 为结果行在 r.rows 中的索引,由 indexOf(row) 得到) */
interface PendingEdit {
  row: number
  col: string
  oldVal: unknown
  newVal: unknown
}

interface QueryResultItem {
  sql: string
  columns: string[]
  rows: Record<string, unknown>[]
  costMs: number
  truncated: boolean
  error?: string
  jobId?: string
  mode?: string
  // ── 行内编辑(仅表预览结果)────────────────────────
  editable?: boolean // 是否允许单元格双击编辑
  db?: string // 目标库(onOpenTable 设置)
  table?: string // 目标表(onOpenTable 设置)
  engine?: string // 方言: 'oracle' | 'mysql'(onOpenTable 设置)
  pkCols?: string[] // 主键列名(异步 listFields(detail) 取 key==='PRI')
  pendingEdits?: PendingEdit[] // 待提交的单元格修改(同 row+col 去重)
  running?: boolean // 执行中(结果 tab 状态点/底部状态栏)
}

const results = ref<QueryResultItem[]>([])
// 结果最多保留多少条(每次执行追加一个新结果 tab,超出裁掉最旧)
const MAX_RESULTS = 20
// 当前激活面板:0 = 日志 tab;1..n = 结果 tab(对应 results[i],pane = i + 1)
const activePane = ref(0)
const currentResult = computed(() => (activePane.value > 0 ? results.value[activePane.value - 1] : null) ?? null)
// 结果表格翻页(默认 15 条/页)
const pageSize = ref(15)
const pageCurrent = ref(1)
const pagedRows = computed(() => {
  const r = currentResult.value
  if (!r) return []
  const start = (pageCurrent.value - 1) * pageSize.value
  return r.rows.slice(start, start + pageSize.value)
})
function selectPane(pane: number) {
  activePane.value = pane
  pageCurrent.value = 1
}

// ── 结果单元格行内编辑(仅表预览结果 editable)──────────────────
// editingCell:当前正在编辑的单元格(row 为 rows 中真实行对象引用,rowIdx 为 indexOf 结果)
const editingCell = ref<{ row: Record<string, unknown>; rowIdx: number; col: string; val: string } | null>(null)

/** 当前结果 tab 是否可编辑(仅表预览且有主键列),供单元格双击提示 */
function isEditableCell(_col: string): boolean {
  const r = currentResult.value
  return !!r && !!r.editable && !!r.pkCols?.length
}

/** 双击单元格进入编辑(值非 null 且当前结果可编辑且有主键;主键列本身不允许改) */
function startCellEdit(row: Record<string, unknown>, col: string) {
  const r = currentResult.value
  if (!r || !r.editable || !r.pkCols?.length) return
  const v = row[col]
  if (v == null) return
  // 主键列拒绝编辑(会破坏 UPDATE 定位)
  if (r.pkCols.some((pk) => pk.toUpperCase() === col.toUpperCase())) {
    ElMessage.warning('主键列不允许编辑')
    return
  }
  const rowIdx = r.rows.indexOf(row)
  if (rowIdx < 0) return
  editingCell.value = { row, rowIdx, col, val: String(v) }
  void nextTick(() => {
    const input = cellEditInputRef.value
    if (input) {
      input.focus()
      input.select()
    }
  })
}

const cellEditInputRef = ref<HTMLInputElement>()

/** 输入更新编辑值(不落盘,失焦才保存) */
function onEditInput() {
  const inp = cellEditInputRef.value
  if (inp && editingCell.value) editingCell.value.val = inp.value
}

/** 失焦保存:值变化则记录到该行所属结果 tab 的 pendingEdits(同 row+col 去重覆盖)。
 *  注意不能用 currentResult —— 用户在编辑中输入后切换结果 tab 会触发 blur,
 *  此时 currentResult 已指向别的结果,须按行对象引用定位原结果 */
function saveCellEdit() {
  const e = editingCell.value
  editingCell.value = null
  if (!e) return
  const r = results.value.find((x) => x.rows.includes(e.row))
  if (!r || !r.editable) return
  const newVal = parseCellValue(e.row[e.col], e.val)
  const oldVal = e.row[e.col]
  if (newVal === oldVal) return // 值未变不记录
  const pending = r.pendingEdits || (r.pendingEdits = [])
  const idx = pending.findIndex((p) => p.row === e.rowIdx && p.col === e.col)
  const edit = { row: e.rowIdx, col: e.col, oldVal, newVal }
  if (idx >= 0) pending[idx] = edit
  else pending.push(edit)
  // 本地立即反映新值(供后续再次编辑/提交取主键值)
  e.row[e.col] = newVal
}

/** Esc 取消编辑 */
function cancelCellEdit() {
  editingCell.value = null
}

/** 输入文本按原值类型还原(number 尽量转数值,其余保持字符串) */
function parseCellValue(oldVal: unknown, raw: string): unknown {
  if (typeof oldVal === 'number') {
    const n = Number(raw)
    return Number.isNaN(n) ? raw : n
  }
  if (typeof oldVal === 'boolean') return raw === 'true'
  return raw
}

/** SQL 字面量:数字/布尔/null 原样,字符串/日期用单引号并转义 '' */
function sqlLiteral(v: unknown): string {
  if (v == null) return 'NULL'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  // MySQL/Doris 字符串字面量中反斜杠是转义符:先转义 \ 再转义 ' (Oracle 无反斜杠语义,双写无害)
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

/** HTML 转义(确认弹窗展示完整 SQL 用) */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 按 row 分组生成 UPDATE 语句数组(每条单语句;MySQL 反引号 / Oracle 双引号;主键列取当前行内值) */
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
    const sets = edits.map((p) => {
      // 列名可能大小写与 rows 键不一致(如 Oracle),按大小写不敏感定位实际键
      const key = findRowKey(row, p.col)
      return `${q(key)} = ${sqlLiteral(p.newVal)}`
    }).join(', ')
    // 主键 WHERE:取该行主键列当前行内值(主键列禁止编辑故不受修改影响)
    const wheres = r.pkCols.map((pk) => {
      const key = findRowKey(row, pk)
      return `${q(key)} = ${sqlLiteral(row[key])}`
    }).filter(Boolean)
    if (!wheres.length) continue
    stmts.push(`UPDATE ${tbl} SET ${sets} WHERE ${wheres.join(' AND ')}`)
  }
  return stmts
}

/** 在 row 中按大小写不敏感查找列名对应的键(找不到返回原列名) */
function findRowKey(row: Record<string, unknown>, col: string): string {
  if (col in row) return col
  const upper = col.toUpperCase()
  const hit = Object.keys(row).find((k) => k.toUpperCase() === upper)
  return hit || col
}

/** 提交修改:确认完整 SQL → 确保解锁 → queryDb 逐条执行 → 清空并自动重查 */
async function commitEdits() {
  const r = currentResult.value
  if (!r || !r.editable || !r.pendingEdits?.length) return
  const stmts = buildUpdateSql(r)
  if (!stmts.length) {
    ElMessage.warning('没有可提交的修改(主键列无法定位)')
    return
  }
  // 展示完整 SQL 供确认
  let confirmed = false
  try {
    await ElMessageBox.confirm(
      `<pre class="edit-sql-preview">${escapeHtml(stmts.join('\n'))}</pre>`,
      `确认提交 ${r.pendingEdits.length} 处修改?`,
      { dangerouslyUseHTMLString: true, confirmButtonText: '确认提交', cancelButtonText: '取消', type: 'warning' }
    )
    confirmed = true
  } catch {
    /* 取消 */
  }
  if (!confirmed) return
  loading.value = true // 提交期间互斥,防用户同时执行新查询导致 rerunResult 竞态
  try {
    // 逐条执行(网关/db-proxy 单语句语义,不支持分号拼接多语句)
    for (const sql of stmts) {
      await queryDb(r.db || db.value, sql)
    }
    ElMessage.success(`已提交 ${r.pendingEdits.length} 处修改`)
    r.pendingEdits = []
    // 自动重查:重新执行原预览 SQL(复用 execOne 直接刷新该结果 tab,不打断编辑器)
    await rerunResult(r)
  } catch (e) {
    ElMessage.error(`提交失败:${e instanceof Error ? e.message : e}`)
  } finally {
    loading.value = false
  }
}

/** 重新执行某结果 tab 对应的原 SQL(提交修改后自动重查)。
 *  直接走 execDb(预览 SQL 必为 mysql/oracle SELECT,无需经过 engine 分支判定;
 *  临时切 db 到结果记录的库,执行后恢复,避免 watch(engine) 干扰) */
async function rerunResult(r: QueryResultItem) {
  const idx = results.value.indexOf(r)
  if (idx < 0) return
  const seq = ++runSeq
  batchCancelled = false
  loading.value = true
  const savedDb = db.value
  if (r.db) db.value = r.db
  try {
    let res
    try {
      res = await execDb(r.sql)
    } catch (e) {
      if (seq === runSeq) {
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
    if (seq !== runSeq) return
    // 保留编辑元数据,清空待提交修改
    results.value[idx] = { ...results.value[idx], sql: r.sql, ...res, pendingEdits: [], running: false }
    if (seq === runSeq) activePane.value = idx + 1
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
  if (!cm) return ''
  const sel = cm.getSelection().trim()
  if (sel) return sel
  const segs = splitSqlSegments(cm.getValue()).map((s) => s.sql.trim()).filter(Boolean)
  return segs[0] || ''
}

/** 执行计划节点 → 展示文本(表名/访问方式 + rows/cost 等统计) */
function explainNodeLabel(n: ExplainNode | null | undefined): string {
  if (!n) return ''
  const parts: string[] = []
  const op = String(n.operation || n.name || '').trim()
  if (op) parts.push(op)
  const obj = String(n.object_name || '').trim()
  if (obj && obj !== op) parts.push(obj)
  if (n.access_type) parts.push(String(n.access_type))
  const stats: string[] = []
  if (n.rows != null) stats.push(`rows=${n.rows}`)
  if (n.filtered != null) stats.push(`filtered=${n.filtered}`)
  if (n.cost != null) stats.push(`cost=${n.cost}`)
  if (n.extra) stats.push(String(n.extra))
  return [...parts, ...stats].join(' ')
}

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
  const sql = getExplainSql()
  if (!sql) {
    ElMessage.warning('没有可分析的 SQL(请选中或输入语句)')
    return
  }
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

// ── Schema 补全缓存(按 db 缓存表+列元数据,首次补全时按需拉取)──
interface SchemaMeta {
  tables: Array<{ name: string; comment?: string; columns: Array<{ name: string; type?: string }> }>
}
const schemaCache = new Map<string, SchemaMeta>()

/** 取 db 的 schema 元数据(缓存命中直接返回,未命中调 getSchema) */
async function ensureSchema(dbName: string): Promise<SchemaMeta | null> {
  const hit = schemaCache.get(dbName)
  if (hit) return hit
  try {
    const data = await getSchema(dbName)
    const meta: SchemaMeta = { tables: data.tables || [] }
    schemaCache.set(dbName, meta)
    return meta
  } catch {
    return null // 拉取失败静默,仅无补全
  }
}

/** 常用 SQL 关键字(补全候选) */
const SQL_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'INSERT', 'UPDATE', 'DELETE', 'SET', 'VALUES', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'IS', 'BETWEEN', 'LIKE']

/** 自定义 SQL 补全:表名 + 列名(含 tbl.col 点语法)+ 常用关键字 */
async function sqlSchemaHint(cm: CodeMirror.Editor): Promise<CodeMirror.Hints | null> {
  const dbName = db.value
  if (!dbName) return null
  const meta = await ensureSchema(dbName)
  if (!meta) return null
  const cur = cm.getCursor()
  const before = cm.getLine(cur.line).slice(0, cur.ch)
  // 光标前标识符:支持 `表名.列名`(点号前后各一段)
  const m = before.match(/([A-Za-z0-9_$]+(\.[A-Za-z0-9_$]*)?)$/)
  if (!m) return null
  const full = m[1]
  const dotIdx = full.lastIndexOf('.')
  let list: string[] = []
  let fromCh: number
  if (dotIdx >= 0) {
    const tbl = full.slice(0, dotIdx)
    const colPrefix = full.slice(dotIdx + 1).toLowerCase()
    const t = meta.tables.find((x) => x.name.toLowerCase() === tbl.toLowerCase())
    if (!t) return null
    list = t.columns.filter((c) => c.name.toLowerCase().startsWith(colPrefix)).map((c) => c.name)
    fromCh = cur.ch - (full.length - dotIdx - 1)
  } else {
    const prefix = full.toLowerCase()
    list = meta.tables.map((t) => t.name).filter((n) => n.toLowerCase().startsWith(prefix))
    list.push(...SQL_KEYWORDS.filter((k) => k.toLowerCase().startsWith(prefix)))
    fromCh = cur.ch - full.length
  }
  if (!list.length) return null
  return { list: Array.from(new Set(list)), from: { line: cur.line, ch: fromCh }, to: cur }
}

// ── Flink 流批模式与弹窗 ────────────────────────────────────
const flinkMode = ref<'batch' | 'stream'>('batch')
const showFlinkConn = ref(false)
const showFlinkJobs = ref(false)
const showFlinkPreJob = ref(false)

/** 连接器弹窗生成 DDL → 插入编辑器(多段用空行分隔) */
function onInsertFlinkDdl(ddls: string[]) {
  const c = cm
  if (!c || !ddls.length) return
  const text = ddls.join('\n\n')
  const cur = c.getCursor()
  c.replaceRange(text, cur)
  c.setCursor({ line: cur.line, ch: cur.ch + text.length })
  c.focus()
  ElMessage.success(`已插入 ${ddls.length} 条 CREATE TABLE`)
}

/** Flink 执行:所有 flink 任务都要解锁(与 Spark 共用同一密码/token);
 *  未解锁先弹密码框;token 过期(网关 403)自动重新解锁后重试一次 */
async function execFlink(sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean }> {
  // 写权限密码验证已移除(网关库权限矩阵管控),直接执行
  return queryFlink(sql, flinkMode.value)
}

/** MySQL/Oracle 执行:写语句需解锁(与 Spark 共用密码);只读直接执行。
 *  token 过期(网关 403)自动重新解锁后重试一次 */
/** 执行前确保已选库:下拉有源但 db 未选中(如引擎切换/初始化时序)时自动取该引擎第一个源 */
function ensureDb(): boolean {
  if (db.value) return true
  const candidates = filteredDbs.value
  db.value = candidates.find((d) => d.type === engine.value)?.name || candidates[0]?.name || ''
  return !!db.value
}

/** 当前 mysql/oracle 异步任务的 jobId(供停止按钮取消) */
const currentDbJobId = ref('')

/** mysql/oracle 执行:异步任务模式 —— 提交即返回 jobId,前端轮询。
 *  前端体验与同步一致:持续 loading 阻塞,直到完成/失败/手动停止。
 *  动机:慢查询/大查询同步挂起会撞公司网关 60s 超时 504。 */
async function execDb(sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean }> {
  if (!ensureDb()) throw new Error('请先选择数据库')
  const run = async (): Promise<{ columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean }> => {
    const { jobId: jid } = await submitDbJob(db.value, sql, 3600000)
    currentDbJobId.value = jid
    const deadline = Date.now() + 3600000 // 上限 1 小时
    while (Date.now() < deadline) {
      if (batchCancelled) {
        try {
          await cancelDbJob(jid)
        } catch {
          /* 忽略 */
        }
        throw new Error('已取消')
      }
      const j = await getDbJob(jid)
      if (j.state === 'done') {
        currentDbJobId.value = ''
        return j.result as { columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean }
      }
      if (j.state === 'cancelled') {
        currentDbJobId.value = ''
        throw new Error('已取消')
      }
      if (j.state === 'failed') {
        currentDbJobId.value = ''
        throw new Error(j.error || '任务执行失败')
      }
      await new Promise((r) => setTimeout(r, 3000)) // 3s 轮询(低频)
    }
    try {
      await cancelDbJob(jid)
    } catch {
      /* 忽略 */
    }
    currentDbJobId.value = ''
    throw new Error('任务超时(1 小时),已自动取消')
  }
  try {
    return await run()
  } catch (e) {
    // 写权限密码验证已移除,不再有解锁重试;错误直接上抛(库未授权/资源护栏等)
    throw e
  }
}

/** 执行单条 SQL 并记录结果;seq 为批次号,停止后旧批次在途结果丢弃,避免覆盖新批 */
async function execOne(sql: string, item: QueryResultItem, seq: number): Promise<void> {
  const isSpark = engine.value === 'sparksql' || engine.value === 'pyspark'
  const isFlink = engine.value === 'flinksql'
  const kind = engine.value === 'pyspark' ? ('pyspark' as const) : ('sql' as const)
  if (isSpark) {
    clearSparkLogs()
    startSparkLogPolling()
  }
  try {
    let r
    if (isFlink) r = await execFlink(sql)
    else if (isSpark) r = await execSpark(sql, kind)
    else r = await execDb(sql)
    if (seq !== runSeq) return // 旧批次已失效,丢弃结果
    // 执行成功 → 写入历史(任务钩子:trim 非空且 ≤2000,同 sql 去重保最新,上限 50)
    pushHistory(sql)
    // 追加模式下 item 是新 push 的结果对象,直接用最新结果覆盖它(不保留旧 editable 元数据;
    // 表预览的可编辑标记由 onOpenTable 在执行成功后对最新结果设置)
    const idx = results.value.indexOf(item)
    if (idx < 0) return // 已被裁剪(结果超上限删旧),丢弃
    results.value[idx] = { sql, ...r, running: false }
  } catch (e) {
    if (seq !== runSeq) return
    const idx = results.value.indexOf(item)
    if (idx < 0) return
    results.value[idx] = {
      sql,
      columns: [],
      rows: [],
      costMs: 0,
      truncated: false,
      running: false,
      error: e instanceof Error ? e.message : String(e)
    }
  } finally {
    // 仅本批次仍有效时才停日志轮询(否则会停掉新批次的轮询)
    if (isSpark && seq === runSeq) stopSparkLogPolling()
  }
}

/** 拆 SQL 段并过滤空段/纯注释段 */
function getSegments(text: string): string[] {
  return splitSqlSegments(text)
    .map((s) => s.sql.trim())
    .filter((s) => s && !/^\s*(--|\/\*)/.test(s))
}

/** 批量执行互斥:同一次「执行」点击为一个批次;批内多条按 FIFO 逐条串行。
 *  每人同时最多提交一批 —— 执行中再次点击执行会被拒绝(loading 互斥)。
 *  batchCancelled:停止按钮置位,中断本批剩余段。
 *  runSeq:批次号,停止/新执行使旧批次在途结果与日志失效。 */
let batchCancelled = false
let runSeq = 0

/** 历史记录 key 与容量(SqlTreePanel 历史/收藏共用) */
const HISTORY_KEY = 'db-query-history'
const HISTORY_MAX = 20

/** 执行成功后写入历史:新在前、同 sql 去重(保留最新)、上限 20 循环缓存(超出删最旧)、仅 trim 非空且 ≤2000 */
function pushHistory(sql: string) {
  const s = String(sql ?? '').trim()
  if (!s || s.length > 2000) return
  try {
    let list: Array<{ ts: number; sql: string }> = []
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) list = parsed.filter((h) => h && typeof h.sql === 'string' && typeof h.ts === 'number')
      }
    } catch {
      /* 历史数据损坏则忽略,重新开始 */
    }
    list = list.filter((h) => h.sql !== s)
    list.unshift({ ts: Date.now(), sql: s })
    if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list))
  } catch {
    /* localStorage 不可用(Safari 隐私模式等)时静默忽略 */
  }
}

/** 执行目标 SQL 段列表(逐条 FIFO 串行执行;每次执行结果追加为新 tab,整体最多保留 MAX_RESULTS 个) */
async function execSegments(segs: string[], seq: number) {
  // 追加新结果段:不复用旧 tab,每个查询独立一个新结果(最多 20 个,超出裁掉最旧的)
  const items = segs.map((sql) => ({
    sql, columns: [], rows: [], costMs: 0, truncated: false, running: true
  })) as QueryResultItem[]
  results.value.push(...items)
  if (results.value.length > MAX_RESULTS) {
    results.value.splice(0, results.value.length - MAX_RESULTS)
  }
  for (let i = 0; i < segs.length; i++) {
    if (batchCancelled) {
      // 中断剩余段:标记为已停止(不保持 running 死转)
      for (const it of items.slice(i)) {
        const idx = results.value.indexOf(it)
        if (idx >= 0) results.value[idx] = { ...results.value[idx], running: false, error: '已停止' }
      }
      break
    }
    await execOne(segs[i], items[i], seq)
  }
  // 默认展示最后一个 tab(最新执行的结果;日志 tab 恒为第一个)
  if (seq === runSeq && results.value.length) activePane.value = results.value.length
}

/** 执行(选中内容 / 光标段;选中内容含多条时逐条执行;python 整段执行) */
async function runQuery() {
  // 每人同时最多提交一批:上一批未结束则拒绝新批(FIFO 排队由批内逐条完成)
  if (loading.value) {
    ElMessage.warning('上一批 SQL 仍在执行,请等待完成后再提交')
    return
  }
  batchCancelled = false
  const seq = ++runSeq // 新批次号:使上一批(如被停止)的在途结果失效
  if (!ensureDb()) {
    ElMessage.warning('请先选择数据库')
    return
  }
  const target = getSqlToRun().trim()
  if (!target) {
    ElMessage.warning('请输入 SQL')
    return
  }
  // python 编辑器整段执行(分号是 python 合法语句分隔符,不能切段)
  if (engine.value === 'pyspark') {
    loading.value = true
    error.value = ''
    try {
      const item = { sql: target, columns: [], rows: [], costMs: 0, truncated: false, running: true } as QueryResultItem
      results.value.push(item)
      if (results.value.length > MAX_RESULTS) {
        results.value.splice(0, results.value.length - MAX_RESULTS)
      }
      await execOne(target, item, seq)
      if (seq === runSeq) activePane.value = results.value.indexOf(item) + 1
    } finally {
      loading.value = false
    }
    return
  }
  // 目标内容按分号拆段:选中多段/一段都逐条执行
  const segs = getSegments(target)
  if (!segs.length) {
    ElMessage.warning('没有可执行的 SQL')
    return
  }
  loading.value = true
  error.value = ''
  try {
    await execSegments(segs, seq)
  } finally {
    loading.value = false
  }
}

/** 停止当前查询:中断本批剩余段(前端不再发后续 SQL),并尝试取消引擎 job */
async function stopQuery() {
  batchCancelled = true
  runSeq++ // 使当前批次在途结果/日志失效,防止旧批覆盖停止后新执行的批次
  try {
    if (engine.value === 'flinksql') {
      await cancelFlink()
    } else if (engine.value === 'sparksql' || engine.value === 'pyspark') {
      // 异步任务:优先精确取消当前 job,再兜底取消引擎当前 job group
      if (currentSparkJobId.value) {
        try {
          await cancelSparkJob(currentSparkJobId.value)
        } catch {
          /* 忽略 */
        }
      }
      await cancelSpark()
    } else if (currentDbJobId.value) {
      // mysql/oracle 异步任务:精确取消当前 job(查询可能仍在后台跑,结果丢弃)
      try {
        await cancelDbJob(currentDbJobId.value)
      } catch {
        /* 忽略 */
      }
    }
    // mysql/oracle(无 job 时)置位后批循环自行停止
    // 停止日志轮询,立即释放 loading 状态
    stopSparkLogPolling()
    loading.value = false
    ElMessage.info('已请求停止,当前批剩余 SQL 不再执行')
  } catch (e) {
    ElMessage.error(`停止失败:${e instanceof Error ? e.message : e}`)
  }
}

// ── 数据导出(CSV,含 BOM 防 Excel 乱码)──────────────────────
function exportCsv(idx?: number) {
  const r = idx != null ? results.value[idx] : results.value[0]
  if (!r || r.error || !r.columns.length) {
    ElMessage.warning('没有可导出的数据')
    return
  }
  const esc = (v: unknown) => {
    let s = v == null ? '' : String(v)
    // 防 Excel 公式注入:以 = + - @ 或制表/回车开头的单元格前缀单引号
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = r.columns.map(esc).join(',')
  const lines = r.rows.map((row) => r.columns.map((c) => esc(row[c])).join(','))
  const csv = '\uFEFF' + [header, ...lines].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  const suffix = results.value.length > 1 ? `_${(idx ?? 0) + 1}` : ''
  a.download = `${db.value || 'query'}${suffix}_${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

// ── 单元格/列名点击复制 ────────────────────────────────────
// 统一走带降级的 copyText,规避 HTTP 非安全上下文下 navigator.clipboard 不可用导致的复制失败
async function copyCell(val: unknown) {
  const ok = await copyText(val)
  if (ok) ElMessage.success('已复制')
  else ElMessage.warning('复制失败,请手动选择复制')
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
})

watch(engine, async (val) => {
  // 写权限密码验证已移除,切换引擎不再要求解锁
  if (!val) return
  const first = filteredDbs.value.find((d) => d.type === val)
  db.value = first?.name || ''
  if (cm) {
    // python 编辑器切换为 python 模式,其余为 SQL 模式
    cm.setOption('mode', val === 'pyspark' ? 'text/x-python' : 'text/x-sql')
    cm.refresh()
  }
})

/** 单元格是否数值(右对齐) */
function isNumeric(val: unknown): boolean {
  return typeof val === 'number' || (typeof val === 'string' && val !== '' && !Number.isNaN(Number(val)))
}

/** 某列是否数值列(按该页首行判定,用于表头/单元格对齐) */
function colIsNumeric(c: string): boolean {
  const row = pagedRows.value[0]
  return !!(row && row[c] != null && isNumeric(row[c]))
}

// ── 结果表格交互:复制/选择模式 + 复制整表 ───────────────────
/** 复制模式开=true(点击单元格即复制);关=false 时点击不劫持,可用鼠标选中文本 */
const cellCopy = ref(true)
const cellCopyDisabled = computed(() => !cellCopy.value)

/** 单元格/列名点击复制(复制模式关时直接忽略,避免与文本选择冲突) */
async function copyCellSmart(val: unknown) {
  if (!cellCopy.value) return
  await copyCell(val)
}

/** 行记录转 TSV(带表头;null 输出空串) */
function rowsToTsv(rows: Record<string, unknown>[], cols: string[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    // 含制表符/换行的字段用双引号包围并转义,防止破坏 TSV 结构
    return /[\t\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const head = cols.map(esc).join('\t')
  const body = rows.map((row) => cols.map((c) => esc(row[c])).join('\t')).join('\n')
  return head + '\n' + body
}

/** 复制当前分页 */
async function copyPageTsv() {
  const r = currentResult.value
  if (!r) return
  const ok = await copyText(rowsToTsv(pagedRows.value, r.columns))
  if (ok) ElMessage.success('已复制当前页(TSV)')
  else ElMessage.error('复制失败,请手动复制')
}

/** 复制全量结果(忽略分页;大结果集注意体积) */
async function copyAllTsv() {
  const r = currentResult.value
  if (!r) return
  if (r.rows.length > 5000) {
    const confirmed = await ElMessageBox.confirm(
      '共 ' + r.rows.length + ' 行,复制全部可能较大。仍要继续吗?', '复制整表',
      { confirmButtonText: '继续复制', cancelButtonText: '取消', type: 'warning' }
    ).catch(() => false)
    if (!confirmed) return
  }
  const ok = await copyText(rowsToTsv(r.rows, r.columns))
  if (ok) ElMessage.success('已复制 ' + r.rows.length + ' 行(TSV)')
  else ElMessage.error('复制失败,请手动复制')
}
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
        <el-tooltip content="流任务管理" placement="top"><el-button size="small" :icon="VideoPause" @click="showFlinkJobs = true" /></el-tooltip>
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

    <!-- SQL 画布(CodeMirror) -->
    <div ref="canvasRef" class="sql-canvas" :class="themeMode" :style="{ height: canvasHeight + 'px' }">
      <div ref="cmRef" class="sql-editor" :style="{ '--cm-font-size': fontSize + 'px' }"></div>
    </div>

    <!-- 拖拽分割条 -->
    <div class="sql-dragbar" @mousedown="onDragStart">
      <span class="drag-dots">⠿</span>
    </div>
    <div class="sql-hint">
      <span>Ctrl/Cmd + Enter 执行</span>
      <span>· Tab 缩进</span>
      <span>· Ctrl/Cmd + Space 补全</span>
      <span>· 拖拽分割条调整画布高度</span>
    </div>

    <!-- 错误提示 -->
    <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" class="err-alert" />

    <!-- 结果区(第一个 tab 固定日志 + 结果 tab 依次;查询中切日志,成功切最新结果) -->
    <div v-if="results.length" class="results-wrap">
      <!-- 上方横向 tab 栏 -->
      <div class="result-tabs">
        <!-- 第一个 tab 固定:日志(只保留最近一次查询的日志) -->
        <div class="result-tab log-tab" :class="{ active: activePane === 0 }" @click="selectPane(0)">
          <el-icon class="tab-log-icon"><DocumentChecked /></el-icon>
          <span class="tab-name">日志</span>
          <span v-if="sparkLogText" class="tab-dot" title="有日志输出" />
        </div>
        <!-- 结果 tab(每个查询一个,依次折叠) -->
        <div
          v-for="(r, idx) in results"
          :key="idx"
          class="result-tab"
          :class="{ active: activePane === idx + 1 }"
          @click="selectPane(idx + 1)"
        >
          <el-icon v-if="r.running" class="tab-state tab-spin"><Loading /></el-icon>
          <span v-else class="tab-state" :class="r.error ? 'tab-err' : r.truncated ? 'tab-trunc' : 'tab-ok'" />
          <span class="tab-name" :class="{ err: r.error }">query{{ idx + 1 }}</span>
          <el-tooltip v-if="!r.error" content="导出 CSV" placement="top">
            <span class="tab-export" @click.stop="exportCsv(idx)">
              <el-icon><Download /></el-icon>
            </span>
          </el-tooltip>
        </div>
      </div>
      <!-- 下方当前面板内容 -->
      <div class="result-content">
        <!-- 日志面板(第一个 tab) -->
        <template v-if="activePane === 0">
          <div class="result-card log-card">
            <div class="spark-logs-head">
              <span class="spark-logs-title"><el-icon><DocumentChecked /></el-icon> 引擎日志(最近一次查询)</span>
              <span class="spark-logs-actions">
                <el-button text size="small" @click="void pollSparkLogs()">刷新</el-button>
                <el-button text size="small" @click="clearSparkLogs">清空</el-button>
              </span>
            </div>
            <div v-if="sparkStageData.stages.length" class="spark-stages">
              <div class="spark-stages-head">
                <span class="spark-stages-title">Stage 进度</span>
                <span v-if="sparkStageData.numActiveJobs" class="spark-stages-meta">
                  {{ sparkStageData.numActiveJobs }} 个活跃 Job · {{ sparkStageData.numActiveStages }} 个活跃 Stage
                </span>
              </div>
              <div v-for="s in sparkStageData.stages" :key="s.stageId" class="spark-stage">
                <div class="spark-stage-line">
                  <span class="spark-stage-id">Stage {{ s.stageId }}</span>
                  <span class="spark-stage-name" :title="s.name">{{ s.name }}</span>
                  <span class="spark-stage-status" :class="stageStatusClass(s.status)">{{ s.status }}</span>
                  <span class="spark-stage-count">{{ s.completedTasks }}/{{ s.numTasks }} tasks</span>
                </div>
                <el-progress
                  :percentage="stagePct(s)"
                  :show-text="false"
                  :stroke-width="5"
                  :status="stageProgressStatus(s)"
                />
              </div>
            </div>
            <pre ref="sparkLogBox" class="spark-logs-body">{{ sparkLogText || logEmptyHint }}</pre>
          </div>
        </template>
        <!-- 结果内容 -->
        <template v-else-if="currentResult">
          <el-alert v-if="currentResult.error" type="error" :title="currentResult.error" show-icon :closable="false" class="err-alert" />
          <div v-else class="result-card">
            <div v-loading="loading" class="result-table-wrap">
              <el-table :data="pagedRows" border stripe size="small" class="result-table" empty-text="无数据" :row-class-name="() => cellCopyDisabled ? 'row-selectable' : ''" @header-dragend="onColResize">
              <el-table-column type="index" label="#" width="56" align="center" fixed="left" />
              <el-table-column
                v-for="c in currentResult.columns"
                :key="c"
                :prop="c"
                :label="c"
                :width="colInitWidth(c)"
                sortable
                :align="colIsNumeric(c) ? 'right' : 'left'"
                show-overflow-tooltip
              >
                <!-- 表头:点击列名复制列名(.stop 不触发排序);排序只点最右侧排序箭头触发 -->
                <template #header>
                  <span
                    class="col-header"
                    :title="`点击复制列名: ${c}`"
                    @click.stop="copyCellSmart(c)"
                  >{{ c }}</span>
                </template>
                <template #default="{ row }">
                  <span v-if="editingCell && editingCell.row === row && editingCell.col === c" class="cell-edit">
                    <input
                      ref="cellEditInputRef"
                      :value="editingCell.val"
                      class="cell-edit-input"
                      spellcheck="false"
                      @input="onEditInput"
                      @blur="saveCellEdit"
                      @keydown.esc.prevent="cancelCellEdit"
                      @keydown.enter.prevent="saveCellEdit"
                    />
                  </span>
                  <span
                    v-else-if="row[c] == null"
                    class="cell-null"
                    :title="`NULL${cellCopy ? ' · 点击复制' : ''}`"
                    @click="copyCellSmart(row[c])"
                  >NULL</span>
                  <span
                    v-else-if="typeof row[c] === 'object'"
                    class="cell-json"
                    title="点击查看完整 JSON"
                    @click.stop="showJson(row[c])"
                  >JSON</span>
                  <span
                    v-else
                    class="cell-val"
                    :class="{ 'cell-num': isNumeric(row[c]), 'cell-select': cellCopyDisabled, 'cell-editable': isEditableCell(c) }"
                    :title="isEditableCell(c) ? `双击编辑: ${row[c]}` : (cellCopy ? `点击复制: ${row[c]}` : row[c])"
                    @click="copyCellSmart(row[c])"
                    @dblclick="startCellEdit(row, c)"
                  >{{ row[c] }}</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <!-- 翻页(紧贴数据集下方) -->
          <el-pagination
            v-if="currentResult.rows.length > pageSize"
            v-model:current-page="pageCurrent"
            v-model:page-size="pageSize"
            class="result-pagination"
            :page-sizes="[15, 50, 100, 200]"
            :total="currentResult.rows.length"
            layout="total, sizes, prev, pager, next"
            small
          />
          <!-- 底部信息条:统计 + 复制 + 选择模式(最底部) -->
          <div class="result-toolbar">
            <span class="stats">
              <template v-if="currentResult.error">{{ currentResult.error }}</template>
              <template v-else-if="currentResult.jobId">
                <span class="footer-job">流式任务已提交</span>
                <span class="footer-muted">· 任务在后台常驻运行,可在「流任务」面板停止</span>
              </template>
              <template v-else>
                <span class="stats-num">{{ currentResult.rows.length }} 行</span>
                <span class="stats-num">{{ currentResult.columns.length }} 列</span>
                <template v-if="currentResult.truncated"><span class="footer-muted">(已截断)</span></template>
                <span class="footer-muted">· {{ currentResult.costMs }}ms</span>
              </template>
            </span>
            <span class="tools">
              <label class="mode-toggle" :class="{ on: cellCopy }" :title="cellCopy ? '点击单元格即复制' : '可自由选中文本(关闭点击复制)'">
                <el-switch v-model="cellCopy" size="small" />
                <span>{{ cellCopy ? '复制模式' : '选择模式' }}</span>
              </label>
              <el-button
                v-if="currentResult.editable && (currentResult.pendingEdits?.length ?? 0) > 0"
                size="small"
                type="warning"
                plain
                @click="commitEdits"
              >提交修改 ({{ currentResult.pendingEdits?.length ?? 0 }})</el-button>
              <el-button v-if="currentResult.jobId" size="small" text type="primary" @click="showFlinkJobs = true">查看状态</el-button>
              <el-tag v-if="currentResult.jobId" size="small" type="primary">{{ currentResult.jobId }}</el-tag>
              <el-button :disabled="cellCopyDisabled" size="small" text type="primary" @click="copyPageTsv"><el-icon><Grid /></el-icon>复制本页</el-button>
              <el-button :disabled="cellCopyDisabled" size="small" text type="primary" @click="copyAllTsv"><el-icon><CopyDocument /></el-icon>复制整表</el-button>
            </span>
          </div>
            </div>
        </template>
      </div>
    </div>

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
      <span class="sb-item">{{ themeMode === 'dark' ? '深色' : '浅色' }}主题</span>
    </div>
  </div>

  <!-- Flink 连接器批量建表弹窗 -->
  <FlinkConnectorDialog v-model="showFlinkConn" @insert="onInsertFlinkDdl" />

  <!-- Flink 流式任务管理弹窗 -->
  <FlinkJobsDialog v-model="showFlinkJobs" />

  <!-- Flink PreJob 提交/管理弹窗 -->
  <FlinkPreJobDialog v-model="showFlinkPreJob" />

  <!-- EXPLAIN 执行计划面板 -->
  <el-dialog
    v-model="showExplain"
    title="EXPLAIN 执行计划"
    width="720px"
    :close-on-click-modal="false"
    append-to-body
  >
    <div v-loading="explainLoading" class="explain-body">
      <el-alert v-if="explainError" type="error" :title="explainError" show-icon :closable="false" class="explain-error" />
      <template v-else-if="explainTree">
        <el-tree
          :data="[explainTree]"
          :props="{ label: 'operation', children: 'children' }"
          default-expand-all
          :expand-on-click-node="false"
          class="explain-tree"
        >
          <template #default="{ data }">
            <span class="explain-node">{{ explainNodeLabel(data) }}</span>
          </template>
        </el-tree>
      </template>
      <template v-else-if="explainTable">
        <el-table :data="explainTable.rows" border size="small" max-height="420" class="explain-table">
          <el-table-column v-for="c in explainTable.columns" :key="c" :prop="c" :label="c" min-width="140" />
        </el-table>
      </template>
      <el-empty v-else-if="!explainLoading" description="暂无执行计划" />
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
.db-query {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  box-sizing: border-box;
  overflow: auto;
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

/* ── SQL 画布(CodeMirror) ────────────────────────────────── */
.sql-canvas {
  position: relative;
  display: flex;
  background: #34373c;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;

  &.light {
    background: #f7f8fa;
  }
}

.sql-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;

  /* CodeMirror 公共(字体由 --cm-font-size 控制) */
  :deep(.CodeMirror) {
    flex: 1;
    width: 100%;
    height: 100%;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: var(--cm-font-size, 15px);
    line-height: 1.6;
  }

  :deep(.CodeMirror-scroll) {
    width: 100%;
    height: 100%;
    overflow: auto;
  }

  :deep(.CodeMirror-linenumber) {
    font-size: var(--cm-font-size, 15px);
    padding: 0 8px 0 4px;
  }

  :deep(.CodeMirror-cursor) {
    border-left: 2px solid;
  }

  :deep(.CodeMirror-selected) {
    background: rgba(97, 175, 239, 0.25);
  }

  :deep(.CodeMirror-activeline-background) {
    background: rgba(97, 175, 239, 0.08);
  }

  :deep(.cm-matchingbracket) {
    font-weight: 700;
    background: rgba(229, 192, 123, 0.2);
    border-radius: 2px;
  }

  :deep(.bracket-match) {
    background: rgba(229, 192, 123, 0.35);
    border-radius: 2px;
  }

  /* 语法 token 公共字体 */
  :deep(.cm-keyword),
  :deep(.cm-string),
  :deep(.cm-comment),
  :deep(.cm-number),
  :deep(.cm-builtin),
  :deep(.cm-variable),
  :deep(.cm-operator) {
    font-size: var(--cm-font-size, 15px);
  }

  /* ── 深色主题(柔和深灰蓝) ───────────────────────────── */
  .sql-canvas.dark & {
    :deep(.CodeMirror) {
      background: #34373c;
      color: #c8ccd4;
    }
    :deep(.CodeMirror-gutters) {
      background: #2e3135;
      border-right: 1px solid #26292d;
    }
    :deep(.CodeMirror-linenumber) {
      color: #7a818c;
    }
    :deep(.CodeMirror-cursor) {
      border-left-color: #e6e8ec;
    }
    :deep(.cm-keyword) {
      color: #d19a66;
      font-weight: 600;
    }
    :deep(.cm-string) {
      color: #98c379;
    }
    :deep(.cm-comment) {
      color: #7a818c;
      font-style: italic;
    }
    :deep(.cm-number) {
      color: #61afef;
    }
    :deep(.cm-builtin) {
      color: #56b6c2;
    }
    :deep(.cm-variable) {
      color: #e06c75;
    }
    :deep(.cm-operator) {
      color: #56b6c2;
    }
    :deep(.cm-matchingbracket) {
      color: #e5c07b;
    }
  }

  /* ── 浅色主题(柔和米白) ─────────────────────────────── */
  .sql-canvas.light & {
    :deep(.CodeMirror) {
      background: #f7f8fa;
      color: #3a3f45;
    }
    :deep(.CodeMirror-gutters) {
      background: #eceff2;
      border-right: 1px solid #dde1e5;
    }
    :deep(.CodeMirror-linenumber) {
      color: #8a9199;
    }
    :deep(.CodeMirror-cursor) {
      border-left-color: #3a3f45;
    }
    :deep(.CodeMirror-selected) {
      background: rgba(9, 105, 218, 0.15);
    }
    :deep(.CodeMirror-activeline-background) {
      background: rgba(9, 105, 218, 0.05);
    }
    :deep(.cm-keyword) {
      color: #c2185b;
      font-weight: 600;
    }
    :deep(.cm-string) {
      color: #0a5f5f;
    }
    :deep(.cm-comment) {
      color: #8a9199;
      font-style: italic;
    }
    :deep(.cm-number) {
      color: #0b4f8a;
    }
    :deep(.cm-builtin) {
      color: #6f42c1;
    }
    :deep(.cm-variable) {
      color: #953800;
    }
    :deep(.cm-operator) {
      color: #0b4f8a;
    }
    :deep(.cm-matchingbracket) {
      color: #c2185b;
    }
  }
}

/* 自动补全提示框:跟随主题配色(CodeMirror-hints 是 body 级,用全局选择器) */
:global(.CodeMirror-hints) {
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  font-size: 13px;
}

:global(.CodeMirror-hint) {
  padding: 4px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
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

.sql-hint {
  font-size: 12px;
  color: $muted;
  flex-shrink: 0;
  display: flex;
  gap: 4px;
}

.err-alert {
  flex-shrink: 0;
}

/* ── 结果区(左侧竖 tab + 右侧内容) ────────────────────────── */
.results-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 200px;
  flex-shrink: 0;
  min-width: 0;
}

.result-tabs {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0;
  overflow-x: auto;
  flex-shrink: 0;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 2px 4px;
}

.result-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  color: $muted;
  /* 相邻 tab 分隔线 */
  border-right: 1px solid $border;

  &:last-child {
    border-right: none;
  }

  &:hover {
    color: $text;
  }

  &.active {
    color: $primary;
    font-weight: 600;
  }
}

.tab-name {
  font-size: 12px;

  &.err {
    color: #f56c6c;
  }
}

.tab-export {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  color: $muted;
  cursor: pointer;

  &:hover {
    color: $primary;
  }
}

/* 日志 tab(第一个固定 tab) */
.log-tab {
  gap: 4px;

  .tab-log-icon {
    font-size: 13px;
    color: $muted;
  }

  &.active .tab-log-icon {
    color: $primary;
  }
}

/* 日志 tab 有内容时的圆点 */
.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: $primary;
  flex-shrink: 0;
}

.result-content {
  flex: 1;
  min-width: 0;
  min-height: 0; /* 关键:允许在 .results-wrap 高度内收缩,否则日志/结果会撑高整页 */
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 结果区整体卡片:表格 + 底部工具条 + 翻页 合成一个整体,消除三张独立卡片的分割感 */
.result-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  overflow: hidden;
}

.result-table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.result-table {
  width: 100%;

  :deep(th.el-table__cell) {
    position: sticky;
    top: 0;
    z-index: 1;
  }

  /* 表头:点击列名复制列名(仅占自身文本宽,左侧点击复制、右侧排序箭头仍可点击排序) */
  :deep(.col-header) {
    display: inline-flex;
    align-items: center;
    cursor: copy;
    min-width: 0;
    max-width: calc(100% - 22px); /* 给右侧排序箭头留出可点击区 */
    padding-right: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    &:hover {
      color: $primary;
      text-decoration: underline dotted;
    }
  }
  /* 排序箭头保持在最右侧,作为唯一排序入口 */
  :deep(.caret-wrapper) {
    right: 6px;
  }

  /* NULL 单元格:低饱和胶囊,醒目但不过度突出 */
  :deep(.cell-null) {
    display: inline-block;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 11px;
    line-height: 16px;
    letter-spacing: 0.4px;
    color: $muted;
    background: var(--el-fill-color-light);
    cursor: pointer;
    user-select: none;
  }

  :deep(.cell-val) {
    cursor: pointer;

    &:hover {
      color: $primary;
    }
  }

  /* 选择模式:取消点击复制光标,允许自由选中文本 */
  :deep(.cell-select) {
    cursor: text;
    user-select: text;

    &:hover {
      color: $text;
    }
  }

  :deep(.cell-num) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }

  /* 可编辑单元格(表预览且有主键):悬停提示可双击编辑 */
  :deep(.cell-editable) {
    cursor: cell;

    &:hover {
      background: var(--el-color-warning-light-9);
    }
  }

  /* 编辑态输入框(双击进入) */
  :deep(.cell-edit) {
    display: inline-flex;
    width: 100%;
  }

  .cell-edit-input {
    width: 100%;
    box-sizing: border-box;
    padding: 2px 6px;
    font: inherit;
    font-size: 12px;
    color: $text;
    border: 1px solid $primary;
    border-radius: 4px;
    outline: none;
    background: #fff;
  }
}

/* 选择模式整行:可选中 */
:deep(.row-selectable .cell) {
  cursor: text;
  user-select: text;
}

/* 结果工具条:统计(左)+ 复制/模式开关(右) */
.result-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  background: $panel;
  border-top: 1px solid $border;
  padding: 6px 12px;
  font-size: 12px;
  color: $muted;
  flex-shrink: 0;
}

.stats {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stats-num {
  color: $text;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.tools {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;

  span:last-child {
    font-size: 12px;
    color: $muted;
  }

  &.on span:last-child {
    color: $primary;
  }
}

.footer-muted {
  color: $muted;
}

.footer-job {
  font-weight: 600;
  color: $primary;
}

.flink-mode {
  margin-right: 4px;
}

.result-pagination {
  display: flex;
  justify-content: flex-end;
  background: $panel;
  border-top: 1px solid $border;
  padding: 6px 12px;
  flex-shrink: 0;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ── 结果 tab 运行状态点 ─────────────────────────────────── */
.tab-state {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;

  &.tab-ok {
    background: #67c23a;
  }

  &.tab-err {
    background: #f56c6c;
  }

  &.tab-trunc {
    background: #e6a23c;
  }
}

.tab-spin {
  animation: dbq-spin 1s linear infinite;
  color: $primary;
}

@keyframes dbq-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
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
.spark-logs-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.spark-logs-actions {
  display: flex;
  align-items: center;
}
/* ── Spark Stage 进度(日志面板顶部) ────────────────────────── */
.spark-stages {
  border-bottom: 1px solid $border;
  padding: 8px 14px;
  max-height: 200px;
  overflow: auto;

  .spark-stages-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;

    .spark-stages-title {
      font-size: 12px;
      font-weight: 600;
      color: $text;
    }

    .spark-stages-meta {
      font-size: 11px;
      color: $muted;
    }
  }

  .spark-stage {
    margin-bottom: 6px;

    &:last-child {
      margin-bottom: 0;
    }
  }

  .spark-stage-line {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    margin-bottom: 2px;

    .spark-stage-id {
      color: $primary;
      font-weight: 600;
      flex-shrink: 0;
    }

    .spark-stage-name {
      color: $text;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .spark-stage-status {
      flex-shrink: 0;
      font-size: 10px;
      padding: 0 5px;
      border-radius: 3px;
      color: $muted;
      background: var(--el-fill-color-light);

      &.running {
        color: $primary;
        background: rgba(64, 158, 255, 0.12);
      }

      &.succeeded {
        color: #67c23a;
        background: rgba(103, 194, 58, 0.12);
      }

      &.failed {
        color: #f56c6c;
        background: rgba(245, 108, 108, 0.12);
      }
    }

    .spark-stage-count {
      color: $muted;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }
  }
}

.spark-logs-body {
  flex: 1;
  min-height: 0; /* 关键:日志容器按布局高度收缩并在内部滚动,而不是撑高整页 */
  margin: 0;
  padding: 10px 14px;
  overflow: auto;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
}

/* ── EXPLAIN 面板 ─────────────────────────────────────── */
.explain-body {
  max-height: 520px;
  overflow: auto;
}

.explain-error {
  margin-bottom: 0;
}

.explain-tree {
  font-size: 12px;

  :deep(.el-tree-node__content) {
    height: auto;
    min-height: 28px;
    padding: 2px 0;
  }
}

.explain-node {
  display: inline-block;
  padding: 2px 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}

.explain-table {
  width: 100%;
}

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
