<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { CaretRight, Download, MagicStick, Refresh, Sunny, Moon } from '@element-plus/icons-vue'
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/sql/sql.js'

// CodeMirror 5 的 addon 是 UMD,在 Vite 的 CJS 转换下注册不稳定
// (addon 挂到内部 require 的实例,与我们 import 的实例可能不一致)。
// 本项目全部自实现所需功能(括号匹配/自动闭合/当前行/提示浮层),
// 不依赖任何 addon —— 避免构建/加载兼容问题。
async function loadAddons() {
  // 空:不加载 addon
}
import { listDataSources, queryDb, type DbDataSource } from '@/api/db'

defineOptions({ name: 'DbQueryView' })

// ── 状态 ─────────────────────────────────────────────────────
const datasources = ref<DbDataSource[]>([])
const engine = ref<'mysql' | 'oracle' | ''>('')
const db = ref('')
const loading = ref(false)
const error = ref('')

// 引擎过滤后的数据源
const filteredDbs = computed(() =>
  engine.value ? datasources.value.filter((d) => d.type === engine.value) : datasources.value
)

// ── CodeMirror 编辑器 ───────────────────────────────────────
const cmRef = ref<HTMLElement>()
const canvasRef = ref<HTMLElement>()
let cm: CodeMirror.Editor | null = null

// 默认 SQL:清空(用户自行编写)
const DEFAULT_SQL = ''

// 编辑器主题:dark(默认)/ light,持久化到 localStorage
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
}

function adjustFont(delta: number) {
  fontSize.value = Math.min(MAX_FONT, Math.max(MIN_FONT, fontSize.value + delta))
  localStorage.setItem(FONT_KEY, String(fontSize.value))
}

async function initEditor() {
  if (!cmRef.value || cm) return
  // 先动态加载 addon(注册到 window.CodeMirror),再创建编辑器
  try {
    await loadAddons()
  } catch (e) {
    console.warn('[db-query] CodeMirror addon 加载失败:', e)
  }
  cm = CodeMirror(cmRef.value, {
    value: DEFAULT_SQL,
    mode: 'text/x-sql',
    lineNumbers: true,
    indentWithTabs: false,
    tabSize: 2,
    indentUnit: 2,
    lineWrapping: true,
    theme: 'default'
  })
  // 首次挂载若容器尺寸未稳定(如 tab 常驻池中非激活创建),内容会挤到行号前。
  // 等 DOM 稳定后强制 refresh 重算布局。
  await nextTick()
  cm.refresh()
  // 括号匹配(自实现):光标邻接括号时高亮配对
  cm.on('cursorActivity', (c: CodeMirror.Editor) => updateBracketMatch(c))
  // 自动闭合括号
  cm.on('beforeChange', (c: CodeMirror.Editor, change: CodeMirror.EditorChangeCancellable) => {
    if (change.origin !== '+input') return
    const ch = change.text[0] ?? ''
    if (!ch || ch.length !== 1) return
    if (['(', '[', '{'].includes(ch)) {
      const close = ch === '(' ? ')' : ch === '[' ? ']' : '}'
      const cur = c.getCursor()
      c.replaceRange(close, cur)
    }
  })
  // Ctrl/Cmd + Enter 执行;Tab 缩进
  cm.setOption('extraKeys', {
    'Ctrl-Enter': () => {
      void runQuery()
    },
    'Cmd-Enter': () => {
      void runQuery()
    },
    Tab: (c: CodeMirror.Editor) => {
      const cur = c.getCursor()
      c.replaceSelection('  ')
      c.setCursor({ line: cur.line, ch: cur.ch + 2 })
    }
  })
}

// ── 括号匹配(自实现,markText 高亮)──────────────────────────
let bracketMarks: CodeMirror.TextMarker[] = []

function updateBracketMatch(c: CodeMirror.Editor) {
  // 清除旧标记
  bracketMarks.forEach((m) => m.clear())
  bracketMarks = []
  const pos = c.getCursor().ch
  const line = c.getLine(c.getCursor().line)
  if (!line) return
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  const openers: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const ch = line[pos] ?? ''
  const prev = line[pos - 1] ?? ''
  const mark = (from: { line: number; ch: number }, to: { line: number; ch: number }) => {
    const m = c.markText(from, to, { className: 'bracket-match' })
    bracketMarks.push(m)
  }
  const curLine = c.getCursor().line
  // 光标前是闭合括号 → 向前找
  if (pairs[prev]) {
    const openCh = pairs[prev] ?? ''
    let depth = 0
    const text = c.getValue()
    const idx = c.indexFromPos({ line: curLine, ch: pos - 1 })
    for (let i = idx; i >= 0; i--) {
      const ch2 = text[i] ?? ''
      if (ch2 === prev) depth++
      else if (ch2 === openCh) {
        depth--
        if (depth === 0) {
          const openPos = c.posFromIndex(i)
          mark({ line: curLine, ch: pos - 1 }, { line: curLine, ch: pos })
          mark(openPos, { line: openPos.line, ch: openPos.ch + 1 })
          return
        }
      }
    }
  }
  // 光标后是开括号 → 向后找
  if (openers[ch]) {
    const closeCh = openers[ch] ?? ''
    let depth = 0
    const text = c.getValue()
    const idx = c.indexFromPos({ line: curLine, ch: pos })
    for (let i = idx; i < text.length; i++) {
      const ch2 = text[i] ?? ''
      if (ch2 === ch) depth++
      else if (ch2 === closeCh) {
        depth--
        if (depth === 0) {
          const closePos = c.posFromIndex(i)
          mark({ line: curLine, ch: pos }, { line: curLine, ch: pos + 1 })
          mark(closePos, { line: closePos.line, ch: closePos.ch + 1 })
          return
        }
      }
    }
  }
}

onMounted(() => {
  void initEditor()
})

onUnmounted(() => {
  if (cm) {
    const el = cm.getWrapperElement()
    el.remove()
    cm = null
  }
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
 * 待执行 SQL:优先选中内容;未选中则取光标所在段(分号切分)。
 * 找不到段(如全文只有注释)回退全文。
 */
function getSqlToRun(): string {
  if (!cm) return getSql()
  // 1. 有选区 → 执行选中
  const sel = cm.getSelection()
  if (sel.trim()) return sel
  // 2. 无选区 → 光标所在段
  const cursorIdx = cm.indexFromPos(cm.getCursor())
  for (const seg of splitSqlSegments(cm.getValue())) {
    if (seg.start <= cursorIdx && cursorIdx <= seg.end) {
      const s = seg.sql.trim()
      if (s) return s
    }
  }
  return cm.getValue()
}

// ── SQL 格式化(简单:关键字换行缩进)─────────────────────────
function formatSql() {
  if (!cm) return
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
}

const results = ref<QueryResultItem[]>([])
// 当前激活的结果序号(多条时 tab 切换)
const activeResult = ref(0)

/** 执行单条 SQL 并记录结果 */
async function execOne(sql: string, index: number): Promise<void> {
  try {
    const r = await queryDb(db.value, sql)
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
  }
}

/** 拆 SQL 段并过滤空段/纯注释段 */
function getSegments(text: string): string[] {
  return splitSqlSegments(text)
    .map((s) => s.sql.trim())
    .filter((s) => s && !/^\s*(--|\/\*)/.test(s))
}

/** 执行目标 SQL 段列表(逐条执行,支持多条) */
async function execSegments(segs: string[]) {
  results.value = segs.map((sql) => ({ sql, columns: [], rows: [], costMs: 0, truncated: false }))
  for (let i = 0; i < segs.length; i++) {
    await execOne(segs[i], i)
  }
  // 默认展示最后一个 tab(最新执行的结果)
  activeResult.value = segs.length - 1
}

/** 执行(选中内容 / 光标段;选中内容含多条时逐条执行) */
async function runQuery() {
  if (!db.value) {
    ElMessage.warning('请先选择数据库')
    return
  }
  const target = getSqlToRun().trim()
  if (!target) {
    ElMessage.warning('请输入 SQL')
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

/** 执行全部段(分号切分,逐段执行) */
async function runAllQuery() {
  if (!db.value) {
    ElMessage.warning('请先选择数据库')
    return
  }
  if (!cm) return
  const segs = getSegments(cm.getValue())
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

// ── 数据导出(CSV,含 BOM 防 Excel 乱码)──────────────────────
function exportCsv(idx?: number) {
  const r = idx != null ? results.value[idx] : results.value[0]
  if (!r || r.error || !r.columns.length) {
    ElMessage.warning('没有可导出的数据')
    return
  }
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
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
  try {
    datasources.value = await listDataSources()
    if (datasources.value.length) {
      engine.value = datasources.value[0].type
      db.value = filteredDbs.value[0]?.name || ''
    } else {
      ElMessage.warning('未配置数据库源(检查网关 DB_PROXY_URL)')
    }
  } catch (e) {
    ElMessage.error(`加载数据源失败:${e instanceof Error ? e.message : e}`)
  }
})

watch(engine, (val) => {
  if (!val) return
  const first = datasources.value.find((d) => d.type === val)
  db.value = first?.name || ''
})

/** 单元格是否数值(右对齐) */
function isNumeric(val: unknown): boolean {
  return typeof val === 'number' || (typeof val === 'string' && val !== '' && !Number.isNaN(Number(val)))
}
</script>

<template>
  <div class="db-query">
    <!-- 顶部工具条 -->
    <div class="toolbar">
      <el-select v-model="engine" class="engine-select" placeholder="引擎" clearable @change="db = filteredDbs[0]?.name || ''">
        <el-option label="MySQL" value="mysql" />
        <el-option label="Oracle" value="oracle" />
      </el-select>
      <el-select v-model="db" class="db-select" placeholder="选择数据库" filterable>
        <el-option v-for="d in filteredDbs" :key="d.name" :label="`${d.label || d.name}${d.label && d.label !== d.name ? ` (${d.name})` : ''}`" :value="d.name" />
      </el-select>
      <div class="toolbar-spacer" />
      <el-button class="font-btn" text @click="adjustFont(-1)">A−</el-button>
      <el-button class="font-btn" text @click="adjustFont(1)">A+</el-button>
      <el-divider direction="vertical" />
      <el-button :icon="MagicStick" @click="formatSql">格式化</el-button>
      <el-button :icon="Refresh" @click="runQuery">刷新</el-button>
      <el-button :loading="loading" @click="runAllQuery">执行全部</el-button>
      <el-button type="primary" :icon="CaretRight" :loading="loading" @click="runQuery">
        执行<kbd class="exec-kbd">⌘↵</kbd>
      </el-button>
      <el-divider direction="vertical" />
      <el-button class="theme-btn" text :title="themeMode === 'dark' ? '切换到浅色' : '切换到深色'" @click="toggleTheme">
        <el-icon><Sunny v-if="themeMode === 'dark'" /><Moon v-else /></el-icon>
      </el-button>
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
      <span>· 拖拽分割条调整画布高度</span>
    </div>

    <!-- 错误提示 -->
    <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" class="err-alert" />

    <!-- 结果区(上方 tab + 下方内容,默认选中最后一个) -->
    <div v-if="results.length" class="results-wrap">
      <!-- 上方横向 tab 栏 -->
      <div class="result-tabs">
        <div
          v-for="(r, idx) in results"
          :key="idx"
          class="result-tab"
          :class="{ active: idx === activeResult }"
          @click="activeResult = idx"
        >
          <span class="tab-no">#{{ idx + 1 }}</span>
          <span class="tab-label" :class="{ err: r.error }">
            {{ r.error ? '失败' : `${r.columns.length}列/${r.rows.length}行` }}
          </span>
          <span class="tab-sql" :title="r.sql">{{ r.sql }}</span>
        </div>
      </div>
      <!-- 下方当前结果内容 -->
      <div class="result-content">
        <template v-if="results[activeResult]">
          <div class="result-header">
            <span class="result-meta">
              #{{ activeResult + 1 }} ·
              {{ results[activeResult].error ? '执行失败' : `${results[activeResult].columns.length} 列 · ${results[activeResult].rows.length} 行` }}
              <template v-if="results[activeResult].truncated">(已截断)</template>
              <template v-if="!results[activeResult].error">· {{ results[activeResult].costMs }}ms</template>
            </span>
            <div class="result-actions">
              <el-button v-if="!results[activeResult].error" :icon="Download" size="small" @click="exportCsv(activeResult)">导出 CSV</el-button>
            </div>
          </div>
          <el-alert v-if="results[activeResult].error" type="error" :title="results[activeResult].error" show-icon :closable="false" class="err-alert" />
          <div v-else v-loading="loading" class="result-table-wrap">
            <el-table :data="results[activeResult].rows.slice(0, 200)" border size="small" class="result-table">
              <el-table-column type="index" label="#" width="55" align="center" />
              <el-table-column
                v-for="c in results[activeResult].columns"
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
        </template>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else-if="!loading && !error" class="empty-state">
      <el-empty description="选择数据库,编写 SQL 后执行(Ctrl/Cmd + Enter)" />
    </div>
  </div>
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

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 10px 12px;
  flex-shrink: 0;
}

.engine-select {
  width: 120px;
}

.db-select {
  width: 260px;
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
  height: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: row-resize;
  color: $muted;
  flex-shrink: 0;
  user-select: none;

  &:hover {
    color: $primary;
    background: rgba(94, 106, 210, 0.06);
    border-radius: 3px;
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
  gap: 4px;
  overflow-x: auto;
  flex-shrink: 0;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 6px;
}

.result-tab {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid transparent;
  min-width: 120px;
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;

  &:hover {
    background: rgba(94, 106, 210, 0.06);
  }

  &.active {
    background: rgba(94, 106, 210, 0.1);
    border-color: $primary;
  }
}

.tab-no {
  font-size: 11px;
  color: $muted;
  font-weight: 600;
}

.tab-label {
  font-size: 12px;
  color: $text;

  &.err {
    color: #f56c6c;
  }
}

.tab-sql {
  font-size: 11px;
  color: $muted;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.result-header {
  display: flex;
  align-items: center;
  gap: 12px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  padding: 8px 12px;
}

.result-meta {
  font-size: 13px;
  color: $muted;
}

.result-actions {
  margin-left: auto;
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
</style>
