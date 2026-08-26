/**
 * SQL Schema 感知补全(自 QueryView.vue 迁出,2026-08):
 *  - schema 元数据按 db 缓存(getSchema 拉取,失败静默)
 *  - sqlSchemaHint:表/列点语法补全 + SQL 关键字 + 编辑器文中词
 * 纯逻辑;当前 db 由调用方注入(Ref<string>)。
 */
import type CodeMirror from 'codemirror'
import { getSchema } from '@/api/db'

interface SchemaMeta {
  tables: Array<{ name: string; comment?: string; columns: Array<{ name: string; type?: string }> }>
}

/** 常用 SQL 关键字(补全候选) */
export const SQL_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'INSERT', 'UPDATE', 'DELETE', 'SET', 'VALUES', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'IS', 'BETWEEN', 'LIKE']

const schemaCache = new Map<string, SchemaMeta>()

/** 取 db 的 schema 元数据(缓存命中直接返回,未命中调 getSchema) */
export async function ensureSchema(dbName: string): Promise<SchemaMeta | null> {
  const hit = schemaCache.get(dbName)
  if (hit) return hit
  try {
    const data = await getSchema(dbName)
    const meta: SchemaMeta = { tables: data.tables || [] }
    schemaCache.set(dbName, meta)
    return meta
  } catch {
    return null // 拉取失败静默,仅无补全
  }
}

/** 收集编辑器中已出现的标识符(文中词提示):去重、排除光标前正在输入的前缀本身 */
function collectDocWords(cm: CodeMirror.Editor, prefix: string): string[] {
  const words = new Set<string>()
  const re = /[A-Za-z_][A-Za-z0-9_$]{2,}/g // 长度≥3 的标识符(过滤单双字母噪声)
  for (let l = 0; l < cm.lineCount(); l++) {
    const line = cm.getLine(l)
    let mm: RegExpExecArray | null
    re.lastIndex = 0
    while ((mm = re.exec(line))) {
      const w = mm[0]
      if (w.toLowerCase() !== prefix.toLowerCase()) words.add(w)
    }
  }
  return Array.from(words)
}

/**
 * 自定义 SQL 补全实现:schema 表/列 + 关键字 + 编辑器文中词(如输入过 dwd_lion_cs,输 dwd 即提示);
 * schema 未就绪时退化为关键字+文中词,不阻塞等待。
 * currentDb:当前选中库(schema 缓存 key)。
 */
export async function sqlSchemaHint(
  cm: CodeMirror.Editor,
  currentDb: string
): Promise<CodeMirror.Hints | null> {
  const cur = cm.getCursor()
  const before = cm.getLine(cur.line).slice(0, cur.ch)
  // 光标前标识符:支持 `表名.列名`(点号前后各一段)
  const m = before.match(/([A-Za-z0-9_$]+(\.[A-Za-z0-9_$]*)?)$/)
  // schema 未就绪时不再 return null:仍提供关键字/文中词提示
  const meta = currentDb ? await ensureSchema(currentDb) : null
  if (!m) {
    if (!meta) return null
    return { list: [], from: cur, to: cur }
  }
  const full = m[1]
  const dotIdx = full.lastIndexOf('.')
  let list: string[] = []
  let fromCh: number
  if (dotIdx >= 0 && meta) {
    // 点语法列补全必须有 schema;无 schema 时退化为关键字/文中词
    const tbl = full.slice(0, dotIdx)
    const colPrefix = full.slice(dotIdx + 1).toLowerCase()
    const t = meta.tables.find((x) => x.name.toLowerCase() === tbl.toLowerCase())
    if (t) {
      list = t.columns.filter((c) => c.name.toLowerCase().startsWith(colPrefix)).map((c) => c.name)
      fromCh = cur.ch - (full.length - dotIdx - 1)
      if (!list.length) return null
      return { list: Array.from(new Set(list)), from: { line: cur.line, ch: fromCh }, to: cur }
    }
  } else {
    const prefix = full.toLowerCase()
    list.push(...SQL_KEYWORDS.filter((k) => k.toLowerCase().startsWith(prefix)))
  }
  // 文中词提示(表名列名之外):当前画布出现过的标识符(输入过 dwd_lion_cs 后,输 dwd 即可提示);点语法时用列前缀过滤
  const wordPrefix = (dotIdx >= 0 ? full.slice(dotIdx + 1) : full).toLowerCase()
  list.push(...collectDocWords(cm, wordPrefix).filter((w) => w.toLowerCase().startsWith(wordPrefix)))
  if (!list.length) return null
  return { list: Array.from(new Set(list)), from: { line: cur.line, ch: cur.ch - wordPrefix.length }, to: cur }
}
