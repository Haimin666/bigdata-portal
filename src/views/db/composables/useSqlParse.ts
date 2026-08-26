/**
 * SQL 解析/编辑纯工具(自 QueryView.vue 迁出,2026-08):
 *  - splitSqlSegments:引号感知的分号切分(字符串/反引号/注释内的分号不切段)
 *  - sqlLiteral / parseCellValue / findRowKey / escapeHtml / rowsToTsv / maskFormatSql:
 *    结果编辑与导出的无副作用辅助函数
 * 全部为纯函数;涉及 CodeMirror 实例/组件状态的逻辑仍留在视图层。
 */

/** 按分号切分 SQL 段(跳过字符串/反引号/注释内的分号) */
export function splitSqlSegments(text: string): { start: number; end: number; sql: string }[] {
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

/** 输入文本按原值类型还原(number 尽量转数值,其余保持字符串) */
export function parseCellValue(oldVal: unknown, raw: string): unknown {
  if (typeof oldVal === 'number') {
    const n = Number(raw)
    return Number.isNaN(n) ? raw : n
  }
  if (typeof oldVal === 'boolean') return raw === 'true'
  return raw
}

/** SQL 字面量:数字/布尔/null 原样,字符串/日期用单引号并转义 ''。
 *  isOracle=true 时不再双写反斜杠:Oracle 无此转义语义,双写 \ 会改变存储值。 */
export function sqlLiteral(v: unknown, isOracle = false): string {
  if (v == null) return 'NULL'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (isOracle) return `'${String(v).replace(/'/g, "''")}'`
  // MySQL/Doris 字符串字面量中反斜杠是转义符:先转义 \ 再转义 '
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

/** HTML 转义(确认弹窗展示完整 SQL 用) */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 在 row 中按大小写不敏感查找列名对应的键(找不到返回原列名) */
export function findRowKey(row: Record<string, unknown>, col: string): string {
  if (col in row) return col
  const upper = col.toUpperCase()
  const hit = Object.keys(row).find((k) => k.toUpperCase() === upper)
  return hit || col
}

/** 行记录转 TSV(带表头;null 输出空串) */
export function rowsToTsv(rows: Record<string, unknown>[], cols: string[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    // 含制表符/换行的字段用双引号包围并转义,防止破坏 TSV 结构
    return /[\t\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const head = cols.map(esc).join('\t')
  const body = rows.map((row) => cols.map((c) => esc(row[c])).join('\t')).join('\n')
  return head + '\n' + body
}

/** SQL 格式化核心(纯函数):屏蔽字符串/反引号字面量与注释 → 关键字前换行 → 还原。
 *  python 模式不支持由调用方拦截;返回格式化后的全文文本。 */
export function maskFormatSql(s: string): string {
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
  return out.replace(/\n{2,}/g, '\n').trim()
}
