<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { CaretRight, Download, Refresh } from '@element-plus/icons-vue'
import { listDataSources, queryDb, type DbDataSource, type DbQueryResult } from '@/api/db'

defineOptions({ name: 'DbQueryView' })

// ── 状态 ─────────────────────────────────────────────────────
const datasources = ref<DbDataSource[]>([])
const engine = ref<'mysql' | 'oracle' | ''>('')
const db = ref('')
const sql = ref('')
const loading = ref(false)
const error = ref('')
const result = ref<DbQueryResult | null>(null)
const totalMs = ref(0)

// SQL 编辑器:textarea 底层 + 高亮覆盖层
const editorRef = ref<HTMLTextAreaElement>()
const highlightRef = ref<HTMLElement>()

// 引擎过滤后的数据源
const filteredDbs = computed(() =>
  engine.value ? datasources.value.filter((d) => d.type === engine.value) : datasources.value
)

// 默认 SQL 模板
const DEFAULT_SQL = `-- 在这里编写 SQL 查询(只读)
-- 快捷键:Ctrl/Cmd + Enter 执行
SELECT * FROM your_table LIMIT 50;`

// ── SQL 语法高亮(轻量,零依赖)──────────────────────────────
const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AS', 'AND', 'OR', 'NOT',
  'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'DISTINCT', 'UNION', 'ALL', 'CASE',
  'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'COUNT', 'SUM', 'AVG', 'MIN',
  'MAX', 'EXISTS', 'FETCH', 'FIRST', 'ROWS', 'ONLY', 'ROWNUM', 'WITH', 'TABLE'
])

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 轻量 SQL 高亮:关键字(蓝)、字符串(绿)、注释(灰)、数字(橙) */
function highlightSql(code: string): string {
  // 逐 token 处理,保持换行
  const tokens = code.split(/(\s+|'[^']*'|"[^"]*"|--[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b\d+(?:\.\d+)?\b)/g)
  return tokens
    .map((t) => {
      if (!t) return ''
      if (/^\s+$/.test(t)) return escapeHtml(t)
      if (/^--|^\/\//.test(t)) return `<span class="tok-comment">${escapeHtml(t)}</span>`
      if (/^\/\*[\s\S]*\*\/$/.test(t)) return `<span class="tok-comment">${escapeHtml(t)}</span>`
      if (/^'[^']*'$|^"[^"]*"$/.test(t)) return `<span class="tok-string">${escapeHtml(t)}</span>`
      if (/^\d+(\.\d+)?$/.test(t)) return `<span class="tok-number">${escapeHtml(t)}</span>`
      const up = t.toUpperCase()
      if (KEYWORDS.has(up)) return `<span class="tok-keyword">${escapeHtml(up)}</span>`
      return escapeHtml(t)
    })
    .join('')
}

const highlighted = computed(() => highlightSql(sql.value))

// 编辑器滚动同步(textarea 与高亮层)
function onScroll() {
  if (editorRef.value && highlightRef.value) {
    highlightRef.value.scrollTop = editorRef.value.scrollTop
    highlightRef.value.scrollLeft = editorRef.value.scrollLeft
  }
}

// Tab 键插入两个空格
function onKeydown(e: KeyboardEvent) {
  // Ctrl/Cmd + Enter 执行
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    runQuery()
    return
  }
  if (e.key === 'Tab') {
    e.preventDefault()
    const el = editorRef.value
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    sql.value = sql.value.slice(0, start) + '  ' + sql.value.slice(end)
    nextTick(() => {
      el.selectionStart = el.selectionEnd = start + 2
    })
  }
}

// ── 查询执行 ─────────────────────────────────────────────────
async function runQuery() {
  if (!db.value) {
    ElMessage.warning('请先选择数据库')
    return
  }
  const trimmed = sql.value.trim()
  if (!trimmed) {
    ElMessage.warning('请输入 SQL')
    return
  }
  loading.value = true
  error.value = ''
  const t0 = performance.now()
  try {
    result.value = await queryDb(db.value, trimmed)
    totalMs.value = Math.round(performance.now() - t0)
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

// ── 初始化 ───────────────────────────────────────────────────
onMounted(async () => {
  sql.value = DEFAULT_SQL
  try {
    datasources.value = await listDataSources()
    if (datasources.value.length) {
      // 默认选中第一个类型
      engine.value = datasources.value[0].type
      db.value = filteredDbs.value[0]?.name || ''
    } else {
      ElMessage.warning('未配置数据库源(检查网关 DB_PROXY_URL)')
    }
  } catch (e) {
    ElMessage.error(`加载数据源失败:${e instanceof Error ? e.message : e}`)
  }
})

// 引擎切换 → 重置 db 到该引擎第一个
watch(engine, (val) => {
  if (!val) return
  const first = datasources.value.find((d) => d.type === val)
  db.value = first?.name || ''
})
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
        <el-option v-for="d in filteredDbs" :key="d.name" :label="`${d.name} (${d.type})`" :value="d.name" />
      </el-select>
      <div class="toolbar-spacer" />
      <el-button :icon="Refresh" @click="runQuery">刷新</el-button>
      <el-button type="primary" :icon="CaretRight" :loading="loading" @click="runQuery">执行</el-button>
    </div>

    <!-- SQL 画布(编辑器 + 高亮) -->
    <div class="sql-canvas">
      <div class="sql-gutter" ref="highlightRef">
        <pre class="sql-highlight" v-html="highlighted"></pre>
      </div>
      <textarea
        ref="editorRef"
        v-model="sql"
        class="sql-input"
        spellcheck="false"
        autocomplete="off"
        @scroll="onScroll"
        @keydown="onKeydown"
      ></textarea>
    </div>
    <div class="sql-hint">Ctrl/Cmd + Enter 执行 · Tab 缩进</div>

    <!-- 错误提示 -->
    <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" class="err-alert" />

    <!-- 结果区 -->
    <div v-if="result" class="result-wrap">
      <div class="result-header">
        <span class="result-meta">
          共 {{ result.rows.length }} 行
          <template v-if="result.truncated">(已截断)</template>
          · 耗时 {{ result.costMs }}ms
        </span>
        <div class="result-actions">
          <el-button :icon="Download" size="small" @click="exportCsv">导出 CSV</el-button>
        </div>
      </div>
      <div v-loading="loading" class="result-table-wrap">
        <el-table :data="result.rows" border size="small" class="result-table">
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
              {{ row[c] == null ? 'NULL' : row[c] }}
            </template>
          </el-table-column>
        </el-table>
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
  gap: 12px;
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

/* ── SQL 画布 ─────────────────────────────────────────────── */
.sql-canvas {
  position: relative;
  display: flex;
  background: #1e1e1e;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  height: 280px;
}

.sql-gutter {
  flex: 1;
  overflow: hidden;
  padding: 12px 0 12px 16px;
}

.sql-highlight {
  margin: 0;
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #d4d4d4;
  white-space: pre-wrap;
  word-break: break-all;
  min-height: 100%;

  :deep(.tok-keyword) {
    color: #569cd6;
    font-weight: 600;
  }
  :deep(.tok-string) {
    color: #ce9178;
  }
  :deep(.tok-comment) {
    color: #6a9955;
    font-style: italic;
  }
  :deep(.tok-number) {
    color: #b5cea8;
  }
}

.sql-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 12px 16px;
  background: transparent;
  color: transparent;
  caret-color: #fff;
  border: none;
  outline: none;
  resize: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.sql-hint {
  font-size: 12px;
  color: $muted;
  flex-shrink: 0;
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
  /* 与 YARN 表格一致:表头浅灰底、紧凑行距由全局 .el-table 统一 */
}

.result-table {
  width: 100%;
  /* 表头吸顶,滚动时表头固定(类似 YARN 表格体验) */
  :deep(th.el-table__cell) {
    position: sticky;
    top: 0;
    z-index: 1;
  }
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
