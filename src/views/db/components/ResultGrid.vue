<script setup lang="ts">
/**
 * ResultGrid —— 查询结果区(自 QueryView.vue 拆出,2026-08):
 * 结果 tab 栏 + 日志面板入口(SparkLogPanel) + 结果表格(分页/列宽持久化/点击复制/JSON 折叠)
 * + 行内编辑(pendingEdits) + 底部工具条。展示与局部交互在此;跨组件状态经 props/emits。
 * 约束:不直接调执行 API —— 提交修改/重跑等经 emit 由宿主编排(runner 互斥在宿主)。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Loading, DocumentChecked, Close, Download, CopyDocument, Grid } from '@element-plus/icons-vue'
import SparkLogPanel from './SparkLogPanel.vue'
import type { PendingEdit, QueryResultItem } from '../queryTypes'
import { parseCellValue, sqlLiteral, escapeHtml, findRowKey, rowsToTsv } from '../composables/useSqlParse'
import { copyText } from '@/utils/clipboard'

const props = defineProps<{
  results: QueryResultItem[]
  activePane: number
  loading: boolean
  /** Spark 日志面板三件套 */
  sparkLogText: string
  logEmptyHint: string
  sparkStageData: unknown
  sparkLogActive: boolean
}>()

const emit = defineEmits<{
  (e: 'select-pane', pane: number): void
  (e: 'close-tab', idx: number): void
  /** 提交行内修改(宿主走 queryDb 执行并 rerun) */
  (e: 'commit-edits', r: QueryResultItem): void
  /** 打开 Flink 流任务管理弹窗 */
  (e: 'open-flink-jobs'): void
  (e: 'poll-logs'): void
  (e: 'clear-logs'): void
  /** 日志面板实例挂载转发(父级轮询裁剪需要 maxLines) */
  (e: 'panel-mounted', p: unknown): void
}>()

const sparkLogPanelRef = ref<InstanceType<typeof SparkLogPanel> | null>(null)
watch(sparkLogPanelRef, (p) => emit('panel-mounted', p))

const currentResult = computed(() =>
  props.activePane > 0 ? (props.results[props.activePane - 1] ?? null) : null
)

// ── 分页 ───────────────────────────────────────────────────
const pageSize = ref(15)
const pageCurrent = ref(1)
// 切换每页条数时回到第 1 页,避免停留在越界页导致分页区异常
watch(pageSize, () => {
  pageCurrent.value = 1
})
watch(
  () => props.activePane,
  () => {
    pageCurrent.value = 1 // 切换结果 tab 回第一页(原 selectPane 行为)
  }
)
const pagedRows = computed(() => {
  const r = currentResult.value
  if (!r) return []
  const start = (pageCurrent.value - 1) * pageSize.value
  return r.rows.slice(start, start + pageSize.value)
})

function selectPane(pane: number) {
  emit('select-pane', pane)
}

/** 关闭某个结果 tab(日志 tab 恒为第 0 个不可关);激活态修正逻辑同原实现 */
function closeResultTab(idx: number) {
  if (idx < 0 || idx >= props.results.length) return
  emit('close-tab', idx)
}

// ── 列宽持久化(localStorage 按 表.库 / SQL 签名)─────────────
/** 结果表格签名:表预览用 库.表,否则用 SQL 前 40 字符 */
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

// ── 数值判定(右对齐)────────────────────────────────────────
function isNumeric(val: unknown): boolean {
  return typeof val === 'number' || (typeof val === 'string' && val !== '' && !Number.isNaN(Number(val)))
}
function colIsNumeric(c: string): boolean {
  const row = pagedRows.value[0]
  return !!(row && row[c] != null && isNumeric(row[c]))
}

// ── 复制模式 + 单元格复制 ───────────────────────────────────
/** 复制模式开=true(点击单元格即复制);关=false 时可自由选中文本 */
const cellCopy = ref(true)
const cellCopyDisabled = computed(() => !cellCopy.value)

async function copyCellSmart(val: unknown) {
  if (!cellCopy.value) return
  const ok = await copyText(val)
  if (ok) ElMessage.success('已复制')
  else ElMessage.warning('复制失败,请手动选择复制')
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
    const confirmed = await ElMessageBox.confirm('共 ' + r.rows.length + ' 行,复制全部可能较大。仍要继续吗?', '复制整表', {
      confirmButtonText: '继续复制',
      cancelButtonText: '取消',
      type: 'warning'
    }).catch(() => false)
    if (!confirmed) return
  }
  const ok = await copyText(rowsToTsv(r.rows, r.columns))
  if (ok) ElMessage.success('已复制 ' + r.rows.length + ' 行(TSV)')
  else ElMessage.error('复制失败,请手动复制')
}

/** JSON 复合值折叠查看(弹窗展示转义后的格式化文本) */
async function showJson(v: unknown) {
  const text = JSON.stringify(v, null, 2) ?? String(v)
  await ElMessageBox.alert(`<pre class="dbq-json">${escapeHtml(text)}</pre>`, '单元格值 (JSON)', {
    dangerouslyUseHTMLString: true,
    customClass: 'dbq-json-dialog'
  }).catch(() => {})
}

// ── CSV 导出(含 BOM 防 Excel 乱码;防公式注入)───────────────
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
  const realIdx = idx != null ? idx : props.activePane > 0 ? props.activePane - 1 : 0
  const suffix = props.results.length > 1 ? `_${realIdx + 1}` : ''
  a.download = `query${suffix}_${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

// ── 行内编辑(仅表预览结果 editable;pendingEdits 记录在结果对象上)──
const editingCell = ref<{ row: Record<string, unknown>; rowIdx: number; col: string; val: string } | null>(null)

function isEditableCell(_col: string): boolean {
  const r = currentResult.value
  return !!r && !!r.editable && !!r.pkCols?.length
}

/** 双击进入编辑(主键列拒绝;NULL 不编辑) */
function startCellEdit(row: Record<string, unknown>, col: string) {
  const r = currentResult.value
  if (!r || !r.editable || !r.pkCols?.length) return
  const v = row[col]
  if (v == null) return
  if (r.pkCols.some((pk) => pk.toUpperCase() === col.toUpperCase())) {
    ElMessage.warning('主键列不允许编辑')
    return
  }
  const rowIdx = r.rows.indexOf(row)
  if (rowIdx < 0) return
  editingCell.value = { row, rowIdx, col, val: String(v) }
  void nextTick(() => {
    cellEditInputRef.value?.focus()
    cellEditInputRef.value?.select()
  })
}

const cellEditInputRef = ref<HTMLInputElement>()

function onEditInput() {
  const inp = cellEditInputRef.value
  if (inp && editingCell.value) editingCell.value.val = inp.value
}

/**
 * 失焦保存:按行对象引用定位所属结果(编辑中切 tab 时 currentResult 已变),
 * 同 row+col 去重覆盖;本地立即反映新值。
 */
function saveCellEdit() {
  const e = editingCell.value
  editingCell.value = null
  if (!e) return
  const r = props.results.find((x) => x.rows.includes(e.row))
  if (!r || !r.editable) return
  const newVal = parseCellValue(e.row[e.col], e.val)
  const oldVal = e.row[e.col]
  if (newVal === oldVal) return // 值未变不记录
  const pending: PendingEdit[] = r.pendingEdits || (r.pendingEdits = [])
  const idx = pending.findIndex((p) => p.row === e.rowIdx && p.col === e.col)
  const edit = { row: e.rowIdx, col: e.col, oldVal, newVal }
  if (idx >= 0) pending[idx] = edit
  else pending.push(edit)
  e.row[e.col] = newVal
}

function cancelCellEdit() {
  editingCell.value = null
}

/** 按 row 分组生成 UPDATE 语句(MySQL 反引号 / Oracle 双引号;主键取行内当前值;NULL 主键整行跳过) */
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
    const sets = edits
      .map((p) => {
        const key = findRowKey(row, p.col)
        return `${q(key)} = ${sqlLiteral(p.newVal, isOracle)}`
      })
      .join(', ')
    const wheres: string[] = []
    for (const pk of r.pkCols) {
      const key = findRowKey(row, pk)
      const v = row[key]
      if (v == null) {
        wheres.length = 0 // NULL 主键无法定位,整行跳过
        break
      }
      wheres.push(`${q(key)} = ${sqlLiteral(v, isOracle)}`)
    }
    if (!wheres.length) continue
    stmts.push(`UPDATE ${tbl} SET ${sets} WHERE ${wheres.join(' AND ')}`)
  }
  return stmts
}

/** 提交修改按钮:确认完整 SQL → 宿主执行(queryDb 逐条 + rerun) */
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
    await ElMessageBox.confirm(`<pre class="edit-sql-preview">${escapeHtml(stmts.join('\n'))}</pre>`, `确认提交 ${r.pendingEdits.length} 处修改?`, {
      dangerouslyUseHTMLString: true,
      confirmButtonText: '确认提交',
      cancelButtonText: '取消',
      type: 'warning'
    })
    confirmed = true
  } catch {
    /* 取消 */
  }
  if (!confirmed) return
  emit('commit-edits', r)
}
</script>

<template>
  <!-- 上方横向 tab 栏 -->
  <div class="result-tabs">
    <!-- 第一个 tab 固定:日志 -->
    <div class="result-tab log-tab" :class="{ active: activePane === 0 }" @click="selectPane(0)">
      <el-icon class="tab-log-icon"><DocumentChecked /></el-icon>
      <span class="tab-name">日志</span>
      <span v-if="sparkLogText" class="tab-dot" title="有日志输出" />
    </div>
    <!-- 结果 tab -->
    <div v-for="(r, idx) in results" :key="idx" class="result-tab" :class="{ active: activePane === idx + 1 }" @click="selectPane(idx + 1)">
      <el-icon v-if="r.running" class="tab-state tab-spin"><Loading /></el-icon>
      <span v-else class="tab-state" :class="r.error ? 'tab-err' : r.truncated ? 'tab-trunc' : 'tab-ok'" />
      <span class="tab-name" :class="{ err: r.error }">query{{ idx + 1 }}</span>
      <span v-if="r.cached" class="tab-cached-tag" title="来自查询历史的缓存结果">缓存</span>
      <el-tooltip content="关闭" placement="top">
        <span class="tab-close" @click.stop="closeResultTab(idx)">
          <el-icon><Close /></el-icon>
        </span>
      </el-tooltip>
    </div>
  </div>
  <!-- 下方当前面板内容 -->
  <div class="result-content">
    <!-- 日志面板(tab 0) -->
    <template v-if="activePane === 0">
      <div class="result-card log-card">
        <div class="spark-logs-head">
          <span class="spark-logs-title"><el-icon><DocumentChecked /></el-icon> 引擎日志(最近一次查询)</span>
          <span class="spark-logs-actions">
            <el-button text size="small" @click="emit('poll-logs')">刷新</el-button>
            <el-button text size="small" @click="emit('clear-logs')">清空</el-button>
          </span>
        </div>
        <SparkLogPanel
          ref="sparkLogPanelRef"
          :log-text="sparkLogText"
          :empty-hint="logEmptyHint"
          :stage-data="sparkStageData as never"
          :active="sparkLogActive"
          @refresh="emit('poll-logs')"
          @clear="emit('clear-logs')"
        />
      </div>
    </template>
    <!-- 结果内容 -->
    <template v-else-if="currentResult">
      <el-alert v-if="currentResult.error" type="error" :title="currentResult.error" show-icon :closable="false" class="err-alert" />
      <div v-else class="result-card">
        <div v-loading="loading" class="result-table-wrap">
          <el-table :data="pagedRows" border stripe size="small" class="result-table" empty-text="无数据" :row-class-name="() => (cellCopyDisabled ? 'row-selectable' : '')" @header-dragend="onColResize">
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
              <template #header>
                <span class="col-header" :title="`点击复制列名: ${c}`" @click.stop="copyCellSmart(c)">{{ c }}</span>
              </template>
              <template #default="{ row }">
                <span v-if="editingCell && editingCell.row === row && editingCell.col === c" class="cell-edit">
                  <input ref="cellEditInputRef" :value="editingCell.val" class="cell-edit-input" spellcheck="false" @input="onEditInput" @blur="saveCellEdit" @keydown.esc.prevent="cancelCellEdit" @keydown.enter.prevent="saveCellEdit" />
                </span>
                <span v-else-if="row[c] == null" class="cell-null" :title="`NULL${cellCopy ? ' · 点击复制' : ''}`" @click="copyCellSmart(row[c])">NULL</span>
                <span v-else-if="typeof row[c] === 'object'" class="cell-json" title="点击查看完整 JSON" @click.stop="showJson(row[c])">JSON</span>
                <span
                  v-else
                  class="cell-val"
                  :class="{ 'cell-num': isNumeric(row[c]), 'cell-select': cellCopyDisabled, 'cell-editable': isEditableCell(c) }"
                  :title="isEditableCell(c) ? `双击编辑: ${row[c]}` : (cellCopy ? `点击复制: ${row[c]}` : row[c])"
                  @click="copyCellSmart(row[c])"
                  @dblclick="startCellEdit(row, c)"
                  >{{ row[c] }}</span
                >
              </template>
            </el-table-column>
          </el-table>
        </div>
        <!-- 翻页 -->
        <el-pagination v-if="(currentResult.rows.length || 0) > 15" v-model:current-page="pageCurrent" v-model:page-size="pageSize" class="result-pagination" :page-sizes="[15, 50, 100, 200]" :total="currentResult.rows.length" layout="total, sizes, prev, pager, next" small />
        <!-- 底部信息条 -->
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
            <el-button v-if="currentResult.editable && (currentResult.pendingEdits?.length ?? 0) > 0" size="small" type="warning" plain @click="commitEdits">提交修改 ({{ currentResult.pendingEdits?.length ?? 0 }})</el-button>
            <el-button v-if="currentResult.jobId" size="small" text type="primary" @click="emit('open-flink-jobs')">流任务管理</el-button>
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
</template>

<style scoped lang="scss">
/* 样式逐字迁自 QueryView 结果区块(选择器不变,便于回溯) */
.result-tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 4px 6px 0;
  overflow-x: auto;
  flex-shrink: 0;

  &::-webkit-scrollbar {
    height: 4px;
  }

  &::-webkit-scrollbar-thumb {
    background: $border;
    border-radius: 2px;
  }
}

.result-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  font-size: 12px;
  color: $muted;
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;

  &:hover {
    color: $text;
    background: rgba(127, 127, 127, 0.09);
  }

  &.active {
    color: $primary;
    background: $bg;
    border-color: $border;
  }
}

.tab-name {
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;

  &.err {
    color: #f56c6c;
  }
}

.tab-cached-tag {
  font-size: 10px;
  line-height: 14px;
  padding: 0 4px;
  border-radius: 3px;
  color: $primary;
  background: rgba(64, 158, 255, 0.12);
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  color: $muted;
  opacity: 0.55;

  &:hover {
    opacity: 1;
    background: rgba(127, 127, 127, 0.18);
  }
}

.log-tab {
  .tab-log-icon {
    color: $muted;
  }

  &.active .tab-log-icon {
    color: $primary;
  }
}

.tab-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: $primary;
}

.result-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
  padding: 8px;
}

.log-card,
.result-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: $panel;
  border: 1px solid $border;
  border-radius: 8px;
  overflow: hidden;
}

.spark-logs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-bottom: 1px solid $border;
  flex-shrink: 0;

  .spark-logs-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: $muted;
  }

  .spark-logs-actions {
    display: inline-flex;
    gap: 4px;
  }
}

.err-alert {
  flex-shrink: 0;
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

  :deep(.col-header) {
    display: inline-flex;
    align-items: center;
    cursor: copy;
    min-width: 0;
    max-width: calc(100% - 22px);
    padding-right: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    &:hover {
      color: $primary;
      text-decoration: underline dotted;
    }
  }

  :deep(.caret-wrapper) {
    right: 6px;
  }

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

  :deep(.cell-editable) {
    cursor: cell;

    &:hover {
      background: var(--el-color-warning-light-9);
    }
  }

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

:deep(.row-selectable .cell) {
  cursor: text;
  user-select: text;
}

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

.result-pagination {
  display: flex;
  justify-content: flex-end;
  background: $panel;
  border-top: 1px solid $border;
  padding: 6px 12px;
  flex-shrink: 0;
}

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
  animation: rg-spin 1s linear infinite;
  color: $primary;
}

@keyframes rg-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}
</style>
