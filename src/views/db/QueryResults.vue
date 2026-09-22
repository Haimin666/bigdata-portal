<script setup lang="ts">
/**
 * 查询结果面板(2026-09 从 QueryView 拆出):
 *  - tab 栏:固定日志 tab(内容由父组件 slot 传入,pane 0 显示)+ 每个查询一个结果 tab
 *  - 结果内容:分页表格 / 单元格行内编辑(表预览)/ 复制(单元格·本页·整表 TSV)/ 导出 CSV
 *  - 数据源(results/activePane/db)由父持有,交互通过 emits 回传(select/close/rerun/busy)
 */
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DocumentChecked, Loading, Close, Grid, CopyDocument, Download } from '@element-plus/icons-vue'
import { queryDb } from '@/api/db'
import { copyText } from '@/utils/clipboard'

// ── 类型(原 QueryView;组件与父共用)─────────────────────────
/** 单元格待提交修改(row 为结果行在 r.rows 中的索引,由 indexOf(row) 得到) */
export interface PendingEdit {
  row: number
  col: string
  oldVal: unknown
  newVal: unknown
}

export interface QueryResultItem {
  sql: string
  columns: string[]
  rows: Record<string, unknown>[]
  costMs: number
  truncated: boolean
  error?: string
  jobId?: string
  mode?: string
  cached?: boolean // 来自查询历史的结果快照(未重新执行)
  // ── 行内编辑(仅表预览结果)────────────────────────
  editable?: boolean // 是否允许单元格双击编辑
  db?: string // 目标库(onOpenTable 设置)
  table?: string // 目标表(onOpenTable 设置)
  engine?: 'mysql' | 'oracle' // 目标引擎(onOpenTable 设置)
  pkCols?: string[] // 主键列(loadPreviewPk 异步填充)
  pendingEdits?: PendingEdit[]
  running?: boolean // 执行中(结果 tab 状态点)
}

const props = withDefaults(
  defineProps<{
    results: QueryResultItem[]
    activePane: number
    db: string
    engineLabel: string
    loading: boolean
  }>(),
  { db: '', engineLabel: '—', loading: false }
)
const emit = defineEmits<{
  (e: 'select', pane: number): void
  (e: 'close', idx: number): void
  (e: 'rerun', r: QueryResultItem): void
  (e: 'busy', v: boolean): void
  (e: 'manage-flink'): void
}>()

// ═════════════════════ 结果 tab / 分页 ═════════════════════
const currentResult = computed(() => (props.activePane > 0 ? props.results[props.activePane - 1] : null) ?? null)
const pageSize = ref(15)
const pageCurrent = ref(1)
watch(pageSize, () => {
  pageCurrent.value = 1
})
const pagedRows = computed(() => {
  const r = currentResult.value
  if (!r) return []
  const start = (pageCurrent.value - 1) * pageSize.value
  return r.rows.slice(start, start + pageSize.value)
})

// ═════════════════════ 单元格行内编辑(仅表预览 editable) ═════════════════════
const editingCell = ref<{ row: Record<string, unknown>; rowIdx: number; col: string; val: string } | null>(null)
function isEditableCell(_col: string): boolean {
  const r = currentResult.value
  return !!(r?.editable && r.pkCols?.length)
}
function startCellEdit(row: Record<string, unknown>, col: string) {
  const r = currentResult.value
  if (!r?.editable || !r.pkCols?.length) return
  if (r.pkCols.some((pk) => pk.toLowerCase() === col.toLowerCase())) {
    ElMessage.warning('主键列不允许修改')
    return
  }
  editingCell.value = {
    row,
    rowIdx: r.rows.indexOf(row),
    col,
    val: String(row[col] ?? '')
  }
}
const cellEditInputRef = ref<HTMLInputElement>()
function onEditInput() {
  const inp = cellEditInputRef.value
  if (inp && editingCell.value) editingCell.value.val = inp.value
}
function cancelCellEdit() {
  editingCell.value = null
}
async function saveCellEdit() {
  const e = editingCell.value
  editingCell.value = null
  if (!e) return
  const r = props.results[e.rowIdx]
  if (!r) return
  const oldVal = e.row[e.col]
  if (oldVal == null && e.val === '') return // 原 NULL 仍为空:无修改
  if (String(oldVal) === e.val) return
  const newVal = parseCellValue(oldVal, e.val)
  e.row[e.col] = newVal // 先改行值(表格即时反映)
  if (Array.isArray(r.pendingEdits)) {
    const idx = r.pendingEdits.findIndex((p) => p.row === e.rowIdx && p.col.toLowerCase() === e.col.toLowerCase())
    if (idx >= 0) r.pendingEdits[idx] = { row: e.rowIdx, col: e.col, oldVal, newVal }
    else r.pendingEdits.push({ row: e.rowIdx, col: e.col, oldVal, newVal })
  } else {
    r.pendingEdits = [{ row: e.rowIdx, col: e.col, oldVal, newVal }]
  }
}
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
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
/** 组装 UPDATE SQL(主键 WHERE;行内已修改的值转字面量;仅表预览且具备主键) */
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
/** 提交修改:确认完整 SQL → queryDb 逐条执行 → 清空 → 请求父组件重查 */
async function commitEdits() {
  const r = currentResult.value
  if (!r || !r.editable || !r.pendingEdits?.length) return
  const stmts = buildUpdateSql(r)
  if (!stmts.length) {
    ElMessage.warning('没有可提交的修改(主键列无法定位)')
    return
  }
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
  emit('busy', true) // 提交期间互斥,防用户同时执行新查询导致 rerunResult 竞态
  try {
    for (const sql of stmts) {
      await queryDb(r.db || props.db, sql)
    }
    ElMessage.success(`已提交 ${r.pendingEdits.length} 处修改`)
    r.pendingEdits = []
    emit('rerun', r) // 父组件 rerunResult:重查并刷新该结果 tab
  } catch (e) {
    ElMessage.error(`提交失败:${e instanceof Error ? e.message : e}`)
  } finally {
    emit('busy', false)
  }
}

// ═════════════════════ 复制 / 导出 ═════════════════════
function copyCell(val: unknown) {
  void copyText(val).then((ok) => {
    if (ok) ElMessage.success('已复制')
    else ElMessage.warning('复制失败,请手动选择复制')
  })
}
/** 列宽签名:表预览用 库.表,否则用 SQL 前 40 字符(列宽按表格签名持久化,对齐原实现) */
function colSig(): string {
  const r = currentResult.value
  if (!r) return 'default'
  const base = `${r.db || ''}.${r.table || ''}`
  return base !== '.' ? base : (r.sql || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'adhoc'
}
function colInitWidth(c: string): number {
  const n = parseInt(localStorage.getItem(`db-query-colw.${colSig()}.${encodeURIComponent(c)}`) || '', 10)
  return n > 60 ? n : 140
}
function onColResize(newWidth: number, column: { property?: string }) {
  if (!column.property) return
  localStorage.setItem(`db-query-colw.${colSig()}.${encodeURIComponent(column.property)}`, String(Math.round(newWidth)))
}
function isNumeric(val: unknown): boolean {
  return typeof val === 'number' || (typeof val === 'string' && val !== '' && !Number.isNaN(Number(val)))
}
function colIsNumeric(c: string): boolean {
  const row = pagedRows.value[0]
  return !!(row && row[c] != null && isNumeric(row[c]))
}
/** 单元格/列名点击复制(复制模式开=true 才劫持;关时放开文本选择) */
const cellCopy = ref(true)
const cellCopyDisabled = computed(() => !cellCopy.value)
function copyCellSmart(val: unknown) {
  if (!cellCopy.value) return
  copyCell(val)
}
function rowsToTsv(rows: Record<string, unknown>[], cols: string[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[\t\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const head = cols.map(esc).join('\t')
  const body = rows.map((row) => cols.map((c) => esc(row[c])).join('\t')).join('\n')
  return head + '\n' + body
}
async function copyPageTsv() {
  const r = currentResult.value
  if (!r) return
  const ok = await copyText(rowsToTsv(pagedRows.value, r.columns))
  if (ok) ElMessage.success('已复制当前页(TSV)')
  else ElMessage.error('复制失败,请手动复制')
}
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
/** 导出当前结果为 CSV(含 BOM 防 Excel 乱码;防公式注入) */
function exportCsv(idx?: number) {
  let r: QueryResultItem | null
  if (idx != null) r = props.results[idx] ?? null
  else r = currentResult.value
  if (!r || r.error || !r.columns.length) {
    ElMessage.warning('没有可导出的数据')
    return
  }
  const esc = (v: unknown) => {
    let s = v == null ? '' : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = r.columns.map(esc).join(',')
  const lines = r.rows.map((row) => r.columns.map((c) => esc(row[c])).join(','))
  const csv = '\uFEFF' + [header, ...lines].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  const realIdx = idx != null ? idx : props.activePane > 0 ? props.activePane - 1 : 0
  const suffix = props.results.length > 1 ? `_${realIdx + 1}` : ''
  a.download = `${props.db || 'query'}${suffix}_${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
/** 单元格 JSON 完整值弹窗 */
async function showJson(v: unknown) {
  const text = JSON.stringify(v, null, 2) ?? String(v)
  await ElMessageBox.alert(
    `<pre class="dbq-json">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`,
    '单元格值 (JSON)',
    { dangerouslyUseHTMLString: true, customClass: 'dbq-json-dialog' }
  ).catch(() => {})
}
</script>

<template>
  <div class="results-wrap">
    <!-- 上方横向 tab 栏 -->
    <div class="result-tabs">
      <!-- 第一个 tab 固定:日志(只保留最近一次查询的日志) -->
      <div class="result-tab log-tab" :class="{ active: activePane === 0 }" @click="emit('select', 0)">
        <el-icon class="tab-log-icon"><DocumentChecked /></el-icon>
        <span class="tab-name">日志</span>
      </div>
      <!-- 结果 tab(每个查询一个,依次折叠) -->
      <div
        v-for="(r, idx) in results"
        :key="idx"
        class="result-tab"
        :class="{ active: activePane === idx + 1 }"
        @click="emit('select', idx + 1)"
      >
        <el-icon v-if="r.running" class="tab-state tab-spin"><Loading /></el-icon>
        <span v-else class="tab-state" :class="r.error ? 'tab-err' : r.truncated ? 'tab-trunc' : 'tab-ok'" />
        <span class="tab-name" :class="{ err: r.error }">query{{ idx + 1 }}</span>
        <span v-if="r.cached" class="tab-cached-tag" title="来自查询历史的缓存结果">缓存</span>
        <el-tooltip content="关闭" placement="top">
          <span class="tab-close" @click.stop="emit('close', idx)">
            <el-icon><Close /></el-icon>
          </span>
        </el-tooltip>
      </div>
    </div>
    <!-- 下方当前面板内容 -->
    <div class="result-content">
      <!-- 日志面板:内容由父组件通过 #log slot 提供(spark 日志强耦合父的轮询/状态) -->
      <template v-if="activePane === 0">
        <slot name="log" />
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
            v-if="currentResult.rows.length > 15"
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
              <el-button v-if="currentResult.jobId" size="small" text type="primary" @click="emit('manage-flink')">流任务管理</el-button>
              <el-tag v-if="currentResult.jobId" size="small" type="primary">{{ currentResult.jobId }}</el-tag>
              <el-button :disabled="cellCopyDisabled" size="small" text type="primary" @click="copyPageTsv"><el-icon><Grid /></el-icon>复制本页</el-button>
              <el-button :disabled="cellCopyDisabled" size="small" text type="primary" @click="copyAllTsv"><el-icon><CopyDocument /></el-icon>复制整表</el-button>
              <el-tooltip v-if="currentResult && !currentResult.error && currentResult.columns.length" content="下载当前结果 (CSV)" placement="top">
                <el-button size="small" text type="primary" @click="exportCsv()"><el-icon><Download /></el-icon>下载</el-button>
              </el-tooltip>
            </span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.results-wrap {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 8px;
}

/* 横向 tab 条 */
.result-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 2px 0;
  flex-shrink: 0;
  overflow-x: auto;
}
.result-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px 3px;
  border-radius: 6px 6px 0 0;
  border: 1px solid transparent;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  color: var(--bd-text-muted, #8a94a6);
}
.result-tab:hover {
  background: rgba(120, 140, 180, 0.1);
}
.result-tab.active {
  background: var(--bd-panel, #fff);
  border-color: var(--bd-border, #dfe3ea);
  border-bottom-color: transparent;
  color: var(--bd-text, #24292f);
}
.result-tab.log-tab .tab-name {
  font-weight: 600;
}
.tab-log-icon {
  color: var(--bd-primary, #409eff);
  font-size: 13px;
}
.tab-name.err {
  color: #e26d6d;
}
.tab-close {
  display: inline-flex;
  border-radius: 4px;
  padding: 1px;
  opacity: 0;
  transition: opacity 0.15s;
  color: var(--bd-text-muted, #8a94a6);
}
.result-tab:hover .tab-close {
  opacity: 1;
}
.tab-close:hover {
  background: rgba(180, 40, 40, 0.12);
  color: #e05656;
}
.tab-state {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tab-ok {
  background: #67c23a;
}
.tab-err {
  background: #f56c6c;
}
.tab-trunc {
  background: #e6a23c;
}
.tab-spin {
  animation: qspin 0.9s linear infinite;
}
@keyframes qspin {
  from { transform: rotate(0); }
  to { transform: rotate(360deg); }
}
.tab-cached-tag {
  font-size: 10px;
  color: #e6a23c;
  border: 1px solid currentColor;
  border-radius: 3px;
  padding: 0 3px;
  line-height: 1.3;
}

/* 下方内容 */
.result-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.result-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 结果表格占满,但给底部信息条让出空间 */
  padding-bottom: 0;
}
.result-table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--bd-border, #dfe3ea);
  border-radius: 8px 8px 0 0;
  background: var(--bd-panel, #fff);
}
.result-table {
  width: 100%;
}
.err-alert {
  margin: 4px 0;
}
.result-pagination {
  flex-shrink: 0;
  justify-content: flex-end;
  padding: 6px 8px;
  border: 1px solid var(--bd-border, #dfe3ea);
  border-top: none;
  border-radius: 0 0 8px 8px;
  background: var(--bd-table-header, #f7f8fa);
}
.result-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 2px;
  font-size: 12px;
  color: var(--bd-text-muted, #8a94a6);
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
  color: var(--bd-text, #24292f);
  font-weight: 600;
}
.tools {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  cursor: pointer;
}
.mode-toggle.on {
  color: var(--bd-primary, #409eff);
}
.footer-job {
  color: #e6a23c;
  font-weight: 600;
}
.footer-muted {
  color: var(--bd-text-muted, #8a94a6);
}

/* 单元格 */
.col-header {
  cursor: pointer;
  white-space: nowrap;
}
.col-header:hover {
  color: var(--bd-primary, #409eff);
  text-decoration: underline;
}
.row-selectable {
  cursor: text;
}
.cell-val {
  cursor: pointer;
  display: block;
  white-space: pre;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
}
.cell-val.cell-num {
  color: #2f6bd8;
}
.cell-val.cell-select {
  cursor: text;
}
.cell-val.cell-editable {
  cursor: cell;
}
.cell-val.cell-editable:hover {
  background: rgba(230, 162, 60, 0.12);
}
.cell-null {
  color: #b0b8c4;
  font-style: italic;
  cursor: pointer;
}
.cell-json {
  color: #9b59b6;
  cursor: pointer;
  font-weight: 600;
  border: 1px dashed rgba(155, 89, 182, 0.5);
  border-radius: 3px;
  padding: 0 4px;
}
.cell-edit-input {
  width: 100%;
  min-width: 120px;
  border: 1px solid var(--bd-primary, #409eff);
  border-radius: 3px;
  padding: 1px 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: var(--bd-panel, #fff);
  color: var(--bd-text, #24292f);
}
</style>

<style>
/* showJson 弹窗(content 为 body 级,非 scoped) */
.dbq-json {
  max-height: 60vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
}
</style>