<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/store/auth'
import { CaretRight, Loading, MagicStick, DocumentChecked, Document, Plus, Close, VideoPause, Promotion, Download } from '@element-plus/icons-vue'
import SqlEditor from './SqlEditor.vue'
import QueryResults, { type QueryResultItem } from './QueryResults.vue'
import { format as sqlFormat, type SqlLanguage } from 'sql-formatter'
import { listDataSources, queryFlink, cancelFlink, flinkAsyncSubmit, flinkAsyncStatus, flinkAsyncCancel, sparkLogs, sparkStages, submitSparkJob, submitSparkExportJob, getSparkJob, cancelSparkJob, submitDbJob, getDbJob, cancelDbJob, saveScriptContent, getScriptContent, createScriptNode, getSchema, listSparkTables, listSparkFields, explainSql, listFields, type SparkExecutionMode, type SparkStageSnapshot, type DbDataSource, type DbSchema, type ScriptNode, type TableFieldDetail, type ExplainNode } from '@/api/db'
import { getTheme, THEME_EVENT, type ThemeMode } from '@/utils/theme'
import { hasExecutableSql } from '@/utils/sql-query-comments.js'
import SqlTreePanel from './SqlTreePanel.vue'
const treePanelRef = ref<InstanceType<typeof SqlTreePanel>>()
import FlinkConnectorDialog from './FlinkConnectorDialog.vue'
import FlinkPreJobDialog from './FlinkPreJobDialog.vue'

defineOptions({ name: 'DbQueryView' })

// ── 状态 ─────────────────────────────────────────────────────
const datasources = ref<DbDataSource[]>([])
const engine = ref<'mysql' | 'oracle' | 'impala' | 'sparksql' | 'sparksession' | 'flinksql' | ''>('')
const db = ref('')
const loading = ref(false)
const exportLoading = ref(false)
const error = ref('')
const isSparkEngine = computed(() => engine.value === 'sparksql' || engine.value === 'sparksession')
const sparkExecutionMode = computed<SparkExecutionMode>(() => engine.value === 'sparksession' ? 'session' : 'thrift')
const sparkBatchActive = ref(false)
watch(sparkExecutionMode, () => {
  stopSparkLogPolling()
  sparkLogSeq++
  sparkLogText.value = ''
  sparkLogOffsets.value = { jvm: 0, audit: 0 }
  sparkLogFileSizes.value = { jvm: 0, audit: 0 }
  sparkStageSnapshot.value = null
})

// 写权限密码验证已移除(由网关库权限矩阵管控 + 数据源 readOnly 兜底),以下直接执行

/** 当前 Spark 异步任务及提交时模式(供停止按钮精确取消) */
const currentSparkJob = ref<{ jobId: string; executionMode: SparkExecutionMode } | null>(null)

/** Spark 执行:异步任务模式 —— 提交即返回 jobId,前端轮询结果。
 *  动机:公司网关固定 60s 读超时,同步长请求(大查询可能跑数十分钟/小时)
 *  必被掐断 504;异步化后提交/查状态都是秒级往返,永不撞超时。
 *  SQL 按提交时的执行模式异步执行,门户轮询状态。 */
async function execSpark(sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean; hdfsPath?: string }> {
  const executionMode = sparkExecutionMode.value
  const { jobId } = await submitSparkJob(sql, undefined, 7200000, executionMode)
  currentSparkJob.value = { jobId, executionMode }
  try {
    const deadline = Date.now() + 7200000 // 上限 2 小时
    while (Date.now() < deadline) {
      if (batchCancelled) {
        await cancelSparkJob(jobId, executionMode).catch(() => undefined)
        throw new Error('已取消')
      }
      const j = await getSparkJob(jobId, executionMode)
      if (j.state === 'done') return j.result as { columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean; hdfsPath?: string }
      if (j.state === 'failed') throw new Error(j.error || '任务执行失败')
      if (j.state === 'cancelled') throw new Error('已取消')
      await new Promise((r) => setTimeout(r, 3000))
    }
    await cancelSparkJob(jobId, executionMode).catch(() => undefined)
    throw new Error('任务超时(2 小时),已自动取消')
  } finally {
    if (currentSparkJob.value?.jobId === jobId) currentSparkJob.value = null
  }
}

/** 导出当前 SparkSQL 语句到 HDFS；结果集不经过 driver collect，也不创建表格结果 tab。 */
async function exportSparkResult() {
  if (loading.value || exportLoading.value || sparkBatchActive.value) return
  if (!isSparkEngine.value) return
  if (!ensureDb()) {
    ElMessage.warning('请先选择数据库')
    return
  }
  const rawSql = getSqlToRun().trim()
  if (!rawSql) {
    ElMessage.warning('请输入 SQL')
    return
  }
  const sql = expandSqlVars(rawSql, collectRunVars(rawSql))
  batchCancelled = false
  exportLoading.value = true
  loading.value = true
  error.value = ''
  const executionMode = sparkExecutionMode.value
  try {
    await clearSparkLogs()
    if (batchCancelled) return
    startSparkLogPolling()
    const { jobId } = await submitSparkExportJob(db.value, sql, 7200000, executionMode)
    currentSparkJob.value = { jobId, executionMode }
    const deadline = Date.now() + 7200000
    while (Date.now() < deadline) {
      if (batchCancelled) {
        await cancelSparkJob(jobId, executionMode).catch(() => undefined)
        throw new Error('已取消')
      }
      const job = await getSparkJob(jobId, executionMode)
      if (job.state === 'done') {
        const path = job.result?.hdfsPath
        if (!path) throw new Error('导出任务完成，但未返回 HDFS 路径')
        await ElMessageBox.alert(path, 'HDFS 导出完成', { confirmButtonText: '关闭' })
        return
      }
      if (job.state === 'failed') throw new Error(job.error || 'HDFS 导出失败')
      if (job.state === 'cancelled') throw new Error('已取消')
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
    await cancelSparkJob(jobId, executionMode).catch(() => undefined)
    throw new Error('导出超时(2 小时)，已请求取消')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (message !== '已取消') {
      error.value = message
      ElMessage.error(message)
    }
  } finally {
    await pollSparkLogs()
    stopSparkLogPolling()
    currentSparkJob.value = null
    exportLoading.value = false
    loading.value = false
  }
}

// ── 多文件 tab(最多 10 个)──────────────────────────────────
const MAX_TABS = 10
interface EditorTab {
  id: string
  file: ScriptNode | null // 绑定的文件;null = 未命名查询
  name: string
  content: string // 内容快照(自动保存/草稿用;编辑实时内容在 SqlEditor 的 model 池里)
  dirty: boolean
  // 文档对象由 SqlEditor 内部 model 池持有(每个 tab 一个 ITextModel:
  // 独立撤销历史 + 光标位置,语义等价旧 CodeMirror.Doc + swapDoc)
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

/** 把 tab 设为当前编辑目标:确保其 Monaco model 已存在(内容以池内为准,等价旧 swapDoc) */
function showTabInEditor(t: EditorTab) {
  editorRef.value?.ensureModel(t.id, t.content)
  syncRunVarBar() // setModel 不触发 change 事件,参数行需按新文档内容重建
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
  // 仅当该 tab 仍是活跃 tab 时才读编辑器实时内容;否则用切换时已写回的快照。
  // 否则迟到的防抖定时器会把别的 tab 内容存进本 tab,覆盖磁盘上的原文件!
  if (activeTab.value === tab) tab.content = editorRef.value?.getValue() ?? tab.content
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
  if (t) t.content = editorRef.value?.getValue() ?? ''
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
  }
  editorRef.value?.focus()
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
  editorRef.value?.focus()
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
  editorRef.value?.focus()
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
      dirty: false
    }
    tabs.value.push(tab)
    activeTabId.value = tab.id
    showTabInEditor(tab)
    ElMessage.success(`已打开 ${node.name}`)
    editorRef.value?.focus()
  } catch (e) {
    ElMessage.error(`打开失败:${e instanceof Error ? e.message : e}`)
  }
}

/** 表目录点击 → 在光标处插入表名/字段名 */
function onInsert(text: string) {
  const c = editorRef.value
  if (!c) return
  const cur = c.getCursor()
  c.replaceRange(text, cur)
  c.setCursor({ line: cur.line, ch: cur.ch + text.length })
  c.focus()
}

/** 历史/收藏条目点击(SqlTreePanel runSql 事件):历史是缓存,只回填编辑器不自动执行;
 *  有结果快照时直接开一个「缓存」结果 tab 免重查展示 */
function onRunHistorySql(sql: string, result?: { columns: string[]; rows: Record<string, unknown>[] }) {
  const c = editorRef.value
  if (!c) return
  const s = String(sql || '')
  if (!s.trim()) return
  // silent:程序性回填不标记 dirty、不触发自动保存(否则 2s 后会把原文件覆盖成历史 SQL)
  c.setValue(s, { silent: true })
  syncRunVarBar() // 抑制 change 事件,参数行需手动同步
  c.focus()
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
async function onOpenTable(payload: { db: string; table: string; engine?: string }) {
  const isSpark = payload.engine === 'spark'
  if (isSpark && (loading.value || sparkBatchActive.value)) {
    ElMessage.warning('上一批 SQL 仍在执行,预览已取消,请等待完成')
    return
  }
  if (tabs.value.length >= MAX_TABS) {
    ElMessage.warning(`最多同时打开 ${MAX_TABS} 个 tab,请先关闭部分 tab`)
    return
  }
  const src = datasources.value.find((d) => d.name === payload.db)
  const isOracle = !isSpark && src?.type === 'oracle'
  const isImpala = src?.type === 'impala'
  // 引擎与库切到预览目标(Oracle 用 FETCH FIRST,MySQL/Impala 用 LIMIT)
  engine.value = isSpark ? (engine.value === 'sparksession' ? 'sparksession' : 'sparksql') : isOracle ? 'oracle' : isImpala ? 'impala' : 'mysql'
  db.value = isSpark ? SPARK_SOURCE.name : payload.db
  const sparkIdent = (value: string) => '`' + value.replace(/`/g, '``') + '`'
  const ident = isSpark ? `${sparkIdent(payload.db)}.${sparkIdent(payload.table)}` : isOracle ? `"${payload.table}"` : `\`${payload.table}\``
  const sql = isOracle ? `SELECT * FROM ${ident} FETCH FIRST 100 ROWS ONLY` : `SELECT * FROM ${ident} LIMIT 100`
  const tabId = `${isSpark ? 'spark-' : ''}tbl-${payload.db}.${payload.table}`
  const existing = tabs.value.find((t) => t.id === tabId)
  flushActiveContent()
  if (existing) {
    switchTab(existing.id)
  } else {
    const tab: EditorTab = {
      id: tabId,
      file: null,
      name: `${payload.db}.${payload.table}`,
      content: sql,
      dirty: false
    }
    tabs.value.push(tab)
    activeTabId.value = tab.id
    showTabInEditor(tab)
  }
  // 上一批仍在执行时预览会被 runQuery 拒绝;先提示,不污染编辑器内容
  if (loading.value) {
    ElMessage.warning('上一批 SQL 仍在执行,预览已取消,请等待完成')
    return
  }
  // silent 覆盖预览 tab 内容(不标记 dirty;预览 tab 无文件,避免误触发草稿保存)
  editorRef.value?.setValue(sql, { silent: true })
  await runQuery()
  // 预览结果标记为可编辑(行内编辑),并异步取主键列;校验 SQL 匹配防误标旧结果(runQuery 可能因互斥被拒)
  const r = results.value[results.value.length - 1]
  if (!isSpark && r && !r.error && r.sql.trim() === sql.trim()) {
    r.editable = !isImpala
    r.db = payload.db
    r.table = payload.table
    r.engine = isImpala ? 'impala' : isOracle ? 'oracle' : 'mysql'
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
      await saveScriptContent(tab.file.id, editorRef.value?.getValue() ?? '')
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
    await saveScriptContent(node.id, editorRef.value?.getValue() ?? '')
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
const SPARK_SESSION_SOURCE: DbDataSource = { ...SPARK_SOURCE, label: 'SparkSession', type: 'sparksession' }
// FlinkSQL 虚拟数据源(走 db-proxy → Flink SQL Gateway)
const FLINK_SOURCE: DbDataSource = { name: 'flink', label: 'FlinkSQL', type: 'flinksql', host: '', port: 0, user: '' }

// SparkSQL、SparkSession、FlinkSQL 为虚拟源,不进左侧树
const filteredDbs = computed(() => {
  if (engine.value === 'sparksql') return [SPARK_SOURCE]
  if (engine.value === 'sparksession') return [SPARK_SESSION_SOURCE]
  if (engine.value === 'flinksql') return [FLINK_SOURCE]
  return engine.value ? datasources.value.filter((d) => d.type === engine.value) : datasources.value
})

// 库下拉占位:区分「没选引擎」「加载失败」「该引擎无库」三种空状态,避免用户对着禁用框猜测
const dbPlaceholder = computed(() => {
  // 先报加载失败:此时引擎/库都是空的,提示「请先选择引擎」会误导用户
  if (datasourceError.value) return '数据源不可用'
  if (!engine.value) return '请先选择引擎'
  if (!filteredDbs.value.length) return '该引擎无可用库'
  return '选择数据库'
})

// 左侧树排除 spark/flink 虚拟源(db-proxy 无此库,拉表会报错)
const treeDbs = computed(() => datasources.value.filter((d) => d.type !== 'sparksql' && d.type !== 'sparksession' && d.type !== 'flinksql'))

// ── Monaco 编辑器(SqlEditor 封装)─────────────────────────────────────
const canvasRef = ref<HTMLElement>()
// 编辑器实例(SqlEditor 封装;model 池在组件内部,tab 切换仅换 modelId,撤销/光标各自独立)
const editorRef = ref<InstanceType<typeof SqlEditor>>()
// 补全元数据:关系库全量 schema;Spark 按所选模式加载指定库的表或指定表的字段
const schemaLoader = async (db: string, table?: string, executionMode: SparkExecutionMode = sparkExecutionMode.value): Promise<DbSchema | null> => {
  if (!isSparkEngine.value) return getSchema(db)
  if (table) return { tables: [{ name: table, columns: await listSparkFields(db, table, executionMode) }] }
  return { tables: (await listSparkTables(db, executionMode)).map((name) => ({ name, columns: [] })) }
}

// 默认 SQL:清空(用户自行编写);编辑器默认内容由 SqlEditor 的 :value/model 池提供
// 画布主题跟随全局主题(单一口径):门户切深浅色时画布同步,
// 画布按钮也直接切全局主题,不再维护第二套 localStorage 键。
const themeMode = ref<ThemeMode>(getTheme())

function onGlobalThemeChange(event: Event) {
  themeMode.value = (event as CustomEvent<ThemeMode>).detail
}

// 字体大小(px),默认 15(比原 13 大 2),持久化
const FONT_KEY = 'db-query-fontsize'
const fontSize = ref(parseInt(localStorage.getItem(FONT_KEY) || '15', 10) || 15)
const MIN_FONT = 11
const MAX_FONT = 24

function adjustFont(delta: number) {
  fontSize.value = Math.min(MAX_FONT, Math.max(MIN_FONT, fontSize.value + delta))
  localStorage.setItem(FONT_KEY, String(fontSize.value))
}

// ── 编辑器事件(SqlEditor 组件回调;补全/快捷键/主题均在组件内,这里只留业务联动)──
/** 内容变更:同步快照/dirty + 参数行 + 防抖自动保存(等价旧 cm.on('change'))。
 *  Monaco setModel 切换 tab 不触发 change,参数行重建在 showTabInEditor 里做。 */
function onEditorChange() {
  const t = activeTab.value
  // 一次性取全文:参数行同步 + 快照共用(避免每键 getValue 两次)
  const v = editorRef.value?.getValue() ?? ''
  syncRunVarBar(v)
  if (t) {
    t.dirty = true
    t.content = v
    scheduleAutoSave(t)
  }
}

/** SqlEditor 挂载就绪:焦点给编辑器(首个 tab 内容已随 modelId 创建,无需 setValue) */
function onEditorReady() {
  editorRef.value?.focus()
}

onUnmounted(() => {
  window.removeEventListener(THEME_EVENT, onGlobalThemeChange)
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = undefined
  }
  flushTempDrafts()
  stopSparkLogPolling()
  logResizeObserver?.disconnect()
  logResizeObserver = null
})

// ── Spark 所选执行模式日志(执行 Spark SQL 时轮询展示)───────────
const sparkLogText = ref('')
const sparkStageSnapshot = ref<SparkStageSnapshot | null>(null)
const sparkStageSummary = computed(() => {
  if (sparkExecutionMode.value === 'thrift') return 'Stage 状态不可用 (Thrift)'
  const snapshot = sparkStageSnapshot.value
  if (!snapshot || snapshot.error) return 'Stage 状态暂不可用'
  if (!snapshot.stages.length) return '暂无 Stage'
  return `Stage ${snapshot.numActiveStages} 运行中 · ` + snapshot.stages.slice(-4)
    .map((stage) => `#${stage.stageId} ${stage.status} ${stage.completedTasks}/${stage.numTasks}`).join(' · ')
})
const dbJobLogText = ref('')
const sparkLogOffsets = ref<{ jvm: number; audit: number }>({ jvm: 0, audit: 0 })
const sparkLogBox = ref<HTMLElement | null>(null)
const maxLogLines = ref(200) // 日志保留行数:按日志容器可视高度动态计算,填满即滚动打印
let sparkLogTimer: number | null = null
let sparkLogSeq = 0 // 查询批次标记:丢弃在途旧轮询响应,防止旧日志污染新查询
const sparkLogFileSizes = ref<{ jvm: number; audit: number }>({ jvm: 0, audit: 0 }) // 最近一次 poll 返回的文件大小,clear 时作为新基线
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
watch(dbJobLogText, () => {
  if (activePane.value === 0) scrollLogToBottom()
})

/** 拉取 spark 日志增量并追加(基线由 clearSparkLogs 在查询开始前建立,这里读到的都是新增) */
async function pollSparkLogs() {
  const seq = sparkLogSeq
  const executionMode = sparkExecutionMode.value
  const [logs, stages] = await Promise.allSettled([
    sparkLogs(sparkLogOffsets.value, executionMode),
    sparkStages(executionMode)
  ])
  if (seq !== sparkLogSeq) return
  sparkStageSnapshot.value = stages.status === 'fulfilled' ? stages.value : null
  if (logs.status === 'fulfilled') {
    const data = logs.value
    sparkLogFileSizes.value = data.files
    if (data.content) {
      sparkLogText.value += data.content
      const lines = sparkLogText.value.split('\n')
      if (lines.length > maxLogLines.value) sparkLogText.value = lines.slice(-maxLogLines.value).join('\n')
    }
    sparkLogOffsets.value = data.offsets
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

/** 清空并建立新基线:offset 跳到已知文件末尾,新查询只展示新增日志。
 *  会话首次(未知文件大小)先探一次拿到当前大小,避免读到既有历史日志。 */
async function clearSparkLogs() {
  const seq = ++sparkLogSeq // 使在途 pollSparkLogs 响应失效
  const executionMode = sparkExecutionMode.value
  sparkStageSnapshot.value = null
  sparkLogText.value = ''
  if (sparkLogFileSizes.value.jvm === 0 && sparkLogFileSizes.value.audit === 0) {
    try {
      const base = await sparkLogs({ jvm: 0, audit: 0 }, executionMode)
      if (seq !== sparkLogSeq) return
      sparkLogFileSizes.value = base.files
    } catch {
      /* 探基线失败则沿用 {0,0},代价是本次会读到历史日志 */
    }
  }
  if (seq === sparkLogSeq) sparkLogOffsets.value = { ...sparkLogFileSizes.value }
}

function clearDbJobLogs() {
  dbJobLogText.value = ''
}

/** 日志空状态提示:区分执行中/成功/失败,避免“查询成功时面板看起来像收起” */
const logEmptyHint = computed(() => {
  if (engine.value === 'impala') return loading.value ? '(等待 db-proxy 执行日志…)': '(Impala 本次查询暂无日志)'
  if (!isSparkEngine.value && engine.value !== 'flinksql') {
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
// 没有结果时画布占满内容区:首屏写 SQL 的空间翻倍,执行出结果后再按可拖拽高度分屏
const canvasStyle = computed(() => (results.value.length ? { height: `${canvasHeight.value}px` } : {}))

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

/** 当前 SQL 文本 */
function getSql(): string {
  return editorRef.value ? editorRef.value.getValue() : ''
}

/** 按分号切分 SQL 段(跳过字符串/反引号/注释/q-引号内的分号) */
function isOraclePlsqlBlock(text: string): boolean {
  return /^\s*(?:DECLARE\b|BEGIN\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER)\b)/i.test(text)
}

function splitSqlSegments(text: string): { start: number; end: number; sql: string }[] {
  const segs: { start: number; end: number; sql: string }[] = []
  const oraclePlsql = engine.value === 'oracle' && isOraclePlsqlBlock(text)
  let plsqlStarted = false
  let plsqlDepth = 0
  let segStart = 0
  let i = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false
  // Oracle q'[x]' / q'{x}' / q'(x)' / q'<x>' 引用(分隔符配对的字面量,内部分号不切段)
  const Q_CLOSER: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' }
  let inQQuote = false
  let qCloser: string | null = null
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
    } else if (inQQuote) {
      // q'[ ... ]' :遇 闭合分隔符 + 单引号 退出
      if (qCloser && ch === qCloser && next === "'") {
        inQQuote = false
        qCloser = null
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
      } else if (ch === '#') {
        inLineComment = true // MySQL 行注释(# 到行尾;分号不切段)
      } else if (ch === '/' && next === '*') {
        inBlockComment = true
        i++
      } else if ((ch === 'q' || ch === 'Q') && next === "'" && text[i + 2] in Q_CLOSER) {
        inQQuote = true
        qCloser = Q_CLOSER[text[i + 2]]
        i += 2 // 跳过 q'<分隔符,进入 q-引号状态
      } else if (ch === "'") {
        inSingle = true
      } else if (ch === '"') {
        inDouble = true
      } else if (ch === '`') {
        inBacktick = true
      } else if (oraclePlsql && /[A-Za-z_]/.test(ch)) {
        const wordEnd = i + 1
        let end = wordEnd
        while (end < text.length && /[A-Za-z0-9_$#]/.test(text[end])) end++
        const word = text.slice(i, end).toUpperCase()
        if (word === 'BEGIN') {
          plsqlStarted = true
          plsqlDepth++
        } else if (word === 'END') {
          const nextWord = text.slice(end).match(/^\s*([A-Za-z_][A-Za-z0-9_$#]*)/)?.[1]?.toUpperCase()
          if (!['IF', 'CASE', 'LOOP'].includes(nextWord || '')) plsqlDepth = Math.max(0, plsqlDepth - 1)
        }
        i = end - 1
      } else if (ch === ';') {
        if (!oraclePlsql || (plsqlStarted && plsqlDepth === 0)) {
          segs.push({ start: segStart, end: i + 1, sql: text.slice(segStart, i + 1) })
          segStart = i + 1
          plsqlStarted = false
          plsqlDepth = 0
        }
      }
    }
    i++
  }
  if (segStart < text.length) {
    segs.push({ start: segStart, end: text.length, sql: text.slice(segStart) })
  }
  if (oraclePlsql) {
    // SQL*Plus 用独立的 `/` 行提交 PL/SQL 块;它不是 Oracle SQL 语法,不能传给 oracledb。
    for (let index = 0; index < segs.length; index++) {
      const seg = segs[index]
      if (/^\s*\/\s*$/.test(seg.sql) && index > 0) {
        segs[index - 1].end = seg.end
        segs.splice(index, 1)
        index--
      } else {
        seg.sql = seg.sql.replace(/\r?\n\s*\/\s*$/, '')
      }
    }
  }
  return segs
}

/**
 * 待执行内容:优先选中;未选中时取光标所在 SQL 段(分号切分)。
 * 找不到段(如全文只有注释)回退全文。
 */
function getSqlToRun(): string {
  if (!editorRef.value) return getSql()
  // 1. 有选区 → 执行选中
  const sel = editorRef.value.getSelection()
  if (sel.trim()) return sel
  // 2. 无选区 → 光标所在段
  const cursorIdx = editorRef.value.indexFromPos(editorRef.value.getCursor())
  for (const seg of splitSqlSegments(editorRef.value.getValue())) {
    if (seg.start <= cursorIdx && cursorIdx <= seg.end) {
      const s = seg.sql.trim()
      if (s) return s
    }
  }
  return editorRef.value.getValue()
}

// ── SQL 格式化(简单:关键字换行缩进)─────────────────────────
// 注释/取消注释(Cmd+/)已下沉到 SqlEditor 组件内实现,与旧 commentSelection 等价。


/** JSON 复合值折叠查看(弹窗展示格式化文本) */

const engineLabel = computed(() => {
  const m: Record<string, string> = { mysql: 'MySQL', oracle: 'Oracle', impala: 'Impala', sparksql: 'SparkSQL', sparksession: 'SparkSession', flinksql: 'FlinkSQL' }
  return m[engine.value] || engine.value || '—'
})

/** 自研关键字换行格式化(sql-formatter 失败时的降级;屏蔽字符串/注释避免污染) */
function legacyFormatSql(s: string): string {
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
  return out.replace(/\n{2,}/g, '\n').trim()
}

/** 格式化:SQl-formatter(方言感知/tabWidth/关键字大小写/查询间空行);失败降级自研 */
function formatSql() {
  if (!editorRef.value) return
  const s = editorRef.value.getValue().trim()
  if (!s) return
  try {
    // 方言:Oracle 在 sql-formatter 中为 plsql、spark 覆盖 sparksql/flinksql;Impala 用兼容的 MySQL 格式化降级
    const lang: SqlLanguage =
      engine.value === 'oracle' ? 'plsql' : isSparkEngine.value || engine.value === 'flinksql' ? 'spark' : 'mysql'
    // ${var} 非标准 token,先占位保护(防 sql-formatter 拆散/转义);格式化后还原
    const varNames: string[] = []
    const masked = s.replace(/\$\{[A-Za-z_][A-Za-z0-9_-]*\}/g, (m) => {
      varNames.push(m)
      return `__portal_var_${varNames.length - 1}__`
    })
    const out = sqlFormat(masked, { language: lang, tabWidth: 2, keywordCase: 'upper', linesBetweenQueries: 1 })
    const restored = out.replace(/__portal_var_(\d+)__/g, (_m: string, i: string) => varNames[Number(i)] ?? '')
    editorRef.value?.setValue(restored)
  } catch {
    editorRef.value?.setValue(legacyFormatSql(s))
  }
}

// ── 查询执行 ─────────────────────────────────────────────────

const results = ref<QueryResultItem[]>([])
// 结果最多保留多少条(每次执行追加一个新结果 tab,超出裁掉最旧)
const MAX_RESULTS = 20
// 当前激活面板:0 = 日志 tab;1..n = 结果 tab(对应 results[i],pane = i + 1)
const activePane = ref(0)
const currentResult = computed(() => (activePane.value > 0 ? results.value[activePane.value - 1] : null) ?? null)
// 激活日志面板(切回/首次显示)时滚到底,避免面板停在上方需手动下拖。
// 注意:必须在 activePane 声明之后定义,watch 创建时会立即同步读取源 getter,
// 若放在 activePane 之前会因 const 的 TDZ 报 "Cannot access before initialization"。
watch(() => activePane.value, (pane) => {
  if (pane === 0) scrollLogToBottom()
})
function selectPane(pane: number) {
  activePane.value = pane // 翻页重置由 QueryResults 内部处理
}

/** 关闭某个结果 tab(从 results 移除;日志 tab 恒为第 0 个不可关) */
function closeResultTab(idx: number) {
  if (idx < 0 || idx >= results.value.length) return
  results.value.splice(idx, 1)
  // 修正当前激活 pane:关闭的是当前面板 → 落到相邻(优先前一个)结果;无结果则回日志
  if (activePane.value === idx + 1) {
    if (results.value.length === 0) activePane.value = 0
    else activePane.value = Math.min(idx + 1, results.value.length)
  } else if (activePane.value > idx + 1) {
    activePane.value -= 1 // 关闭的 tab 在当前面板之前,后面面板整体前移
  }
  // 编辑态清理由 QueryResults 内部自管
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
  const ed = editorRef.value
  if (!ed) return ''
  const sel = ed.getSelection().trim()
  if (sel) return sel
  const segs = splitSqlSegments(ed.getValue()).map((s) => s.sql.trim()).filter(Boolean)
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
  if (engine.value !== 'mysql' && engine.value !== 'oracle' && engine.value !== 'impala') {
    ElMessage.warning('EXPLAIN 仅支持 MySQL / Oracle / Impala')
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
      // MySQL/Impala 回退为行;Oracle 无列时是文本行列表,统一转成单列对象
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

// ── Flink 流批模式与弹窗 ────────────────────────────────────
const flinkMode = ref<'batch' | 'stream'>('batch')
const showFlinkConn = ref(false)
const showFlinkPreJob = ref(false)

/** 连接器弹窗生成 DDL → 插入编辑器(多段用空行分隔) */
function onInsertFlinkDdl(ddls: string[]) {
  const c = editorRef.value
  if (!c || !ddls.length) return
  const text = ddls.join('\n\n')
  const cur = c.getCursor()
  c.replaceRange(text, cur)
  c.setCursor({ line: cur.line, ch: cur.ch + text.length })
  c.focus()
  ElMessage.success(`已插入 ${ddls.length} 条 CREATE TABLE`)
}

/** Flink 执行:流模式(SELECT 无限流/大结果)走异步任务通道(提交即返回 jobId,
 *  前端轮询,避免网关 60s 超时 504);batch 模式同步秒回。 */
const currentFlinkJobId = ref('')
async function execFlink(sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean }> {
  // batch:同步执行(秒回)
  if (flinkMode.value !== 'stream') {
    return queryFlink(sql, 'batch')
  }
  // stream:异步提交 + 轮询(3s 一次,低频)
  const { jobId } = await flinkAsyncSubmit(sql, 'stream')
  currentFlinkJobId.value = jobId
  const deadline = Date.now() + 60 * 60 * 1000 // 上限 1 小时(与 db-proxy timeoutMs 一致)
  try {
    for (;;) {
      const j = await flinkAsyncStatus(jobId)
      if (j.state === 'done') {
        if (j.result) return j.result
        return { columns: [], rows: [], costMs: 0, truncated: true }
      }
      if (j.state === 'failed') {
        throw new Error(j.error || '任务执行失败')
      }
      if (Date.now() > deadline) {
        try { await flinkAsyncCancel(jobId) } catch { /* ignore */ }
        throw new Error('任务超时(1 小时),已自动取消')
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
  } finally {
    currentFlinkJobId.value = ''
  }
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
  dbJobLogText.value = ''
  if (engine.value === 'impala') activePane.value = 0
  const run = async (): Promise<{ columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean }> => {
    const { jobId: jid } = await submitDbJob(db.value, sql, 3600000)
    currentDbJobId.value = jid
    const deadline = Date.now() + 3600000 // 上限 1 小时
    let statusFailures = 0
    while (Date.now() < deadline) {
      if (batchCancelled) {
        try {
          await cancelDbJob(jid)
        } catch {
          /* 忽略 */
        }
        throw new Error('已取消')
      }
      let j: Awaited<ReturnType<typeof getDbJob>>
      try {
        j = await getDbJob(jid)
      } catch (e) {
        const status = (e as Error & { status?: number }).status
        if (status && status < 500) throw e
        statusFailures += 1
        if (statusFailures === 1 || statusFailures % 20 === 0) {
          dbJobLogText.value = [
            dbJobLogText.value,
            `任务仍在后台执行，状态查询暂时失败（${statusFailures} 次），将自动重试：${e instanceof Error ? e.message : String(e)}`
          ].filter(Boolean).join('\n')
        }
        await new Promise((r) => setTimeout(r, 3000))
        continue
      }
      statusFailures = 0
      if (j.logs?.length) dbJobLogText.value = j.logs.join('\n')
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
    currentDbJobId.value = ''
    // 写权限密码验证已移除,不再有解锁重试;错误直接上抛(库未授权/资源护栏等)
    throw e
  }
}

/** 执行单条 SQL 并记录结果;seq 为批次号,停止后旧批次在途结果丢弃,避免覆盖新批 */
async function execOne(sql: string, item: QueryResultItem, seq: number): Promise<void> {
  const isSpark = isSparkEngine.value
  const isFlink = engine.value === 'flinksql'
  if (isSpark) {
    await clearSparkLogs()
    if (seq !== runSeq) return
    startSparkLogPolling()
  }
  try {
    let r
    if (isFlink) r = await execFlink(sql)
    else if (isSpark) r = await execSpark(sql)
    else r = await execDb(sql)
    if (seq !== runSeq) return // 旧批次已失效,丢弃结果
    // 执行成功 → 写入历史(含结果快照,前 100 行;任务钩子:trim 非空且 ≤2000,同 sql 去重保最新,上限 20)
    pushHistory(sql, r)
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
      logs: engine.value === 'impala' && dbJobLogText.value ? dbJobLogText.value.split('\n') : undefined,
      error: e instanceof Error ? e.message : String(e)
    }
  } finally {
    // 仅本批次仍有效时才停日志轮询(否则会停掉新批次的轮询)
    if (isSpark && seq === runSeq) {
      // 收尾:补一次最终拉取,确保查询末尾的 Beeline 日志也能显示
      try {
        await pollSparkLogs()
      } catch {
        /* 日志失败不影响结果 */
      }
      stopSparkLogPolling()
    }
  }
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
function syncRunVarBar(sql?: string) {
  // 无参调用(切 tab 初始化)时自取全文;change 事件已取过则直接复用(省一次全量字符串化)
  const text = sql ?? editorRef.value?.getValue() ?? ''
  VAR_RE.lastIndex = 0
  const names: string[] = []
  let m: RegExpExecArray | null
  while ((m = VAR_RE.exec(text))) if (!names.includes(m[1])) names.push(m[1])
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

/** 拆 SQL 段并过滤空段/纯注释段 */
function getSegments(text: string): string[] {
  return splitSqlSegments(text)
    .map((s) => s.sql.trim())
    .filter(hasExecutableSql)
}

/** 批量执行互斥:同一次「执行」点击为一个批次;批内多条按 FIFO 逐条串行。
 *  每人同时最多提交一批 —— 执行中再次点击执行会被拒绝(loading 互斥)。
 *  batchCancelled:停止按钮置位,中断本批剩余段。
 *  runSeq:批次号,停止/新执行使旧批次在途结果与日志失效。 */
let batchCancelled = false
let runSeq = 0

/** 历史记录 key 与容量(SqlTreePanel 历史/收藏共用);key 按用户名隔离(与 SqlTreePanel 读取端一致) */
const HISTORY_MAX = 20
const authStore = useAuthStore()
const histKey = () => `db-query-history:${authStore.username || 'default'}`

/** 历史附带的结果快照:截断到前 100 行,序列化超 200KB 不缓存(防 localStorage 撑爆) */
const HIST_RESULT_ROWS = 100
const HIST_RESULT_MAX_BYTES = 200_000

/**
 * 执行成功后写入历史:新在前、同 sql 去重(保留最新)、上限 20 循环缓存、仅 trim 非空且 ≤2000;
 * 附带结果快照(仅查询类结果,空 rows 不缓存)。
 */
function pushHistory(sql: string, result?: { columns?: string[]; rows?: Record<string, unknown>[] }) {
  const s = String(sql ?? '').trim()
  if (!s || s.length > 2000) return
  try {
    let list: Array<{ ts: number; sql: string; result?: { columns: string[]; rows: Record<string, unknown>[] } }> = []
    try {
      const raw = localStorage.getItem(histKey())
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) list = parsed.filter((h) => h && typeof h.sql === 'string' && typeof h.ts === 'number')
      }
    } catch {
      /* 历史数据损坏则忽略,重新开始 */
    }
    list = list.filter((h) => h.sql !== s)
    const entry: { ts: number; sql: string; result?: { columns: string[]; rows: Record<string, unknown>[] } } = {
      ts: Date.now(),
      sql: s
    }
    if (result && Array.isArray(result.columns) && result.columns.length && Array.isArray(result.rows) && result.rows.length) {
      try {
        const snapshot = { columns: [...result.columns], rows: result.rows.slice(0, HIST_RESULT_ROWS) }
        if (JSON.stringify(snapshot).length <= HIST_RESULT_MAX_BYTES) entry.result = snapshot
      } catch {
        /* 快照序列化失败(循环引用等)不影响历史本身 */
      }
    }
    list.unshift(entry)
    if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX)
    localStorage.setItem(histKey(), JSON.stringify(list))
  } catch {
    /* localStorage 不可用(Safari 隐私模式等)或配额已满时静默忽略 */
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
    const removed = results.value.length - MAX_RESULTS
    results.value.splice(0, removed)
    // 头部裁剪后收敛激活面板:被裁的是当前面板 → 回日志 tab;否则整体前移
    if (activePane.value > 0) {
      activePane.value = activePane.value <= removed ? 0 : activePane.value - removed
    }
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

/** 执行(选中内容 / 光标段;选中内容含多条时逐条执行) */
async function runQuery() {
  // 每人同时最多提交一批:上一批未结束则拒绝新批(FIFO 排队由批内逐条完成)
  if (loading.value || sparkBatchActive.value || exportLoading.value) {
    ElMessage.warning('上一批 SQL 仍在执行,请等待完成后再提交')
    return
  }
  batchCancelled = false
  const seq = ++runSeq // 新批次号:使上一批(如被停止)的在途结果失效
  if (!ensureDb()) {
    ElMessage.warning('请先选择数据库')
    return
  }
  const rawSql = getSqlToRun().trim()
  if (!rawSql) {
    ElMessage.warning('请输入 SQL')
    return
  }
  // 自定义 ${var} 参数:只替换本次执行段内已填值的变量;未填的原样传给引擎
  const varVals = collectRunVars(rawSql)
  const target = expandSqlVars(rawSql, varVals)
  // flinksql 流式模式:整段作为一个整体提交给 pyflink(由后端 execute_script 内部按分号拆分
  // 逐条执行,使 CREATE TABLE 与 INSERT 在同一 t_env 会话生效),绝不在此拆段
  if (engine.value === 'flinksql' && flinkMode.value === 'stream') {
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
  sparkBatchActive.value = isSparkEngine.value
  error.value = ''
  try {
    await execSegments(segs, seq)
  } finally {
    sparkBatchActive.value = false
    loading.value = false
  }
}

/** 停止当前查询:中断本批剩余段;Spark 提交返回 jobId 后按 id 精确取消。 */
async function stopQuery() {
  batchCancelled = true
  runSeq++ // 使当前批次在途结果/日志失效,防止旧批覆盖停止后新执行的批次
  try {
    if (currentSparkJob.value) {
      try {
        const job = currentSparkJob.value
        await cancelSparkJob(job.jobId, job.executionMode)
      } catch {
        /* 忽略 */
      }
    } else if (engine.value === 'flinksql') {
      // 流式异步任务:精确取消当前 job;batch 同步查询走 cancelFlink
      if (currentFlinkJobId.value) {
        try {
          await flinkAsyncCancel(currentFlinkJobId.value)
        } catch {
          /* 忽略 */
        }
        currentFlinkJobId.value = ''
      } else {
        await cancelFlink()
      }
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


// ── 初始化 ───────────────────────────────────────────────────
/** 数据源加载失败/为空时保留页内提示(原来的 ElMessage 一闪而过,用户看不到原因) */
const datasourceError = ref('')

async function loadDataSources() {
  datasourceError.value = ''
  try {
    datasources.value = await listDataSources()
    if (datasources.value.length) {
      const first = datasources.value.find(
        (d) => d.type === 'mysql' || d.type === 'oracle' || d.type === 'impala' || d.type === 'sparksql'
      )
      engine.value = first ? first.type as 'mysql' | 'oracle' | 'impala' | 'sparksql' : ''
      db.value = filteredDbs.value[0]?.name || ''
    } else {
      datasourceError.value = '未配置数据库源(检查网关 DB_PROXY_URL)'
    }
  } catch (e) {
    datasourceError.value = `加载数据源失败:${e instanceof Error ? e.message : e}`
  }
}

onMounted(async () => {
  // 跟随门户主题变化(顶栏/标签栏的主题按钮),避免出现两套互不同步的深浅色
  window.addEventListener(THEME_EVENT, onGlobalThemeChange)
  await loadDataSources()
})

watch(engine, async (val) => {
  // 写权限密码验证已移除,切换引擎不再要求解锁
  if (!val) {
    // 引擎被清空时同步清空库,避免禁用控件里残留上一个引擎的库名
    db.value = ''
    return
  }
  const selected = filteredDbs.value.find((d) => d.type === val || (isSparkEngine.value && (d.type === 'sparksql' || d.type === 'sparksession')))
  db.value = selected?.name || ''
  // 编辑器始终使用 SQL 语言模式,无需随引擎切换设置
})

</script>

<template>
  <div class="db-query">
    <!-- 左目录面板 + 右查询区 -->
    <div class="db-main">
      <div class="db-side" :style="{ width: sideWidth + 'px' }">
        <SqlTreePanel ref="treePanelRef" :dbs="treeDbs" :execution-mode="sparkExecutionMode" @open="onOpenFile" @insert="onInsert" @open-table="onOpenTable" @run-sql="onRunHistorySql" />
      </div>
      <div class="db-resizer" title="拖拽调整目录宽度" @mousedown.prevent="onSideDragStart" />
      <div class="db-right">
    <!-- 数据源异常常驻提示(原来的 toast 一闪而过,用户不知道引擎/库为什么是空的) -->
    <el-alert
      v-if="datasourceError"
      class="datasource-alert"
      :title="datasourceError"
      type="warning"
      show-icon
      :closable="false"
    >
      <template #default>
        <el-button size="small" @click="loadDataSources">重试</el-button>
      </template>
    </el-alert>
    <!-- 顶部工具条 -->
    <div class="toolbar">
      <div class="toolbar-group toolbar-group-context">
      <el-select v-model="engine" class="engine-select" placeholder="选择引擎" clearable :disabled="loading || sparkBatchActive || exportLoading">
        <el-option label="MySQL" value="mysql" />
        <el-option label="Oracle" value="oracle" />
        <el-option label="Impala" value="impala" />
        <el-option label="SparkSQL" value="sparksql" />
        <el-option label="SparkSession" value="sparksession" />
        <el-option label="FlinkSQL" value="flinksql" />
      </el-select>
      <el-select v-model="db" class="db-select" :placeholder="dbPlaceholder" filterable :disabled="!engine">
        <el-option v-for="d in filteredDbs" :key="d.name" :label="`${d.label || d.name}${d.label && d.label !== d.name ? ` (${d.name})` : ''}`" :value="d.name" />
      </el-select>
      </div>
      <div class="toolbar-spacer" />
      <div class="toolbar-group toolbar-group-editor">
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
      </div>
      <el-divider direction="vertical" />
      <div class="toolbar-group toolbar-group-run">
      <template v-if="engine === 'flinksql'">
        <el-radio-group v-model="flinkMode" size="small" class="flink-mode">
          <el-radio-button value="batch">批</el-radio-button>
          <el-radio-button value="stream">流</el-radio-button>
        </el-radio-group>
        <el-tooltip content="连接器管理" placement="top"><el-button size="small" :icon="MagicStick" @click="showFlinkConn = true" /></el-tooltip>
        <el-tooltip content="PreJob 提交/管理" placement="top"><el-button size="small" :icon="Promotion" @click="showFlinkPreJob = true" /></el-tooltip>
        <el-divider direction="vertical" />
      </template>
      <el-tooltip content="格式化 SQL(Cmd+Shift+F)" placement="top"><el-button :icon="MagicStick" :disabled="loading" @click="formatSql" /></el-tooltip>
      <el-tooltip content="执行计划(EXPLAIN)" placement="top"><el-button :icon="Promotion" :loading="explainLoading" :disabled="loading" @click="runExplain" /></el-tooltip>
      <el-tooltip v-if="loading" content="停止当前批次" placement="top"><el-button type="danger" :icon="VideoPause" @click="stopQuery">停止</el-button></el-tooltip>
      <el-tooltip v-if="isSparkEngine" content="导出当前 SQL 完整结果到 HDFS" placement="top">
        <el-button :icon="Download" :loading="exportLoading" :disabled="loading && !exportLoading" @click="exportSparkResult">导出到 HDFS</el-button>
      </el-tooltip>
      <el-tooltip content="执行(Cmd+Enter)" placement="top">
        <el-button type="primary" :icon="CaretRight" :loading="loading" :disabled="loading" @click="runQuery">
          {{ loading ? '执行中' : '执行' }}
        </el-button>
      </el-tooltip>
      </div>
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

    <!-- SQL 画布(Monaco,由 SqlEditor 封装:model 池/补全/快捷键/主题)
         无结果时占满内容区,有结果后按可拖拽高度分屏 -->
    <div ref="canvasRef" class="sql-canvas" :class="[themeMode, { expanded: !results.length }]" :style="canvasStyle">
      <SqlEditor
        ref="editorRef"
        class="sql-editor"
        :model-id="activeTabId"
        :value="activeTab?.content ?? ''"
        language="sql"
        :theme-mode="themeMode"
        :font-size="fontSize"
        :current-db="db"
        :engine="engine"
        :execution-mode="sparkExecutionMode"
        :schema-loader="schemaLoader"
        @change="onEditorChange"
        @exec="runQuery"
        @save="saveActive"
        @format="formatSql"
        @ready="onEditorReady"
      />
      <div v-if="!(activeTab?.content || '').trim()" class="canvas-hint" aria-hidden="true">
        <p class="canvas-hint-title">在这里编写 SQL</p>
        <p>Ctrl/Cmd + Enter 执行 · 左侧「表目录」点击表名/字段即可插入</p>
      </div>
    </div>

    <!-- 拖拽分割条:只在有结果、画布与结果区分屏时出现 -->
    <div v-if="results.length" class="sql-dragbar" @mousedown="onDragStart">
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

    <!-- 结果区(日志 tab 内容由父 slot 提供;结果 tab/表格/编辑/导出在 QueryResults 组件内) -->
    <QueryResults
      v-if="results.length"
      :results="results"
      :active-pane="activePane"
      :db="db"
      :engine-label="engineLabel"
      :loading="loading"
      @select="selectPane"
      @close="closeResultTab"
      @rerun="rerunResult"
      @busy="(v: boolean) => (loading = v)"
      @manage-flink="showFlinkPreJob = true"
    >
      <!-- 日志面板:spark 轮询/阶段进度/清空等与父状态强耦合,保留在父,经 slot 注入 -->
      <template #log>
        <div class="result-card log-card">
          <div class="spark-logs-head">
            <span class="spark-logs-title"><el-icon><DocumentChecked /></el-icon> 引擎日志(最近一次查询)</span>
            <span class="spark-logs-actions">
              <template v-if="engine === 'impala'">
                <el-button text size="small" @click="clearDbJobLogs">清空</el-button>
              </template>
              <template v-else>
                <el-button text size="small" @click="void pollSparkLogs()">刷新</el-button>
                <el-button text size="small" @click="() => void clearSparkLogs()">清空</el-button>
              </template>
            </span>
          </div>
          <div v-if="isSparkEngine" class="spark-stage-status">{{ sparkStageSummary }}</div>
          <pre ref="sparkLogBox" class="spark-logs-body">{{ (engine === 'impala' ? dbJobLogText : sparkLogText) || logEmptyHint }}</pre>
        </div>
      </template>
    </QueryResults>

      </div>
    </div>

    <!-- 底部全局状态栏(DataGrip 式):引擎/库/结果统计/主题 -->
    <div class="statusbar">
      <span class="sb-item"><span class="sb-label">引擎</span>{{ engineLabel }}</span>
      <span class="sb-item"><span class="sb-label">库</span>{{ db || '—' }}</span>
      <template v-if="currentResult && !currentResult.error && !currentResult.jobId && !currentResult.hdfsPath">
        <span v-if="!(currentResult.running && !currentResult.columns.length && !currentResult.rows.length)" class="sb-item sb-stats">
          {{ currentResult.rows.length }} 行 · {{ currentResult.columns.length }} 列 · {{ currentResult.costMs }}ms
          <span v-if="currentResult.truncated" class="sb-trunc">· 已截断</span>
        </span>
        <span v-if="currentResult.running" class="sb-item sb-running"><el-icon class="tab-spin"><Loading /></el-icon> 执行中…</span>
      </template>
      <span v-else-if="loading" class="sb-item sb-running"><el-icon class="tab-spin"><Loading /></el-icon> 执行中…</span>
      <span class="sb-spacer" />
      <span class="sb-item sb-hints">Ctrl/Cmd + Enter 执行 · Tab 缩进 · Ctrl/Cmd + Space 补全<span v-if="results.length"> · 拖拽分割条调整画布高度</span></span>
      <span class="sb-item">{{ themeMode === 'dark' ? '深色' : '浅色' }}主题</span>
    </div>
  </div>

  <!-- Flink 连接器批量建表弹窗 -->
  <FlinkConnectorDialog v-model="showFlinkConn" @insert="onInsertFlinkDdl" />

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
  padding: 14px 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
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
  border-radius: 8px;
  background: $panel;
  box-shadow: 0 1px 2px color-mix(in srgb, $text 5%, transparent);
  overflow: hidden;
}

/* 拖拽条 */
.db-resizer {
  width: 6px;
  cursor: col-resize;
  flex-shrink: 0;
  border-radius: 3px;
  background: transparent;
  transition: background 0.15s;

  &::after {
    content: '';
    display: block;
    width: 2px;
    height: 36px;
    margin: auto;
    border-radius: 2px;
    background: $border;
    transition: background 0.15s, height 0.15s;
  }

  &:hover {
    background: var(--bd-table-hover);

    &::after {
      height: 54px;
      background: $primary;
    }
  }
}

.db-right {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  gap: 6px;
  overflow: hidden;
}

.datasource-alert {
  margin: 8px 12px 0;
  flex-shrink: 0;
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
  background: var(--bd-panel-sub);
  border: 1px solid $border;
  border-radius: 8px;
  padding: 3px 5px;
  flex-shrink: 0;
  overflow-x: auto;
  scrollbar-width: thin;
}

.file-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  position: relative;
  padding: 5px 11px;
  font-size: 12px;
  color: $muted;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;

  &.active {
    background: $panel;
    color: $text;
    font-weight: 600;
    box-shadow: 0 1px 2px color-mix(in srgb, $text 7%, transparent), inset 0 -2px 0 $primary;
  }

  &:hover {
    background: var(--bd-table-hover);
    color: $primary;
  }

  &:focus-visible {
    outline: 2px solid color-mix(in srgb, $primary 55%, transparent);
    outline-offset: -2px;
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
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, background 0.15s;

  .file-tab:hover &,
  .file-tab.active & {
    opacity: 1;
  }

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
  /* 窄屏放不下时换行,避免右侧「执行」被内容区 overflow 裁掉 */
  flex-wrap: wrap;
  gap: 4px 6px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 8px;
  padding: 5px 7px;
  flex-shrink: 0;
  box-shadow: 0 1px 2px color-mix(in srgb, $text 5%, transparent);

  /* 按钮瘦身 */
  :deep(.el-button) {
    padding: 5px 8px;
  }

  :deep(.el-select__wrapper) {
    min-height: 28px;
    padding: 0 8px;
  }
}

.toolbar-group {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;

  :deep(.el-button) {
    min-width: 30px;
  }
}

.toolbar-group-context {
  gap: 5px;
  /* 允许引擎/库下拉在窄屏收缩,而不是把右侧操作挤出去 */
  flex-shrink: 1;
  min-width: 0;
}

.toolbar-group-run {
  gap: 4px;
}

:deep(.toolbar .el-divider--vertical) {
  height: 20px;
  margin: 0 3px;
  border-color: color-mix(in srgb, $border 90%, transparent);
}

.engine-select {
  flex: 0 1 96px;
  min-width: 76px;
}

.db-select {
  flex: 0 1 200px;
  min-width: 110px;
}

.toolbar-spacer {
  flex: 1;
}

.font-btn {
  min-width: 28px;
  padding: 0 6px;
  font-weight: 700;
}

.exec-kbd {
  margin-left: 6px;
  padding: 1px 5px;
  font-size: 11px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.15);
}

/* ── SQL 画布(Monaco) ────────────────────────────────── */
.sql-canvas {
  position: relative;
  display: flex;
  background: var(--bd-panel-sub);
  border: 1px solid $border;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;

  &.light {
    background: var(--bd-panel);
  }

  /* 无结果时占满剩余高度:首屏写 SQL 的空间不再被空态插图吃掉 */
  &.expanded {
    flex: 1 1 auto;
    min-height: 160px;
  }
}

/* 空画布提示:浮在 Monaco 中央,不拦截点击与光标 */
.canvas-hint {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: $muted;
  pointer-events: none;

  p {
    margin: 0;
    text-wrap: balance;
  }

  .canvas-hint-title {
    font-size: 14px;
    font-weight: 600;
    color: color-mix(in srgb, $text 75%, transparent);
  }
}

.sql-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;

  /* Monaco 填满容器;字体统一等宽;背景与语法配色由 defineTheme(portal-dark/light) 控制 */
  :deep(.monaco-editor) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  /* 圆角与容器一致 */
  :deep(.monaco-editor .overflow-guard) {
    border-radius: 8px;
  }
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
  background: var(--bd-panel-sub);
  border-top: 1px solid $border;
  border-bottom: 1px solid $border;
  border-radius: 3px;

  &:hover {
    color: $primary;
    background: var(--bd-table-hover);
  }

  &:focus-visible {
    outline: 2px solid color-mix(in srgb, $primary 55%, transparent);
    outline-offset: -2px;
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
  background: var(--bd-panel-sub);
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

/* ── 底部全局状态栏(DataGrip 式;拆组件时误删,2026-09 恢复) ── */
.statusbar {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  color: $muted;
  background: $panel;
  border: 1px solid $border;
  border-radius: 7px;
  box-shadow: 0 1px 2px color-mix(in srgb, $text 4%, transparent);
  user-select: none;
  overflow: hidden;

  /* 状态项各自不换行,窄屏只收缩提示,不把「引擎/库」拆成两行 */
  .sb-item {
    flex-shrink: 0;
    white-space: nowrap;
  }

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

.spark-stage-status {
  padding: 4px 12px;
  font-size: 12px;
  color: $muted;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}

/* 窄屏优先保留引擎/库/主题,隐藏快捷键长提示(画布中央已有等价提示) */
@media (max-width: 900px) {
  .statusbar .sb-hints {
    display: none;
  }
}

/* Spark 引擎日志透传面板 */
.spark-logs-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 120px; /* 确保展开后可见,不被结果区挤没 */
  border: 1px solid $border;
  border-radius: 8px;
  background: var(--bd-panel);
  overflow: hidden;
}
.spark-logs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  border-bottom: 1px solid $border;
  flex-shrink: 0;
}
.spark-logs-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: $text;
}
.spark-logs-actions {
  display: flex;
  align-items: center;
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
  color: $text;
  background: var(--bd-panel-sub);
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
  color: $text;
  background: var(--bd-panel-sub);
  border: 1px solid $border;
  border-radius: 4px;
}
</style>
