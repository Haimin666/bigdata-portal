<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CaretRight, Download, MagicStick, Sunny, Moon, DocumentChecked, Document, Plus, Close, Lock, Unlock, VideoPause, Promotion } from '@element-plus/icons-vue'
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
import { listDataSources, queryDb, querySpark, queryFlink, cancelFlink, sparkAuth, sparkLogs, cancelSpark, saveScriptContent, getScriptContent, createScriptNode, type DbDataSource, type ScriptNode } from '@/api/db'
import { getTheme } from '@/utils/theme'
import SqlTreePanel from './SqlTreePanel.vue'
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

// ── Spark 写权限解锁(类似 Jupyter 登录)───────────────────────
// sparksql 可执行 INSERT/CREATE/DROP 等写操作,必须先密码解锁拿 token
const SPARK_TOKEN_KEY = 'bigdata-portal.spark-token'
const sparkToken = ref(sessionStorage.getItem(SPARK_TOKEN_KEY) || '')
const showSparkAuth = ref(false)
const sparkPwd = ref('')
const sparkAuthLoading = ref(false)
const sparkUnlocked = computed(() => !!sparkToken.value)

/** 打开解锁弹窗,返回 promise:resolve(token) 或 resolve(null) 取消 */
function openSparkAuth(): Promise<string | null> {
  return new Promise((resolve) => {
    sparkAuthResolve = resolve
    showSparkAuth.value = true
  })
}
let sparkAuthResolve: ((t: string | null) => void) | null = null

async function submitSparkAuth() {
  if (!sparkPwd.value) {
    ElMessage.warning('请输入密码')
    return
  }
  sparkAuthLoading.value = true
  try {
    const { token } = await sparkAuth(sparkPwd.value)
    sparkToken.value = token
    sessionStorage.setItem(SPARK_TOKEN_KEY, token)
    sparkPwd.value = ''
    showSparkAuth.value = false
    ElMessage.success('写权限已解锁(12 小时内有效)')
    sparkAuthResolve?.(token)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
    sparkAuthResolve?.(null)
  } finally {
    sparkAuthLoading.value = false
    sparkAuthResolve = null
  }
}

function cancelSparkAuth() {
  showSparkAuth.value = false
  sparkAuthResolve?.(null)
  sparkAuthResolve = null
}

/** 弹窗完全关闭(含 ESC):必须 resolve 挂起的 promise,否则 await openSparkAuth() 永久挂起卡死 */
function onSparkAuthClosed() {
  sparkAuthResolve?.(null)
  sparkAuthResolve = null
}

function lockSparkWrite() {
  sparkToken.value = ''
  sessionStorage.removeItem(SPARK_TOKEN_KEY)
  ElMessage.info('已锁定 Spark 写权限')
}

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

/** Spark 执行:SQL 写语句或 pyspark(任意代码)未解锁时先弹密码框;只读 SQL 直接执行 */
async function execSpark(sql: string, kind: 'sql' | 'pyspark' = 'sql'): Promise<{ columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean }> {
  const needsAuth = kind === 'pyspark' || (kind === 'sql' && isSparkWriteSql(sql))
  if (needsAuth && !sparkToken.value) {
    const tk = await openSparkAuth()
    if (!tk) throw new Error('已取消:写权限未解锁')
  }
  return querySpark(sql, sparkToken.value || undefined, kind)
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
function newTab(name: string, content: string): EditorTab {
  return { id: `tab-${++tabSeq}`, file: null, name, content, dirty: false }
}
const tabs = ref<EditorTab[]>([])
const activeTabId = ref('')
const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null)
// 初始一个未命名 tab
tabs.value.push(newTab('未命名查询', ''))
activeTabId.value = tabs.value[0].id

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

/** 保存当前活跃 tab(Ctrl/Cmd + S):绑定文件直接保存;未命名时输入文件名保存到根目录 */
async function saveActive() {
  const tab = activeTab.value
  if (!tab) return
  if (tab.file) {
    try {
      await saveScriptContent(tab.file.id, cm?.getValue() ?? '')
      tab.dirty = false
      ElMessage.success(`已保存 ${tab.name}`)
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
    value: DEFAULT_SQL,
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
  // 文件内容变更 → 未保存标记(仅跟踪当前活跃 tab)
  cm.on('change', () => {
    const t = activeTab.value
    if (t) t.dirty = true
  })
  // ── 补全触发:输入字母/下划线后 250ms 弹出(避免每键弹闪);浮层打开时 Tab 选词 ──
  cm.on('inputRead', (c: CodeMirror.Editor, change: CodeMirror.EditorChange) => {
    if (change.origin !== '+input') return
    const ch = change.text[0] || ''
    if (!/[\w.]/.test(ch)) return
    if (completionTimer) clearTimeout(completionTimer)
    completionTimer = window.setTimeout(() => {
      c.showHint({
        completeSingle: false,
        hint: engine.value === 'pyspark' ? CodeMirror.hint.anyword : CodeMirror.hint.sql
      })
    }, 250)
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
      c.showHint({
        completeSingle: false,
        hint: engine.value === 'pyspark' ? CodeMirror.hint.anyword : CodeMirror.hint.sql
      })
    },
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
  stopSparkLogPolling()
  if (cm) {
    const el = cm.getWrapperElement()
    el.remove()
    cm = null
  }
})

// ── Spark driver 日志透传(执行 spark 查询时轮询展示)───────────
const sparkLogText = ref('')
const sparkLogOffsets = ref<{ jvm: number; audit: number }>({ jvm: 0, audit: 0 })
let sparkLogTimer: number | null = null

/** 拉取 spark 日志增量并追加 */
async function pollSparkLogs() {
  try {
    const data = await sparkLogs(sparkLogOffsets.value)
    if (data.content) {
      sparkLogText.value += data.content
      // 日志超长时只保留尾部 500KB
      if (sparkLogText.value.length > 500000) {
        sparkLogText.value = sparkLogText.value.slice(-500000)
      }
    }
    sparkLogOffsets.value = data.offsets
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
  sparkLogText.value = ''
  sparkLogOffsets.value = { jvm: 0, audit: 0 }
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

/** 按分号切分 SQL 段(跳过字符串/注释内的分号) */
function splitSqlSegments(text: string): { start: number; end: number; sql: string }[] {
  const segs: { start: number; end: number; sql: string }[] = []
  let segStart = 0
  let i = 0
  let inSingle = false
  let inDouble = false
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
function formatSql() {
  if (!cm) return
  if (engine.value === 'pyspark') {
    ElMessage.info('Python 模式暂不支持格式化')
    return
  }
  const s = cm.getValue().trim()
  if (!s) return
  const keywords = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'UNION', 'FETCH', 'OFFSET']
  let out = s
  for (const kw of keywords) {
    out = out.replace(new RegExp(`\\b${kw}\\b`, 'gi'), (m: string) => `\n${m.toUpperCase()}`)
  }
  cm.setValue(out.replace(/\n{2,}/g, '\n').trim())
}

// ── 查询执行 ─────────────────────────────────────────────────
interface QueryResultItem {
  sql: string
  columns: string[]
  rows: Record<string, unknown>[]
  costMs: number
  truncated: boolean
  error?: string
  jobId?: string
  mode?: string
}

const results = ref<QueryResultItem[]>([])
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
  if (!sparkToken.value) {
    const tk = await openSparkAuth()
    if (!tk) throw new Error('已取消:Flink 任务未解锁')
  }
  try {
    return await queryFlink(sql, flinkMode.value, sparkToken.value || undefined)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/解锁|token|401|403/i.test(msg)) {
      sparkToken.value = ''
      sessionStorage.removeItem(SPARK_TOKEN_KEY)
      const tk2 = await openSparkAuth()
      if (!tk2) throw new Error('已取消:Flink 任务未解锁')
      return queryFlink(sql, flinkMode.value, tk2)
    }
    throw e
  }
}

/** MySQL/Oracle 执行:写语句需解锁(与 Spark 共用密码);只读直接执行。
 *  token 过期(网关 403)自动重新解锁后重试一次 */
async function execDb(sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[]; costMs: number; truncated: boolean }> {
  if (!db.value) throw new Error('请先选择数据库')
  if (isSparkWriteSql(sql) && !sparkToken.value) {
    const tk = await openSparkAuth()
    if (!tk) throw new Error('已取消:写操作未解锁')
  }
  try {
    return await queryDb(db.value, sql, sparkToken.value || undefined)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/解锁|token|401|403/i.test(msg)) {
      sparkToken.value = ''
      sessionStorage.removeItem(SPARK_TOKEN_KEY)
      const tk2 = await openSparkAuth()
      if (!tk2) throw new Error('已取消:写操作未解锁')
      return queryDb(db.value, sql, tk2)
    }
    throw e
  }
}

/** 执行单条 SQL 并记录结果 */
async function execOne(sql: string, index: number): Promise<void> {
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
    results.value[index] = { sql, ...r }
  } catch (e) {
    results.value[index] = {
      sql,
      columns: [],
      rows: [],
      costMs: 0,
      truncated: false,
      error: e instanceof Error ? e.message : String(e)
    }
  } finally {
    if (isSpark) stopSparkLogPolling()
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
 *  batchCancelled:停止按钮置位,中断本批剩余段 */
let batchCancelled = false

/** 执行目标 SQL 段列表(逐条 FIFO 串行执行) */
async function execSegments(segs: string[]) {
  results.value = segs.map((sql) => ({ sql, columns: [], rows: [], costMs: 0, truncated: false }))
  for (let i = 0; i < segs.length; i++) {
    if (batchCancelled) break
    await execOne(segs[i], i)
  }
  // 默认展示最后一个 tab(最新执行的结果;日志 tab 恒为第一个)
  activePane.value = results.value.length
}

/** 执行(选中内容 / 光标段;选中内容含多条时逐条执行;python 整段执行) */
async function runQuery() {
  // 每人同时最多提交一批:上一批未结束则拒绝新批(FIFO 排队由批内逐条完成)
  if (loading.value) {
    ElMessage.warning('上一批 SQL 仍在执行,请等待完成后再提交')
    return
  }
  batchCancelled = false
  if (!db.value) {
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
      results.value = [{ sql: target, columns: [], rows: [], costMs: 0, truncated: false }]
      await execOne(target, 0)
      activePane.value = 1
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
    await execSegments(segs)
  } finally {
    loading.value = false
  }
}

/** 停止当前查询:中断本批剩余段(前端不再发后续 SQL),并尝试取消引擎 job */
async function stopQuery() {
  batchCancelled = true
  try {
    if (engine.value === 'flinksql') {
      await cancelFlink()
    } else if (engine.value === 'sparksql' || engine.value === 'pyspark') {
      await cancelSpark()
    }
    // mysql/oracle:无引擎 job 可取消,置位后批循环自行停止
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

// ── 单元格点击复制 ──────────────────────────────────────────
async function copyCell(val: unknown) {
  try {
    await navigator.clipboard.writeText(val == null ? '' : String(val))
    ElMessage.success('已复制')
  } catch {
    /* 忽略剪贴板权限 */
  }
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

watch(engine, async (val, old) => {
  // flink 切换即需解锁:未解锁先弹密码框;取消则回退原引擎(不解锁不能使用 flink)
  if (val === 'flinksql' && !sparkToken.value) {
    const tk = await openSparkAuth()
    if (!tk) {
      ElMessage.warning('Flink 需先解锁才能使用')
      engine.value = old && old !== 'flinksql' ? old : ''
      return
    }
  }
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
</script>

<template>
  <div class="db-query">
    <!-- 左目录面板 + 右查询区 -->
    <div class="db-main">
      <div class="db-side" :style="{ width: sideWidth + 'px' }">
        <SqlTreePanel :dbs="treeDbs" @open="onOpenFile" @insert="onInsert" />
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
      <el-button
        v-if="engine"
        class="spark-lock-btn"
        :type="sparkUnlocked ? 'success' : 'warning'"
        :icon="sparkUnlocked ? Unlock : Lock"
        size="small"
        @click="sparkUnlocked ? lockSparkWrite() : openSparkAuth()"
      >
        {{ sparkUnlocked ? '写权限已解锁' : '解锁写权限' }}
      </el-button>
      <el-select v-model="db" class="db-select" placeholder="选择数据库" filterable>
        <el-option v-for="d in filteredDbs" :key="d.name" :label="`${d.label || d.name}${d.label && d.label !== d.name ? ` (${d.name})` : ''}`" :value="d.name" />
      </el-select>
      <div class="toolbar-spacer" />
      <el-button
        :icon="DocumentChecked"
        class="save-btn"
        :disabled="loading"
        @click="saveActive"
      >{{ activeTab && activeTab.file ? `保存 ${activeTab.name}` : '保存' }}</el-button>
      <el-button class="font-btn" text @click="adjustFont(-1)">A−</el-button>
      <el-button class="font-btn" text @click="adjustFont(1)">A+</el-button>
      <el-divider direction="vertical" />
      <template v-if="engine === 'flinksql'">
        <el-radio-group v-model="flinkMode" size="small" class="flink-mode">
          <el-radio-button value="batch">批</el-radio-button>
          <el-radio-button value="stream">流</el-radio-button>
        </el-radio-group>
        <el-button size="small" :icon="MagicStick" @click="showFlinkConn = true">连接器</el-button>
        <el-button size="small" :icon="VideoPause" @click="showFlinkJobs = true">流任务</el-button>
        <el-button size="small" :icon="Promotion" @click="showFlinkPreJob = true">PreJob</el-button>
        <el-divider direction="vertical" />
      </template>
      <el-button :icon="MagicStick" @click="formatSql">格式化</el-button>
      <el-button v-if="(engine === 'sparksql' || engine === 'pyspark' || engine === 'flinksql') && loading" type="danger" :icon="VideoPause" @click="stopQuery">
        停止
      </el-button>
      <el-button type="primary" :icon="CaretRight" :loading="loading" @click="runQuery">
        执行<kbd class="exec-kbd">⌘↵</kbd>
      </el-button>
      <el-divider direction="vertical" />
      <el-button class="theme-btn" text :title="themeMode === 'dark' ? '切换到浅色' : '切换到深色'" @click="toggleTheme">
        <el-icon><Sunny v-if="themeMode === 'dark'" /><Moon v-else /></el-icon>
      </el-button>
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
        <el-icon class="file-tab-close" title="关闭" @click.stop="closeTab(t.id)"><Close /></el-icon>
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
          <span class="tab-name" :class="{ err: r.error }">query{{ idx + 1 }}</span>
          <span v-if="!r.error" class="tab-export" title="导出 CSV" @click.stop="exportCsv(idx)">
            <el-icon><Download /></el-icon>
          </span>
        </div>
      </div>
      <!-- 下方当前面板内容 -->
      <div class="result-content">
        <!-- 日志面板(第一个 tab) -->
        <template v-if="activePane === 0">
          <div class="spark-logs-head">
            <span class="spark-logs-title"><el-icon><DocumentChecked /></el-icon> 引擎日志(最近一次查询)</span>
            <span class="spark-logs-actions">
              <el-button text size="small" @click="void pollSparkLogs()">刷新</el-button>
              <el-button text size="small" @click="clearSparkLogs">清空</el-button>
            </span>
          </div>
          <pre class="spark-logs-body">{{ sparkLogText || logEmptyHint }}</pre>
        </template>
        <!-- 结果内容 -->
        <template v-else-if="currentResult">
          <el-alert v-if="currentResult.error" type="error" :title="currentResult.error" show-icon :closable="false" class="err-alert" />
          <div v-else v-loading="loading" class="result-table-wrap">
            <el-table :data="pagedRows" border size="small" class="result-table">
              <el-table-column type="index" label="#" width="55" align="center" />
              <el-table-column
                v-for="c in currentResult.columns"
                :key="c"
                :prop="c"
                :label="c"
                min-width="140"
                sortable
                show-overflow-tooltip
              >
                <template #default="{ row }">
                  <span
                    v-if="row[c] == null"
                    class="cell-null"
                    @click="copyCell(row[c])"
                  >NULL</span>
                  <span
                    v-else
                    class="cell-val"
                    :class="{ 'cell-num': isNumeric(row[c]) }"
                    :title="`点击复制: ${row[c]}`"
                    @click="copyCell(row[c])"
                  >{{ row[c] }}</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <!-- 底部状态条:行数/耗时 -->
          <div class="result-footer">
            <span v-if="currentResult.error">执行失败</span>
            <template v-else-if="currentResult.jobId">
              <span class="footer-job">流式任务已提交</span>
              <el-tag size="small" type="primary">{{ currentResult.jobId }}</el-tag>
              <el-button size="small" text type="primary" @click="showFlinkJobs = true">查看状态</el-button>
              <span class="footer-muted">· 任务在后台常驻运行,可在「流任务」面板停止</span>
            </template>
            <template v-else>
              <span>{{ currentResult.rows.length }} 行</span>
              <template v-if="currentResult.truncated"><span class="footer-muted">(已截断)</span></template>
              <span class="footer-muted">· {{ currentResult.costMs }}ms</span>
            </template>
          </div>
          <!-- 翻页(默认 15 条/页) -->
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
        </template>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else-if="!loading && !error" class="empty-state">
      <el-empty description="选择数据库,编写 SQL 后执行(Ctrl/Cmd + Enter)" />
    </div>
      </div>
    </div>
  </div>

  <!-- Spark 写权限解锁弹窗(类似 Jupyter 登录) -->
  <el-dialog
    v-model="showSparkAuth"
    title="Spark 写权限验证"
    width="400px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    @closed="onSparkAuthClosed"
  >
    <div class="spark-auth-tip">
      <el-icon color="#e6a23c"><Lock /></el-icon>
      <span>Spark SQL 支持写操作(INSERT / CREATE / DROP / TRUNCATE 等),仅限技术人员使用。请输入写权限密码解锁。</span>
    </div>
    <el-input
      v-model="sparkPwd"
      type="password"
      show-password
      placeholder="请输入 Spark 写权限密码"
      @keyup.enter="submitSparkAuth"
    />
    <template #footer>
      <el-button @click="cancelSparkAuth">取消</el-button>
      <el-button type="primary" :loading="sparkAuthLoading" @click="submitSparkAuth">验证</el-button>
    </template>
  </el-dialog>

  <!-- Flink 连接器批量建表弹窗 -->
  <FlinkConnectorDialog v-model="showFlinkConn" @insert="onInsertFlinkDdl" />

  <!-- Flink 流式任务管理弹窗 -->
  <FlinkJobsDialog v-model="showFlinkJobs" />

  <!-- Flink PreJob 提交/管理弹窗 -->
  <FlinkPreJobDialog v-model="showFlinkPreJob" />
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
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.result-table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
}

.result-table {
  width: 100%;

  :deep(th.el-table__cell) {
    position: sticky;
    top: 0;
    z-index: 1;
  }

  :deep(.cell-null) {
    color: $muted;
    font-style: italic;
    cursor: pointer;
  }

  :deep(.cell-val) {
    cursor: pointer;

    &:hover {
      color: $primary;
    }
  }

  :deep(.cell-num) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    text-align: right;
  }
}

.result-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  color: $muted;
  flex-shrink: 0;
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
  border: 1px solid $border;
  border-radius: 6px;
  padding: 8px 12px;
  flex-shrink: 0;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
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
.spark-logs-body {
  flex: 1;
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

.spark-lock-btn {
  margin-left: 8px;
}

.spark-auth-tip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 13px;
  line-height: 1.5;
  color: #606266;
}

.spark-auth-tip .el-icon {
  margin-top: 2px;
  flex-shrink: 0;
}
</style>
