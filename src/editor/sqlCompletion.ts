/**
 * Monaco SQL Schema 感知补全(自 composables/useSqlCompletion.ts 的 CM5 实现等价移植):
 *  - schema 元数据按 db 缓存(getSchema 拉取,失败静默)
 *  - 表名补全 → 点号后列补全(带类型注释)→ SQL 关键字 → 文中词
 * 纯注册函数,setup.ts 启动时调用一次;当前 db 通过模块级变量注入(QueryView watch 同步)。
 */
import type * as monaco from 'monaco-editor'
import { getSchema } from '@/api/db'

interface ColumnMeta {
  name: string
  type?: string
  comment?: string
}

interface SchemaMeta {
  tables: Array<{ name: string; comment?: string; columns: ColumnMeta[] }>
}

/** 常用 SQL 关键字(补全候选,与原 CM5 版一致) */
export const SQL_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'INSERT', 'UPDATE', 'DELETE', 'SET', 'VALUES', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'IS', 'BETWEEN', 'LIKE']

const schemaCache = new Map<string, SchemaMeta>()

/** 当前补全上下文的库名(setup 注册的是全局 provider,由 QueryView 注入) */
let currentDb = ''

/** 注入/更新当前库(schema 缓存 key);QueryView 在 db 切换时调用 */
export function setCompletionDb(dbName: string): void {
  currentDb = dbName || ''
}

/** 取 db 的 schema 元数据(缓存命中直接返回,未命中调 getSchema,失败静默) */
export async function ensureSchema(dbName: string): Promise<SchemaMeta | null> {
  const hit = schemaCache.get(dbName)
  if (hit) return hit
  try {
    const data = await getSchema(dbName)
    const meta: SchemaMeta = { tables: data.tables || [] }
    schemaCache.set(dbName, meta)
    return meta
  } catch {
    return null
  }
}

const TRIGGER_RE = /^[A-Za-z_$][A-Za-z0-9_$.]*$/

/**
 * 注册 SQL 补全 provider(全局一次性):
 * 触发条件与原实现对齐——标识符或点语法前缀才弹窗,避免噪声。
 */
export function registerSqlCompletion(monaco: typeof import('monaco-editor')): void {
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', '_']
    ,
    async provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      const lineText = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
      // 光标前完整标识符(含点语法 `表.列`)
      const m = lineText.match(/([A-Za-z0-9_$]+(\.[A-Za-z0-9_$]*)?)$/)
      if (!m && !word.word) return { suggestions: [] }

      const full = m ? m[1] : word.word
      if (!TRIGGER_RE.test(full + (lineText.endsWith('.') ? '.' : ''))) return { suggestions: [] }
      // 点号紧邻(表.)时 word 可能为空,直接走列补全
      const dotIdx = full.lastIndexOf('.')
      // 统一替换区间:点后段(从标识符起点到光标)
      const replaceRange: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - (dotIdx >= 0 ? full.length - dotIdx - 1 : full.length),
        endColumn: position.column
      }

      const meta = currentDb ? await ensureSchema(currentDb) : null
      const suggestions: monaco.languages.CompletionItem[] = []
      const K = monaco.languages.CompletionItemKind
      const prefixFull = lineText.endsWith('.') ? '' : full.slice(dotIdx >= 0 ? dotIdx + 1 : 0).toLowerCase()

      if (dotIdx >= 0 && meta) {
        // ── 点语法:列补全(带类型注释)──
        const tbl = full.slice(0, dotIdx)
        const t = meta.tables.find((x) => x.name.toLowerCase() === tbl.toLowerCase())
        if (t) {
          for (const c of t.columns) {
            if (!c.name.toLowerCase().startsWith(prefixFull)) continue
            suggestions.push({
              label: c.name,
              kind: K.Field,
              detail: c.type || '',
              documentation: c.comment || undefined,
              insertText: c.name,
              range: replaceRange
            })
          }
          // 无匹配列时不再退化为关键字(与原实现 return null 对齐)
          return { suggestions }
        }
      }

      if (!dotIdx) {
        // ── 表名补全 ──
        for (const t of meta?.tables || []) {
        if (!t.name.toLowerCase().startsWith(prefixFull)) continue
          suggestions.push({
            label: t.name,
            kind: K.Class,
            detail: 'table',
            documentation: t.comment || undefined,
            insertText: t.name,
            range: replaceRange
          })
        }
      }

      // ── SQL 关键字 ──
      for (const kw of SQL_KEYWORDS) {
        if (!kw.toLowerCase().startsWith(prefixFull)) continue
        suggestions.push({ label: kw, kind: K.Keyword, insertText: kw.replace(/ $/, ''), range: replaceRange })
      }

      // ── 文中词(≥3 长度标识符,排除前缀自身)──
      const seen = new Set<string>()
      const wRe = /[A-Za-z_][A-Za-z0-9_$]{2,}/g
      const text = model.getValue()
      let mm: RegExpExecArray | null
      while ((mm = wRe.exec(text))) {
        const w = mm[0]
        const lw = w.toLowerCase()
        if (lw === prefixFull.toLowerCase() || !lw.startsWith(prefixFull.toLowerCase()) || seen.has(lw)) continue
        seen.add(lw)
        suggestions.push({ label: w, kind: K.Text, insertText: w, range: replaceRange })
        if (suggestions.length > 200) break // 上限保护
      }

      return { suggestions }
    }
  })
}
