/**
 * DB 查询域共享类型(QueryView 与拆出的组件/composable 共用;避免循环依赖)。
 */

/** 单元格待提交修改(row 为结果行在 r.rows 中的索引,由 indexOf(row) 得到) */
export interface PendingEdit {
  row: number
  col: string
  oldVal: unknown
  newVal: unknown
}

/** 一个结果 tab(查询结果或错误;表预览结果带行内编辑元数据) */
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
  engine?: string // 方言: 'oracle' | 'mysql'(onOpenTable 设置)
  pkCols?: string[] // 主键列名(异步 listFields(detail) 取 key==='PRI')
  pendingEdits?: PendingEdit[] // 待提交的单元格修改(同 row+col 去重)
  running?: boolean // 执行中(结果 tab 状态点/底部状态栏)
}

/** 执行器统一返回形状(spark/pyspark/flink/db 异步任务轮询完成后) */
export interface ExecOutcome {
  columns: string[]
  rows: Record<string, unknown>[]
  costMs: number
  truncated: boolean
}

/** SQL 编辑 tab(未命名查询 / 打开的脚本文件 / 表预览) */
export interface EditorTab {
  id: string
  file: { id: number | string; name: string } | null // 绑定的脚本文件;null = 未命名查询
  name: string
  content: string // 内容快照(自动保存/草稿用;编辑实时内容在 model 里)
  dirty: boolean
  /** 每文件独立 Monaco 文档模型:独立撤销历史(Cmd+Z 不串文件)+ 光标位置 */
  model?: import('monaco-editor').editor.ITextModel
}
