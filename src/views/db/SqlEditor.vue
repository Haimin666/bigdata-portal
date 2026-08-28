<script setup lang="ts">
/**
 * SQL 画布编辑器(Monaco 封装)。
 * 职责:
 *  - model 池:每个 tab 一个 ITextModel(独立撤销历史/光标),切换 modelId 即切换文档
 *  - 补全:关键字 + schema 表/列(点语法) + 文中词;provider 按需节流,候选上限截断,
 *    Monaco 虚拟滚动渲染 —— 根治 CM5 时代"每键全扫 + 上千候选一次性渲染 DOM"的卡死
 *  - 快捷键:Cmd/Ctrl+Enter 执行、Cmd+S 保存、Cmd+Shift+F 格式化、Cmd+/ 注释、
 *    Shift+Tab 反缩进(Tab 由 Monaco 原生:补全浮层选词/多行缩进,无需干预)
 *  - 主题/字号/语言联动
 * 对外(defineExpose)提供与旧 CodeMirror 兼容的 API 面,QueryView 其余逻辑零改动。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { monaco, definePortalThemes, editorUri } from '@/utils/monaco-setup'

// ── Props / Emits ────────────────────────────────────────────
interface SchemaMeta {
  tables: Array<{ name: string; comment?: string; columns: Array<{ name: string; type?: string }> }>
}
const props = withDefaults(
  defineProps<{
    modelId: string
    value?: string
    language?: 'sql' | 'python'
    themeMode?: 'dark' | 'light'
    fontSize?: number
    currentDb?: string
    schemaLoader?: (db: string) => Promise<SchemaMeta | null>
  }>(),
  {
    value: '',
    language: 'sql',
    themeMode: 'dark',
    fontSize: 14,
    currentDb: '',
    schemaLoader: undefined
  }
)
const emit = defineEmits<{
  (e: 'change'): void
  (e: 'exec'): void
  (e: 'save'): void
  (e: 'format'): void
  (e: 'ready'): void
}>()

// ── 常量 ─────────────────────────────────────────────────────
const SQL_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'INSERT', 'UPDATE', 'DELETE', 'SET', 'VALUES', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'IS', 'BETWEEN', 'LIKE']
const MAX_SUGGEST = 120 // 候选上限(截断;Monaco 虚拟滚动无 DOM 压力,控制提示质量)
const WORD_RE = /[A-Za-z_][A-Za-z0-9_$]{2,}/g // 文中词(长度≥3,过滤单双字母噪声)

// ── 内置函数(聚合/字符串/数学/日期/流程/窗口;detail 显示签名,插入带参数占位)
const SQL_FUNCTIONS: Array<{ name: string; sig: string }> = [
  { name: 'COUNT', sig: 'COUNT(expr | *)' },
  { name: 'SUM', sig: 'SUM(expr)' },
  { name: 'AVG', sig: 'AVG(expr)' },
  { name: 'MIN', sig: 'MIN(expr)' },
  { name: 'MAX', sig: 'MAX(expr)' },
  { name: 'GROUP_CONCAT', sig: 'GROUP_CONCAT(expr [, sep])' },
  { name: 'STDDEV', sig: 'STDDEV(expr)' },
  { name: 'CONCAT', sig: 'CONCAT(str, ...)' },
  { name: 'CONCAT_WS', sig: 'CONCAT_WS(sep, str, ...)' },
  { name: 'SUBSTRING', sig: 'SUBSTRING(str, pos[, len])' },
  { name: 'LENGTH', sig: 'LENGTH(str)' },
  { name: 'TRIM', sig: 'TRIM([BOTH] str)' },
  { name: 'LOWER', sig: 'LOWER(str)' },
  { name: 'UPPER', sig: 'UPPER(str)' },
  { name: 'REPLACE', sig: 'REPLACE(str, from, to)' },
  { name: 'LEFT', sig: 'LEFT(str, len)' },
  { name: 'RIGHT', sig: 'RIGHT(str, len)' },
  { name: 'LPAD', sig: 'LPAD(str, len, pad)' },
  { name: 'RPAD', sig: 'RPAD(str, len, pad)' },
  { name: 'FIND_IN_SET', sig: 'FIND_IN_SET(str, list)' },
  { name: 'LOCATE', sig: 'LOCATE(sub, str[, pos])' },
  { name: 'SPLIT_PART', sig: 'SPLIT_PART(str, sep, idx)' },
  { name: 'ABS', sig: 'ABS(n)' },
  { name: 'ROUND', sig: 'ROUND(n[, d])' },
  { name: 'FLOOR', sig: 'FLOOR(n)' },
  { name: 'CEIL', sig: 'CEIL(n)' },
  { name: 'MOD', sig: 'MOD(a, b)' },
  { name: 'POWER', sig: 'POWER(a, b)' },
  { name: 'SQRT', sig: 'SQRT(n)' },
  { name: 'GREATEST', sig: 'GREATEST(a, b, ...)' },
  { name: 'LEAST', sig: 'LEAST(a, b, ...)' },
  { name: 'NOW', sig: 'NOW()' },
  { name: 'CURRENT_DATE', sig: 'CURRENT_DATE' },
  { name: 'CURRENT_TIMESTAMP', sig: 'CURRENT_TIMESTAMP' },
  { name: 'DATE_FORMAT', sig: 'DATE_FORMAT(date, fmt)' },
  { name: 'DATE_ADD', sig: 'DATE_ADD(date, INTERVAL n unit)' },
  { name: 'DATE_SUB', sig: 'DATE_SUB(date, INTERVAL n unit)' },
  { name: 'DATEDIFF', sig: 'DATEDIFF(a, b)' },
  { name: 'TIMESTAMPDIFF', sig: 'TIMESTAMPDIFF(unit, a, b)' },
  { name: 'UNIX_TIMESTAMP', sig: 'UNIX_TIMESTAMP([date])' },
  { name: 'FROM_UNIXTIME', sig: 'FROM_UNIXTIME(ts[, fmt])' },
  { name: 'EXTRACT', sig: 'EXTRACT(unit FROM date)' },
  { name: 'YEAR', sig: 'YEAR(date)' },
  { name: 'MONTH', sig: 'MONTH(date)' },
  { name: 'DAY', sig: 'DAY(date)' },
  { name: 'WEEKDAY', sig: 'WEEKDAY(date)' },
  { name: 'IF', sig: 'IF(cond, a, b)' },
  { name: 'IFNULL', sig: 'IFNULL(a, b)' },
  { name: 'COALESCE', sig: 'COALESCE(a, b, ...)' },
  { name: 'NULLIF', sig: 'NULLIF(a, b)' },
  { name: 'CAST', sig: 'CAST(expr AS type)' },
  { name: 'CONVERT', sig: 'CONVERT(expr, type)' },
  { name: 'JSON_EXTRACT', sig: 'JSON_EXTRACT(doc, path)' },
  { name: 'GET_JSON_OBJECT', sig: 'GET_JSON_OBJECT(json, path)' },
  { name: 'ROW_NUMBER', sig: 'ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)' },
  { name: 'RANK', sig: 'RANK() OVER (...)' },
  { name: 'DENSE_RANK', sig: 'DENSE_RANK() OVER (...)' },
  { name: 'LAG', sig: 'LAG(col, n, default) OVER (...)' },
  { name: 'LEAD', sig: 'LEAD(col, n, default) OVER (...)' },
  { name: 'FIRST_VALUE', sig: 'FIRST_VALUE(col) OVER (...)' },
  { name: 'LAST_VALUE', sig: 'LAST_VALUE(col) OVER (...)' }
]

// ── SQL 代码片段(输入缩写即出,插入带 tabStop 占位,Monaco 原生 snippet)──
const SNIPPETS: Array<{ label: string; detail: string; insertText: string }> = [
  { label: 'sel', detail: '查询模板', insertText: 'SELECT \${1:col1}, \${2:col2}\nFROM \${3:schema.table}\nWHERE \${4:cond};\n\${0}' },
  { label: 'cte', detail: 'CTE 模板', insertText: 'WITH \${1:tmp} AS (\n  SELECT * FROM \${2:table}\n)\nSELECT * FROM \${1:tmp};\n\${0}' },
  { label: 'ins', detail: '插入模板', insertText: 'INSERT INTO \${1:table} (\${2:col})\nVALUES (\${3:val});\n\${0}' },
  { label: 'upd', detail: '更新模板', insertText: 'UPDATE \${1:table}\nSET \${2:col} = \${3:val}\nWHERE \${4:cond};\n\${0}' },
  { label: 'del', detail: '删除模板', insertText: 'DELETE FROM \${1:table}\nWHERE \${2:cond};\n\${0}' },
  { label: 'crt', detail: '建表模板', insertText: 'CREATE TABLE \${1:db}.\${2:table} (\n  \${3:id} \${4:BIGINT} COMMENT \'主键\'\n)\nCOMMENT \'表注释\'\n\${0}' }
]

// ── 实例状态 ─────────────────────────────────────────────────
const containerRef = ref<HTMLElement>()
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let modelChangeDisposable: monaco.IDisposable | null = null
/** 程序性 setValue(silent)抑制 emit('change') —— 历史回填/表预览等程序写入不标记 dirty、不触发自动保存(等价旧 CM 的 change.origin==='setValue') */
let suppressChangeEmit = false
/** model 池:modelId → ITextModel(每个 tab 独立文档/撤销历史/光标),等价旧 CM swapDoc */
const models = new Map<string, monaco.editor.ITextModel>()
/** provider 注册句柄(卸载时释放;每次 mount 注册一组,防重复) */
const providers: monaco.IDisposable[] = []
/** schema 缓存:db → meta(按 db 记忆,与旧 schemaCache 等价) */
const schemaCache = new Map<string, SchemaMeta | null>()
/** 拉取中的 schema(去重:快速输入时 provider 多次触发,避免并发重复请求) */
const schemaInflight = new Map<string, Promise<SchemaMeta | null>>()
/** 文中词索引 —— 行级增量(见 docWords):
 *  byLineWords: modelId → 行号 → 该行词;wordCounts: modelId → 词 → 出现次数
 *  dirtyLines: 待重建行(打字只影响光标行,一次重建 1 行 = O(行内容));
 *  needsRebuild: 行数变化(Enter 拆行/粘贴/删除)导致行号偏移,标整表重建(低频一次,防行号错位计数漂移) */
const byLineWords = new Map<string, Map<number, Set<string>>>()
const wordCounts = new Map<string, Map<string, number>>()
const dirtyLines = new Map<string, Set<number>>()
const needsRebuild = new Map<string, boolean>()

definePortalThemes() // 幂等定义(模块内 flag 防重复)
monaco.editor.setTheme(props.themeMode === 'dark' ? 'portal-dark' : 'portal-light')

// ── 文中词表(行级增量,根治"每键全扫")────────────────────────
function extractWords(text: string): Set<string> {
  const s = new Set<string>()
  const re = WORD_RE
  let mm: RegExpExecArray | null
  re.lastIndex = 0
  while ((mm = re.exec(text))) s.add(mm[0])
  return s
}

function rebuildModelIndex(model: monaco.editor.ITextModel): void {
  const id = model.id
  const byLine = new Map<number, Set<string>>()
  const counts = new Map<string, number>()
  for (let l = 1; l <= model.getLineCount(); l++) {
    const ws = extractWords(model.getLineContent(l))
    byLine.set(l, ws)
    for (const w of ws) counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  byLineWords.set(id, byLine)
  wordCounts.set(id, counts)
  dirtyLines.set(id, new Set())
  needsRebuild.delete(id)
}

/** 内容变更后标记索引:单行内编辑 → 该行待重建;行数变化 → 整表重建
 *  (行号偏移会让 byLine 的 key 与内容脱节,后续增量删减会漂移,全量重建一次最稳)。 */
function markIndexDirty(model: monaco.editor.ITextModel, changes: monaco.editor.IModelContentChange[]): void {
  const id = model.id
  for (const ch of changes) {
    const sameLine = ch.range.startLineNumber === ch.range.endLineNumber && !ch.text.includes('\n')
    if (!sameLine) {
      needsRebuild.set(id, true)
      return
    }
    let d = dirtyLines.get(id)
    if (!d) {
      d = new Set()
      dirtyLines.set(id, d)
    }
    d.add(ch.range.startLineNumber)
  }
}

/** 取全部文中词(触发时机=补全请求):先重建脏行/整表,再返回词表。
 *  打字每键只重建光标行 1 行;Enter/粘贴/删除等低频率操作才整表重建。 */
function docWords(model: monaco.editor.ITextModel): Set<string> {
  const id = model.id
  if (needsRebuild.get(id)) rebuildModelIndex(model)
  if (!wordCounts.has(id)) rebuildModelIndex(model)
  const dirty = dirtyLines.get(id)
  if (dirty && dirty.size) {
    const byLine = byLineWords.get(id)!
    const counts = wordCounts.get(id)!
    for (const l of dirty) {
      const oldWs = byLine.get(l)
      if (oldWs) {
        for (const w of oldWs) {
          const c = (counts.get(w) ?? 0) - 1
          if (c <= 0) counts.delete(w)
          else counts.set(w, c)
        }
      }
      if (l > model.getLineCount()) {
        byLine.delete(l) // 行已被删(理论上走了整表重建,此处兜底)
        continue
      }
      const newWs = extractWords(model.getLineContent(l))
      byLine.set(l, newWs)
      for (const w of newWs) counts.set(w, (counts.get(w) ?? 0) + 1)
    }
    dirty.clear()
  }
  return new Set(wordCounts.get(id)!.keys())
}

// ── schema(带缓存 + in-flight 去重,失败静默)──────────────
async function loadSchema(dbName: string): Promise<SchemaMeta | null> {
  if (!dbName) return null
  if (schemaCache.has(dbName)) return schemaCache.get(dbName) ?? null
  const inflight = schemaInflight.get(dbName)
  if (inflight) return inflight
  const p = (async () => {
    try {
      const meta = (await props.schemaLoader?.(dbName)) ?? null
      schemaCache.set(dbName, meta)
      return meta
    } catch {
      schemaCache.set(dbName, null)
      return null
    } finally {
      schemaInflight.delete(dbName)
    }
  })()
  schemaInflight.set(dbName, p)
  return p
}

// ── 补全 provider(全局注册,按 model.uri.scheme 判归属)──────
function registerProvider(language: 'sql' | 'python'): void {
  const provider: monaco.languages.CompletionItemProvider = {
    triggerCharacters: ['.'],
    provideCompletionItems: async (model, position) => {
      if (model.uri.scheme !== 'portal-sql') return { suggestions: [] }
      const line = model.getLineContent(position.lineNumber)
      const before = line.slice(0, position.column - 1)
      const m = before.match(/([A-Za-z0-9_$]+(\.[A-Za-z0-9_$]*)?)$/)
      // 候选替换区间:从词起点到光标(结尾固定为光标列)
      const rngAt = (startColumn: number): monaco.IRange => ({
        startLineNumber: position.lineNumber,
        startColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      })
      const suggestions: monaco.languages.CompletionItem[] = []
      if (language === 'sql') {
        const meta = await loadSchema(props.currentDb)
        if (m) {
          const full = m[1]
          const dotIdx = full.lastIndexOf('.')
          if (dotIdx >= 0 && meta) {
            // 点语法:表名固定,提示该表列(等价旧 sqlSchemaHint 点语法分支)
            const tbl = full.slice(0, dotIdx)
            const colPrefix = full.slice(dotIdx + 1).toLowerCase()
            const t = meta.tables.find((x) => x.name.toLowerCase() === tbl.toLowerCase())
            if (t) {
              for (const c of t.columns) {
                if (!c.name.toLowerCase().startsWith(colPrefix)) continue
                suggestions.push({
                  label: c.name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: c.name,
                  detail: c.type ? `${tbl}.${c.name} · ${c.type}` : `${tbl}.${c.name}`,
                  range: rngAt(position.column - (full.length - dotIdx - 1))
                })
                if (suggestions.length >= MAX_SUGGEST) break
              }
              return { suggestions }
            }
          } else if (dotIdx < 0) {
            // 标识符:关键字 + 表名(点号前缀不匹配表时跳过,等价旧逻辑)
            const prefix = full.toLowerCase()
            const startCol = position.column - full.length
            for (const k of SQL_KEYWORDS) {
              if (!k.toLowerCase().startsWith(prefix)) continue
              suggestions.push({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, range: rngAt(startCol) })
            }
            if (meta) {
              for (const t of meta.tables) {
                if (!t.name.toLowerCase().startsWith(prefix)) continue
                suggestions.push({
                  label: t.name,
                  kind: monaco.languages.CompletionItemKind.Class,
                  insertText: t.name,
                  detail: t.comment || '表',
                  range: rngAt(startCol)
                })
                if (suggestions.length >= MAX_SUGGEST) return { suggestions }
              }
            }
            // 内置函数:插入带参数占位(snippet),光标落在括号内
            for (const f of SQL_FUNCTIONS) {
              if (suggestions.some((x) => x.label === f.name)) continue // 关键字已有(COUNT/SUM/...)不重复
              if (!f.name.toLowerCase().startsWith(prefix)) continue
              suggestions.push({
                label: f.name,
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: `${f.name}(\${1})`,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                detail: f.sig,
                range: rngAt(startCol)
              })
              if (suggestions.length >= MAX_SUGGEST) return { suggestions }
            }
            // SQL snippet:缩写字触发常用模板
            for (const s of SNIPPETS) {
              if (!s.label.toLowerCase().startsWith(prefix)) continue
              suggestions.push({
                label: s.label,
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: s.insertText,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                detail: s.detail,
                range: rngAt(startCol)
              })
              if (suggestions.length >= MAX_SUGGEST) return { suggestions }
            }
          }
        }
        // 文中词(仅光标前有标识符前缀时补充,等价旧"输入过即提示")
        const wordPrefix = (m ? (m[1].includes('.') ? m[1].split('.').pop()! : m[1]) : '').toLowerCase()
        if (wordPrefix) {
          for (const w of docWords(model)) {
            if (suggestions.some((s) => s.label === w)) continue
            if (!w.toLowerCase().startsWith(wordPrefix)) continue
            suggestions.push({ label: w, kind: monaco.languages.CompletionItemKind.Text, insertText: w, range: rngAt(position.column - wordPrefix.length) })
            if (suggestions.length >= MAX_SUGGEST) break
          }
        }
      } else {
        // python:文中词 + Python 常用关键字
        const pyKws = ['def', 'return', 'import', 'from', 'as', 'if', 'elif', 'else', 'for', 'while', 'range', 'print', 'len', 'df', 'spark', 'sc']
        const wordPrefix = (m ? m[1] : '').toLowerCase()
        const kwStart = position.column - wordPrefix.length
        for (const k of pyKws) {
          if (k.toLowerCase().startsWith(wordPrefix)) suggestions.push({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, range: rngAt(kwStart) })
        }
        if (wordPrefix) {
          for (const w of docWords(model)) {
            if (suggestions.some((s) => s.label === w)) continue
            if (!w.toLowerCase().startsWith(wordPrefix)) continue
            suggestions.push({ label: w, kind: monaco.languages.CompletionItemKind.Text, insertText: w, range: rngAt(kwStart) })
            if (suggestions.length >= MAX_SUGGEST) break
          }
        }
      }
      return { suggestions }
    }
  }
  providers.push(monaco.languages.registerCompletionItemProvider(language, provider))
}

// ── model 池管理 ────────────────────────────────────────────
/** 确保 modelId 的 model 存在。模型已存在则忽略 initial(内容以池内为准);
 *  不存在则用调用方快照创建 —— 不能依赖 props.value(父组件切 tab 与调用同 tick,prop 尚未 flush)。 */
function ensureModel(id: string, initial = props.value): monaco.editor.ITextModel {
  let model = models.get(id)
  if (!model) {
    model = monaco.editor.createModel(initial, props.language === 'python' ? 'python' : 'sql', editorUri(id))
    models.set(id, model)
  }
  return model
}

function attachModel(id: string): void {
  if (!editor) return
  const model = ensureModel(id)
  if (editor.getModel() !== model) editor.setModel(model)
  modelChangeDisposable?.dispose()
  modelChangeDisposable = model.onDidChangeContent((e) => {
    markIndexDirty(model, e.changes) // 索引增量失效(单行内编辑只标 1 行)
    scheduleCheck() // 超长行策略 + 行内校验(防抖)
    if (suppressChangeEmit) {
      suppressChangeEmit = false
      return // 程序性写入:参数行由调用方自行 sync,不标记 dirty/不触发自动保存
    }
    emit('change')
  })
  scheduleCheck() // 打开文档即校验一次(wordWrap 策略与 markers 落位)
}

// ── 行编辑 ──────────────────────────────────────────────────
/** 选中词全画布高亮:选中 2~64 字符的标识符时,整词匹配(大小写不敏感,与旧 CM 一致),
 *  最多装饰 500 处(旧 CM 无上限,长脚本+短词必卡死 —— 此为根治项)。
 *  仅高亮"其他位置的同词",选中区本身由 Monaco 原生 selection 高亮。 */
let selHighlightIds: string[] = []
function syncSelectionHighlight(): void {
  const e = editor
  const m = modelOf()
  if (!e || !m) return
  if (m.getLineCount() > 20000) return // 超大文档关闭实时高亮,防每键全扫卡顿
  const sel = e.getSelection()
  const word = sel && !sel.isEmpty() ? m.getValueInRange(sel).trim() : ''
  if (!/^[A-Za-z0-9_$]{2,64}$/.test(word)) {
    if (selHighlightIds.length) selHighlightIds = e.deltaDecorations(selHighlightIds, [])
    return
  }
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = m.findMatches(`\\b${esc}\\b`, true, false, false, null, true, 500)
  selHighlightIds = e.deltaDecorations(
    selHighlightIds,
    matches.map((x) => ({ range: x.range, options: { className: 'portal-selection-match' } }))
  )
}

// ── SQL 专属折叠 + 行内校验(共用一次词法扫描)───────────────
// 折叠:跨行括号(CTE/子查询/INSERT SELECT)/ /* */ 注释块/ -- # 行注释
// 校验:未闭合引号/括号 → 波浪线 markers(hover 提示)
const MAX_LINE_LEN = 500 // 超过即视为超长行(触发 wordWrap 降级防卡)
const CHECK_DEBOUNCE = 300
let checkTimer: number | null = null
let wordWrapOff = false // 超长行降级状态(避免反复 updateOptions 抖动)

interface SqlScan {
  folds: monaco.languages.FoldingRange[]
  markers: monaco.editor.IMarkerData[]
}

// 单次词法扫描:状态机跳过 -- / # 行注释、块注释、单双引号字符串;统计括号栈与引号闭合
function scanSql(model: monaco.editor.ITextModel): SqlScan {
  const folds: monaco.languages.FoldingRange[] = []
  const markers: monaco.editor.IMarkerData[] = []
  const stack: Array<{ line: number; col: number }> = []
  let quote: "'" | '"' | null = null
  let quoteStart = { line: 0, col: 0 }
  let inComment = false
  let commentStartLine = 0
  const n = model.getLineCount()
  for (let l = 1; l <= n; l++) {
    const line = model.getLineContent(l)
    let i = 0
    while (i < line.length) {
      const ch = line[i]
      const next = line[i + 1]
      if (inComment) {
        if (ch === '*' && next === '/') {
          inComment = false
          if (l > commentStartLine) folds.push({ start: commentStartLine, end: l, kind: monaco.languages.FoldingRangeKind.Comment })
          i++
        }
        i++
        continue
      }
      if (quote) {
        if (ch === quote) {
          if (ch === "'" && next === "'") {
            // SQL 转义:'' 表示字面单引号
            i += 2
            continue
          }
          if (ch === "'" && i > 0 && line[i - 1] === '\\') {
            i++
            continue
          }
          quote = null
        }
        i++
        continue
      }
      if (ch === '-' && next === '-') break // -- 行注释
      if (ch === '#') break // MySQL 行注释
      if (ch === '/' && next === '*') {
        inComment = true
        commentStartLine = l
        i += 2
        continue
      }
      if (ch === "'" || ch === '"') {
        quote = ch
        quoteStart = { line: l, col: i + 1 }
        i++
        continue
      }
      if (ch === '(') {
        stack.push({ line: l, col: i + 1 })
        i++
        continue
      }
      if (ch === ')') {
        const open = stack.pop()
        if (!open) {
          markers.push({
            severity: monaco.MarkerSeverity.Error,
            message: '多余的右括号 )',
            startLineNumber: l,
            startColumn: i + 1,
            endLineNumber: l,
            endColumn: i + 2
          })
        } else if (open.line < l) {
          folds.push({ start: open.line, end: l, kind: monaco.languages.FoldingRangeKind.Region })
        }
        i++
        continue
      }
      i++
    }
  }
  if (quote) {
    markers.push({
      severity: monaco.MarkerSeverity.Error,
      message: '未闭合的引号(字符串未终止)',
      startLineNumber: quoteStart.line,
      startColumn: quoteStart.col,
      endLineNumber: quoteStart.line,
      endColumn: quoteStart.col + 1
    })
  }
  if (stack.length) {
    const o = stack[0]
    markers.push({
      severity: monaco.MarkerSeverity.Error,
      message: `未闭合的括号(共 ${stack.length} 个)`,
      startLineNumber: o.line,
      startColumn: o.col,
      endLineNumber: o.line,
      endColumn: o.col + 1
    })
  }
  return { folds, markers }
}

/** 是否存在超长行(>500 字符;>10 万行跳过检测,保持当前策略) */
function hasLongLine(model: monaco.editor.ITextModel): boolean {
  const n = model.getLineCount()
  if (n > 100000) return wordWrapOff
  for (let l = 1; l <= n; l++) {
    if (model.getLineLength(l) > MAX_LINE_LEN) return true
  }
  return false
}

/** 超长行降级:检测到超长行 → wordWrap off(避免折行计算卡),恢复后回 on */
function applyLongLinePolicy(off: boolean): void {
  if (wordWrapOff === off) return
  wordWrapOff = off
  editor?.updateOptions({ wordWrap: off ? 'off' : 'on' })
}

/** 内容变更 → 防抖(300ms)执行:超长行策略 + 行内校验 markers(仅 sql;python 只做超长行) */
function scheduleCheck(): void {
  if (checkTimer) window.clearTimeout(checkTimer)
  checkTimer = window.setTimeout(() => {
    checkTimer = null
    const m = modelOf()
    if (!m) return
    applyLongLinePolicy(hasLongLine(m))
    if (m.getLanguageId() === 'sql') {
      monaco.editor.setModelMarkers(m, 'portal-sql-check', scanSql(m).markers)
    }
  }, CHECK_DEBOUNCE)
}

function dedentLines(editor: monaco.editor.IStandaloneCodeEditor): void {
  const sel = editor.getSelection()
  if (!sel) return
  const model = editor.getModel()
  if (!model) return
  const ops: monaco.editor.IIdentifiedSingleEditOperation[] = []
  for (let l = sel.startLineNumber; l <= sel.endLineNumber; l++) {
    const line = model.getLineContent(l)
    const lead = line.match(/^ {0,2}/)?.[0].length ?? 0
    if (lead > 0) ops.push({ range: new monaco.Range(l, 1, l, line.length + 1), text: line.slice(lead) })
  }
  editor.executeEdits('dedent', ops)
  // 文本变化后恢复原选区(Monaco 自动 clamp 越界列),与旧 CM 缩进不改选区一致
  editor.setSelection(sel)
}

/** 注释/取消注释选中区每行(行首加/去 "-- ")。选区末尾停在行首时不算该行(等价旧 CM) */
function commentSelection(editor: monaco.editor.IStandaloneCodeEditor): void {
  const sel = editor.getSelection()
  if (!sel) return
  const model = editor.getModel()
  if (!model) return
  let endLine = sel.endLineNumber
  if (sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber) endLine--
  const lines: number[] = []
  for (let l = sel.startLineNumber; l <= endLine; l++) lines.push(l)
  const allCommented = lines.every((l) => /^\s*-- /.test(model.getLineContent(l)))
  const ops: monaco.editor.IIdentifiedSingleEditOperation[] = []
  for (const l of lines) {
    const text = model.getLineContent(l)
    if (allCommented) {
      ops.push({ range: new monaco.Range(l, 1, l, text.length + 1), text: text.replace(/^(\s*)-- /, '$1') })
    } else {
      const indent = text.match(/^\s*/)?.[0] ?? ''
      ops.push({ range: new monaco.Range(l, 1, l, text.length + 1), text: `${indent}-- ${text.slice(indent.length)}` })
    }
  }
  editor.executeEdits('comment', ops)
  editor.setSelection(new monaco.Selection(sel.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine)))
}

// ── 初始化 ──────────────────────────────────────────────────
onMounted(() => {
  if (!containerRef.value) return
  editor = monaco.editor.create(containerRef.value, {
    model: ensureModel(props.modelId),
    theme: props.themeMode === 'dark' ? 'portal-dark' : 'portal-light',
    fontSize: props.fontSize,
    lineNumbers: 'on',
    minimap: { enabled: true },
    automaticLayout: true,
    scrollBeyondLastLine: false,
    wordWrap: 'on', // 等价旧 CM lineWrapping: true(长行自动换行,不横向滚动)
    fixedOverflowWidgets: true,
    folding: true,
    renderLineHighlight: 'all',
    cursorBlinking: 'smooth',
    smoothScrolling: true,
    matchBrackets: 'always',
    autoClosingBrackets: 'always',
    autoClosingQuotes: 'always',
    bracketPairColorization: { enabled: true },
    suggest: { showWords: false }, // 禁用默认词补全,使用自实现 provider;候选虚拟滚动,无需截断配置
    quickSuggestions: { other: true, comments: false, strings: false },
    tabSize: 2,
    insertSpaces: true,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
  })
  attachModel(props.modelId)

  registerProvider('sql')
  registerProvider('python')

  // SQL 专属折叠:括号(CTE/子查询)/ 注释块(与行内校验共用 scanSql 词法)
  providers.push(
    monaco.languages.registerFoldingRangeProvider('sql', {
      provideFoldingRanges: (model) => (model.uri.scheme === 'portal-sql' ? scanSql(model).folds : [])
    })
  )

  // ── 选中词全画布高亮(等价旧 CM match-highlighter;整词匹配,上限 500 处防卡)──
  editor.onDidChangeCursorSelection(syncSelectionHighlight)

  // 快捷键
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => emit('exec'))
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit('save'))
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => emit('format'))
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash, () => commentSelection(editor!))

  // Shift+Tab:补全浮层可见时放行(反向选词),否则多行反缩进。Tab 完全交给 Monaco 原生
  // (浮层选词 / 多行缩进 / 插入空格),不拦截。
  editor.onKeyDown((e) => {
    if (e.keyCode !== monaco.KeyCode.Tab || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
    const ctrl = (editor as unknown as {
      _contributions?: Record<string, { widget?: { isVisible?: () => boolean } }>
    })._contributions?.['editor.contrib.suggestController']?.widget
    if (ctrl?.isVisible?.()) return // suggest 聚焦时放行,Monaco 处理反向选词
    e.preventDefault()
    e.stopPropagation()
    dedentLines(editor!)
  })

  emit('ready')
})

onBeforeUnmount(() => {
  modelChangeDisposable?.dispose()
  modelChangeDisposable = null
  if (checkTimer) window.clearTimeout(checkTimer)
  checkTimer = null
  for (const p of providers.splice(0)) p.dispose()
  editor?.dispose()
  editor = null
  for (const m of models.values()) m.dispose()
  models.clear()
  byLineWords.clear()
  wordCounts.clear()
  dirtyLines.clear()
  needsRebuild.clear()
  schemaCache.clear()
  schemaInflight.clear()
})

// ── 响应 props ──────────────────────────────────────────────
watch(
  () => props.modelId,
  (id) => {
    if (editor) attachModel(id)
  }
)
watch(
  () => props.language,
  (lang) => {
    const model = editor?.getModel()
    if (model) monaco.editor.setModelLanguage(model, lang === 'python' ? 'python' : 'sql')
  }
)
watch(
  () => props.themeMode,
  (mode) => monaco.editor.setTheme(mode === 'dark' ? 'portal-dark' : 'portal-light')
)
watch(
  () => props.fontSize,
  (size) => editor?.updateOptions({ fontSize: size })
)
// ── schema 预取:db 就绪/切换时后台拉一次进缓存(补全首字即出候选,无首次等待)──
watch(
  () => props.currentDb,
  (db) => {
    if (db) void loadSchema(db)
  },
  { immediate: true }
)

// ── 对外 API(与旧 CodeMirror 兼容面)────────────────────────
const ed = (): monaco.editor.IStandaloneCodeEditor | null => editor
const modelOf = (): monaco.editor.ITextModel | null => editor?.getModel() ?? null

defineExpose({
  getValue: (): string => modelOf()?.getValue() ?? props.value,
  /** 程序性替换全文内容;silent 时不触发 change 事件(不标记 dirty/不自动保存),需调用方自行同步参数行 */
  setValue: (v: string, opts?: { silent?: boolean }): void => {
    const m = modelOf()
    if (!m) return
    if (opts?.silent) {
      suppressChangeEmit = true
      m.setValue(v) // Monaco setValue 同步派发 onDidChangeContent(回调里复位标志)
      return
    }
    m.setValue(v)
  },
  getSelection: (): string => {
    const e = ed()
    const m = modelOf()
    const sel = e?.getSelection()
    return m && sel ? m.getValueInRange(sel) : ''
  },
  getCursor: (): { line: number; ch: number } => {
    const e = ed()
    const p = e?.getPosition()
    if (!p) return { line: 1, ch: 1 }
    return { line: p.lineNumber, ch: p.column - 1 } // ch 0 基,与 CM 对齐
  },
  setCursor: (pos: { line: number; ch: number }): void => {
    const e = ed()
    if (e) e.setPosition({ lineNumber: pos.line, column: pos.ch + 1 })
  },
  indexFromPos: (pos: { line: number; ch: number }): number => {
    const m = modelOf()
    return m ? m.getOffsetAt({ lineNumber: pos.line, column: pos.ch + 1 }) : 0
  },
  replaceRange: (text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }): void => {
    const e = ed()
    const m = modelOf()
    if (!e || !m) return
    const start = { lineNumber: from.line, column: from.ch + 1 }
    const end = to ? { lineNumber: to.line, column: to.ch + 1 } : start
    e.executeEdits('replace', [{ range: monaco.Range.fromPositions(start, end), text }])
  },
  replaceSelection: (text: string): void => {
    const e = ed()
    const sel = e?.getSelection()
    if (e && sel) e.executeEdits('replace', [{ range: sel, text }])
  },
  getLine: (l: number): string => modelOf()?.getLineContent(l) ?? '',
  lineCount: (): number => modelOf()?.getLineCount() ?? 1,
  focus: (): void => ed()?.focus(),
  setSelection: (from: { line: number; ch: number }, to: { line: number; ch: number }): void => {
    const e = ed()
    if (e) e.setSelection(new monaco.Selection(from.line, from.ch + 1, to.line, to.ch + 1))
  },
  /** 确保某 tab 的 model 已存在于池中(等价旧 CM 兼容路径 lazy 建 Doc) */
  ensureModel,
  /** 池中是否已有该 modelId */
  hasModel: (id: string): boolean => models.has(id)
})
</script>

<template>
  <div ref="containerRef" class="sql-editor-monaco" />
</template>

<style scoped>
.sql-editor-monaco {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>

<!-- 选中词高亮装饰(className 渲染在 Monaco 编辑层 DOM 内,需全局选择器;配色沿用旧 CM .cm-matchhighlight) -->
<style>
.portal-selection-match {
  background: rgba(229, 192, 123, 0.28);
  border-radius: 2px;
}
</style>