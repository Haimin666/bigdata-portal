// SQL 写检测三件套(从 index.js 拆出,全引擎共用):
// - isSparkWriteSql:服务端权威写/读判定(白名单读 + 显式拒绝 + 走私防护)
// - splitSqlStatements:引号感知的分号切分(多语句走私防护)
// - extractTables:简易 SQL 表名提取(表级权限校验用)
// 被 routes/spark.js、routes/flink.js、routes/dbquery.js、routes/db.js 共用。

const SPARK_READONLY_KW = /^(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|SET|USE)\b/i
const SPARK_WRITE_KW = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|MSCK|REFRESH|LOAD|OVERWRITE)\b/i
// SELECT 前缀走私:MySQL 可用 SELECT ... INTO OUTFILE/DUMPFILE 写服务器文件、
// LOAD_FILE() 读服务器文件、FOR UPDATE 行锁、GET_LOCK/SLEEP/BENCHMARK 资源消耗,
// 均视为写/敏感操作,需解锁
const SPARK_SELECT_SMUGGLE =
  /\bINTO\s+(OUTFILE|DUMPFILE)\b|\bLOAD_FILE\s*\(|\bFOR\s+UPDATE\b|\bINTO\s+@[A-Za-z0-9_]+|\bGET_LOCK\s*\(|\bSLEEP\s*\(|\bBENCHMARK\s*\(/i

/**
 * 引号/注释感知的 SQL 掩码(与原文保持 1:1 字符位置,便于复用索引做表名提取):
 * - `--` 行注释、`/* *\/` 块注释(含 MySQL `/*! *\/` 可执行注释)替换为空格,保留换行;
 * - 单引号字符串内容替换为空格(支持 '' 与 \' 转义),保留引号本身;
 * - 双引号默认按字符串字面量掩掉内容(MySQL/Spark 均为字符串);maskDoubleQuoted=false
 *   时仅跳过,用于表名提取(SQL 标准下双引号是标识符);
 * - 反引号标识符整段跳过、内容保留:内部 `--`/`*` 不会被误当注释,表名也不会被抹掉。
 * 关键点:注释识别在引号内失效,字符串里的 `'--'` 不会造成「其后内容全部被删」,
 * 从而堵住 `SELECT '--' INTO OUTFILE ...` 一类写检测绕过。
 */
export function maskSql(sql, { maskDoubleQuoted = true } = {}) {
  const s = String(sql ?? '')
  const out = s.split('')
  const n = s.length
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
    }
  }
  let i = 0
  while (i < n) {
    const c = s[i]
    // 行注释:-- 到行尾(引号内不会进到这里)
    if (c === '-' && s[i + 1] === '-') {
      let j = i
      while (j < n && s[j] !== '\n') j += 1
      blank(i, j)
      i = j
      continue
    }
    // 块注释:/* ... */(含未闭合 → 掩到末尾)
    if (c === '/' && s[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(s[j] === '*' && s[j + 1] === '/')) j += 1
      const end = Math.min(n, j + 2)
      blank(i, end)
      i = end
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      let j = i + 1
      while (j < n) {
        const ch = s[j]
        if (ch === '\\' && quote !== '`') {
          j += 2
          continue
        }
        if (ch === quote) {
          // '' / "" / `` 转义:两个连续引号视为字面量
          if (s[j + 1] === quote) {
            j += 2
            continue
          }
          break
        }
        j += 1
      }
      const contentEnd = Math.min(j, n)
      const opaque = quote === '`' || (quote === '"' && !maskDoubleQuoted)
      if (!opaque) blank(i + 1, contentEnd)
      i = j < n ? j + 1 : n
      continue
    }
    i += 1
  }
  return out.join('')
}

/** 按分号切分,跳过单引号/双引号字符串内的分号(与 flink split_flink_sql 同思路) */
export function splitSqlStatements(s) {
  const parts = []
  let cur = ''
  let inStr = false
  let inDQ = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[i + 1]
      i++
      continue
    }
    if (c === "'" && !inDQ) {
      inStr = !inStr
      cur += c
      continue
    }
    if (c === '"' && !inStr) {
      inDQ = !inDQ
      cur += c
      continue
    }
    if (c === ';' && !inStr && !inDQ) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  parts.push(cur)
  return parts
}

/**
 * 判定 SQL 是否可能为写操作(服务端权威校验,采用「白名单读 + 显式拒绝」策略):
 * 1) 去掉注释/字符串内容后,若以只读关键字开头(SELECT/SHOW/DESC/DESCRIBE/EXPLAIN/SET/USE/WITH 且无写关键字),
 *    放行;否则一律视为写操作。
 * 2) 显式拒绝多语句走私(含分号)与 CTE 前缀的 DML(WITH cte AS (...) INSERT ...)。
 */
export function isSparkWriteSql(sql) {
  const raw = String(sql)
  // MySQL/MariaDB 可执行注释 /*! ... */ 与 /*M! ... */ 会被数据库执行,绝不能当普通注释删除 —— 检测到一律视为写
  if (/\/\*[Mm]?!/.test(raw)) return true
  let s = maskSql(raw).trim()
  if (!s) return false
  // 多语句走私:引号感知切分,非末尾分号都拒绝
  const parts = splitSqlStatements(s)
  const last = parts[parts.length - 1].trim()
  if (parts.length > 2 || (parts.length === 2 && last !== '')) return true
  s = last || parts[0].trim()
  if (!s) return false
  // SELECT 前缀走私(INTO OUTFILE/DUMPFILE、LOAD_FILE)视为写
  if (SPARK_SELECT_SMUGGLE.test(s)) return true
  // 只读关键字开头 → 放行(但要排除 WITH ... INSERT 的 CTE-DML)
  if (SPARK_READONLY_KW.test(s)) {
    // SET GLOBAL / SET @@global.* 会修改服务器全局配置,视为写(需解锁);SET SESSION/普通 SET 会话级放行
    if (/^SET\b/i.test(s) && (/\bGLOBAL\b/i.test(s) || /@@global\./i.test(s))) return true
    return false
  }
  if (/^WITH\b/i.test(s) && !SPARK_WRITE_KW.test(s)) return false
  // 其余(含 CTE 前缀 DML、CACHE/ANALYZE 等)一律视为写
  return true
}

/** 多语句脚本(Flink/Spark 可含多条):任一条为写即视为写脚本。 */
export function isAnySqlWrite(sql) {
  const statements = splitSqlStatements(maskSql(sql))
    .map((part) => part.trim())
    .filter(Boolean)
  if (!statements.length) return false
  return statements.some((statement) => isSparkWriteSql(statement))
}

/** CSV export accepts exactly one read-only SELECT/WITH statement. */
export function isSparkExportSql(sql) {
  const s = maskSql(sql).trim()
  const statements = splitSqlStatements(s).map((part) => part.trim()).filter(Boolean)
  return statements.length === 1 && /^(SELECT|WITH)\b/i.test(statements[0]) && !isSparkWriteSql(statements[0])
}

// 表名提取:关键字后允许出现的修饰词(INSERT INTO TABLE / CREATE TABLE IF NOT EXISTS 等)
const TABLE_MODIFIERS = new Set(['if', 'not', 'exists', 'table', 'only', 'overwrite', 'lateral', 'temporary', 'temp'])
// 非表名关键字(用于过滤误匹配,不会触发 fail-closed)
const NON_TABLE_WORDS = new Set([
  'select', 'where', 'set', 'values', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join',
  'on', 'and', 'or', 'as', 'limit', 'group', 'order', 'having', 'dual', 'using', 'when', 'then',
  'else', 'end', 'outfile', 'dumpfile', 'into', 'from', 'update', 'delete', 'insert', 'table',
  'window', 'qualify', 'partition', 'tablesample', 'distribute', 'sort', 'cluster', 'lateral'
])
const IDENTIFIER_PART = '(?:`[^`]*`|"[^"]*"|[A-Za-z_][A-Za-z0-9_$#-]*|[0-9][A-Za-z0-9_$#-]*)'
const IDENTIFIER_RE = new RegExp(`^${IDENTIFIER_PART}(?:\\s*\\.\\s*${IDENTIFIER_PART})*`)
const TABLE_KEYWORD_RE = /\b(from|join|update|into|table)\b/gi
const CTE_NAME_RE = /(?:\bwith|,)\s*(`[^`]*`|"[^"]*"|[A-Za-z_][A-Za-z0-9_$#-]*)\s+as\s*\(/gi
// 表引用之后出现这些词时,说明别名/表清单已结束(不要误当别名吞掉)
const ALIAS_STOP_WORDS = new Set([
  'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'intersect', 'except',
  'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'on', 'using', 'set',
  'values', 'select', 'when', 'then', 'partition', 'tablesample', 'lateral', 'window',
  'qualify', 'distribute', 'sort', 'cluster', 'pivot', 'unpivot', 'and', 'or', 'returning'
])

function skipSpace(s, i) {
  while (i < s.length && /\s/.test(s[i])) i += 1
  return i
}

function matchParen(s, start) {
  let depth = 0
  for (let i = start; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1
    else if (s[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 跳过表引用后的别名(AS x / 裸 x)与列别名列表(x(a,b)),以便继续识别 `FROM a AS x, b`。
 * 返回新的扫描位置。
 */
function skipAliasAndColumnList(s, i) {
  let pos = i
  const asMatch = /^\s+AS\s+(`[^`]*`|"[^"]*"|[A-Za-z_][A-Za-z0-9_$#-]*)/i.exec(s.slice(pos))
  if (asMatch) {
    pos += asMatch[0].length
  } else {
    const bareMatch = /^\s+(`[^`]*`|"[^"]*"|[A-Za-z_][A-Za-z0-9_$#-]*)/.exec(s.slice(pos))
    if (bareMatch) {
      const word = bareMatch[1].replace(/^[`"]|[`"]$/g, '').toLowerCase()
      if (!ALIAS_STOP_WORDS.has(word)) pos += bareMatch[0].length
    }
  }
  // 列别名列表 x(a, b):跳过成对括号
  const open = /^\s*\(/.exec(s.slice(pos))
  if (open) {
    const close = matchParen(s, pos + open[0].length - 1)
    if (close > 0) pos = close + 1
  }
  return pos
}

function unquoteIdentifier(raw) {
  const parts = String(raw).split('.').map((part) => part.trim())
  let name = parts[parts.length - 1] || ''
  if (
    (name.startsWith('`') && name.endsWith('`')) ||
    (name.startsWith('"') && name.endsWith('"'))
  ) {
    name = name.slice(1, -1)
  }
  return name.replace(/``/g, '`').replace(/""/g, '"')
}

function collectCteNames(masked) {
  const names = new Set()
  CTE_NAME_RE.lastIndex = 0
  let m
  while ((m = CTE_NAME_RE.exec(masked))) names.add(unquoteIdentifier(m[1]).toLowerCase())
  return names
}

/**
 * 解析单个关键字后紧跟的表引用(含逗号分隔的多表、括号子查询)。
 * 返回扫描结束位置;无法可靠识别时返回 null(由调用方 fail-closed)。
 */
function scanTableRefs(s, start, keyword, tables) {
  let i = start
  // 同一条 FROM 中可能有多张表:a, b, (SELECT ...) c
  for (;;) {
    i = skipSpace(s, i)
    if (i >= s.length) return null // 关键字后缺内容:拒绝猜测
    const ch = s[i]
    if (ch === '(') {
      const close = matchParen(s, i)
      if (close < 0) return null
      const inner = s.slice(i + 1, close)
      // 只有明确的子查询/VALUES 才允许;其余(如 FROM (--c\n forbidden))无法可靠识别 → fail-closed
      if (!/^\s*(SELECT|WITH|VALUES|TABLE)\b/i.test(inner)) return null
      const sub = extractFromMasked(inner)
      if (sub === null) return null
      for (const table of sub) tables.add(table)
      i = skipAliasAndColumnList(s, close + 1)
    } else if (ch === ')') {
      return null
    } else if (ch === '@') {
      // SELECT ... INTO @var(变量赋值,非表引用)
      let j = i + 1
      while (j < s.length && /[A-Za-z0-9_$.]/.test(s[j])) j += 1
      i = j
      return i
    } else {
      // 跳过修饰词(IF NOT EXISTS / TABLE / ONLY ...)
      for (;;) {
        const rest = s.slice(i)
        const wordMatch = /^[A-Za-z]+/.exec(rest)
        if (!wordMatch || !TABLE_MODIFIERS.has(wordMatch[0].toLowerCase())) break
        i = skipSpace(s, i + wordMatch[0].length)
        if (i >= s.length) return null
      }
      const identMatch = IDENTIFIER_RE.exec(s.slice(i))
      if (!identMatch) return null // 无法识别 FROM 后的标识符 → fail-closed
      const rawIdent = identMatch[0]
      const table = unquoteIdentifier(rawIdent)
      const lower = table.toLowerCase()
      if (table && !NON_TABLE_WORDS.has(lower)) tables.add(table)
      // INTO OUTFILE/DUMPFILE 为文件写入,不是表引用;到此结束即可
      if (keyword === 'into' && (lower === 'outfile' || lower === 'dumpfile')) return i + rawIdent.length
      i = skipAliasAndColumnList(s, i + rawIdent.length)
    }
    i = skipSpace(s, i)
    if (s[i] === ',') {
      i += 1
      continue
    }
    return i
  }
}

function extractFromMasked(masked) {
  const tables = new Set()
  TABLE_KEYWORD_RE.lastIndex = 0
  let m
  while ((m = TABLE_KEYWORD_RE.exec(masked))) {
    const keyword = m[1].toLowerCase()
    const next = scanTableRefs(masked, TABLE_KEYWORD_RE.lastIndex, keyword, tables)
    if (next === null) return null
    TABLE_KEYWORD_RE.lastIndex = next
  }
  const ctes = collectCteNames(masked)
  return [...tables].filter((table) => !ctes.has(table.toLowerCase()))
}

/**
 * SQL 表名提取(表级权限校验用;去掉库前缀与引号,过滤非表关键字)。
 * 返回:
 *  - string[]:可靠识别出的表名(无表引用时是 [],如 SELECT 1);
 *  - null    :存在 FROM/JOIN 等但无法可靠识别其后标识符 → 调用方必须 fail-closed。
 */
export function extractTables(sql) {
  const masked = maskSql(String(sql || ''), { maskDoubleQuoted: false })
  if (!masked.trim()) return []
  return extractFromMasked(masked)
}
