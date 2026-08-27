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
 * 1) 去掉注释后,若以只读关键字开头(SELECT/SHOW/DESC/DESCRIBE/EXPLAIN/SET/USE/WITH 且无写关键字),
 *    放行;否则一律视为写操作,要求 X-Spark-Token。
 * 2) 显式拒绝多语句走私(含分号)与 CTE 前缀的 DML(WITH cte AS (...) INSERT ...)。
 */
export function isSparkWriteSql(sql) {
  const raw = String(sql)
  // MySQL/MariaDB 可执行注释 /*! ... */ 与 /*M! ... */ 会被数据库执行,绝不能当普通注释删除 —— 检测到一律视为写
  if (/\*[Mm]?!/.test(raw)) return true
  let s = raw
    // 去注释(行注释与块注释)
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '')
    .trim()
  if (!s) return false
  // 多语句走私:引号感知切分,非末尾分号都拒绝
  const parts = splitSqlStatements(s)
  const last = parts[parts.length - 1].trim()
  if (parts.length > 2 || (parts.length === 2 && last !== '')) return true
  s = last || parts[0].trim()
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

/** 简易 SQL 表名提取(表级权限校验用;去掉库前缀与引号,过滤非表关键字) */
export function extractTables(sql) {
  const s = String(sql || '').replace(/\/\*[\s\S]*?\*\//g, '')
  const tables = new Set()
  const re = /\b(?:from|join|update|into|table)\s+([`"']?)([A-Za-z0-9_$#.\-]+)\1/gi
  let m
  while ((m = re.exec(s))) {
    let t = String(m[2]).replace(/[`"']/g, '')
    if (t.includes('.')) t = t.split('.').pop()
    if (t && !/^(select|where|set|values|left|right|inner|outer|full|cross|on|and|or|as|limit|group|order|having|dual)$/i.test(t)) tables.add(t)
  }
  return [...tables]
}