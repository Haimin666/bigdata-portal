<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { CaretRight, Download, MagicStick, Refresh, Sunny, Moon } from '@element-plus/icons-vue'
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/sql/sql.js'
import 'codemirror/addon/edit/matchbrackets.js'
import 'codemirror/addon/edit/closebrackets.js'
import 'codemirror/addon/selection/active-line.js'
import { listDataSources, queryDb, type DbDataSource, type DbQueryResult } from '@/api/db'

defineOptions({ name: 'DbQueryView' })

// ── 状态 ─────────────────────────────────────────────────────
const datasources = ref<DbDataSource[]>([])
const engine = ref<'mysql' | 'oracle' | ''>('')
const db = ref('')
const loading = ref(false)
const error = ref('')
const result = ref<DbQueryResult | null>(null)

// 引擎过滤后的数据源
const filteredDbs = computed(() =>
  engine.value ? datasources.value.filter((d) => d.type === engine.value) : datasources.value
)

// ── CodeMirror 编辑器 ───────────────────────────────────────
const cmRef = ref<HTMLElement>()
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

function initEditor() {
  if (!cmRef.value || cm) return
  cm = CodeMirror(cmRef.value, {
    value: DEFAULT_SQL,
    mode: 'text/x-sql',
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    indentWithTabs: false,
    tabSize: 2,
    indentUnit: 2,
    lineWrapping: true,
    styleActiveLine: true,
    theme: 'default'
  })
  // Ctrl/Cmd + Enter 执行
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

onMounted(() => {
  initEditor()
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
async function runQuery() {
  if (!db.value) {
    ElMessage.warning('请先选择数据库')
    return
  }
  const trimmed = getSql().trim()
  if (!trimmed) {
    ElMessage.warning('请输入 SQL')
    return
  }
  loading.value = true
  error.value = ''
  try {
    result.value = await queryDb(db.value, trimmed)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    result.value = null
  } finally {
    loading.value = false
  }
}

// ── 数据导出(CSV,含 BOM 防 Excel 乱码)──────────────────────
function exportCsv() {
  const r = result.value
  if (!r || !r.columns.length) {
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
  a.download = `${db.value || 'query'}_${Date.now()}.csv`
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

// ── 结果分页(前端分页)──────────────────────────────────────
const page = ref(1)
const pageSize = ref(50)
const pagedRows = computed(() => {
  const rows = result.value?.rows ?? []
  const start = (page.value - 1) * pageSize.value
  return rows.slice(start, start + pageSize.value)
})

watch(
  () => result.value,
  () => {
    page.value = 1
  }
)

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
      <span class="font-size">{{ fontSize }}px</span>
      <el-button class="font-btn" text @click="adjustFont(1)">A+</el-button>
      <el-divider direction="vertical" />
      <el-button :icon="MagicStick" @click="formatSql">格式化</el-button>
      <el-button :icon="Refresh" @click="runQuery">刷新</el-button>
      <el-button type="primary" :icon="CaretRight" :loading="loading" @click="runQuery">
        执行<kbd class="exec-kbd">⌘↵</kbd>
      </el-button>
      <el-divider direction="vertical" />
      <el-button class="theme-btn" text :title="themeMode === 'dark' ? '切换到浅色' : '切换到深色'" @click="toggleTheme">
        <el-icon><Sunny v-if="themeMode === 'dark'" /><Moon v-else /></el-icon>
      </el-button>
    </div>

    <!-- SQL 画布(CodeMirror) -->
    <div class="sql-canvas" :class="themeMode" :style="{ height: canvasHeight + 'px' }">
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

    <!-- 结果区 -->
    <div v-if="result" class="result-wrap">
      <div class="result-header">
        <span class="result-meta">
          {{ result.columns.length }} 列 · {{ result.rows.length }} 行
          <template v-if="result.truncated">(已截断)</template>
          · {{ result.costMs }}ms
        </span>
        <div class="result-actions">
          <el-button :icon="Download" size="small" @click="exportCsv">导出 CSV</el-button>
        </div>
      </div>
      <div v-loading="loading" class="result-table-wrap">
        <el-table :data="pagedRows" border size="small" class="result-table">
          <el-table-column type="index" label="#" width="55" align="center" :index="(i: number) => (page - 1) * pageSize + i + 1" />
          <el-table-column
            v-for="c in result.columns"
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
      <!-- 分页条 -->
      <div v-if="result.rows.length > pageSize" class="result-pagination">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="result.rows.length"
          :page-sizes="[50, 100, 200]"
          layout="total, sizes, prev, pager, next"
          background
          small
        />
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

.font-size {
  font-size: 12px;
  color: $muted;
  min-width: 34px;
  text-align: center;
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
  background: #282c34;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;

  &.light {
    background: #fff;
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

  /* ── 深色主题(One Dark) ─────────────────────────────── */
  .sql-canvas.dark & {
    :deep(.CodeMirror) {
      background: #282c34;
      color: #abb2bf;
    }
    :deep(.CodeMirror-gutters) {
      background: #21252b;
      border-right: 1px solid #181a1f;
    }
    :deep(.CodeMirror-linenumber) {
      color: #495162;
    }
    :deep(.CodeMirror-cursor) {
      border-left-color: #fff;
    }
    :deep(.cm-keyword) {
      color: #c678dd;
      font-weight: 600;
    }
    :deep(.cm-string) {
      color: #98c379;
    }
    :deep(.cm-comment) {
      color: #5c6370;
      font-style: italic;
    }
    :deep(.cm-number) {
      color: #d19a66;
    }
    :deep(.cm-builtin) {
      color: #61afef;
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

  /* ── 浅色主题(GitHub 风格) ───────────────────────────── */
  .sql-canvas.light & {
    :deep(.CodeMirror) {
      background: #fff;
      color: #24292e;
    }
    :deep(.CodeMirror-gutters) {
      background: #f6f8fa;
      border-right: 1px solid #d0d7de;
    }
    :deep(.CodeMirror-linenumber) {
      color: #6e7781;
    }
    :deep(.CodeMirror-cursor) {
      border-left-color: #24292e;
    }
    :deep(.CodeMirror-selected) {
      background: rgba(9, 105, 218, 0.2);
    }
    :deep(.CodeMirror-activeline-background) {
      background: rgba(9, 105, 218, 0.05);
    }
    :deep(.cm-keyword) {
      color: #cf222e;
      font-weight: 600;
    }
    :deep(.cm-string) {
      color: #0a3069;
    }
    :deep(.cm-comment) {
      color: #6e7781;
      font-style: italic;
    }
    :deep(.cm-number) {
      color: #0550ae;
    }
    :deep(.cm-builtin) {
      color: #8250df;
    }
    :deep(.cm-variable) {
      color: #953800;
    }
    :deep(.cm-operator) {
      color: #0550ae;
    }
    :deep(.cm-matchingbracket) {
      color: #cf222e;
    }
  }
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

/* ── 结果区 ───────────────────────────────────────────────── */
.result-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 200px;
  flex-shrink: 0;
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
