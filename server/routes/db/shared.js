// 数据库查询域共享工具(自 routes/db.js 拆出,行为零变化):
//  - SQL 写检测(isSparkWriteSql,「白名单读 + 显式拒绝」策略)
//  - 引号感知的多语句切分(splitSqlStatements)
//  - 简易表名提取(extractTables,表级权限校验用)
//  - X-Spark-Token 体系(签发/校验/过期清理,Spark 与 Flink 共用)
// 写防线三层:网关 SQL 检测 → 绑定用户 token → db-proxy X-Spark-Write 共享密钥(见 modules/spark-flink.md)。
import { randomBytes } from 'node:crypto'

// X-Spark-Token 有效期:12h(与 Spark 写解锁密码体系一致,Flink 共用同一 token)
export const SPARK_WRITE_TOKEN_TTL = 12 * 60 * 60 * 1000 // 12h
// token -> { username, expiresAt }:绑定签发用户,防跨用户复用(XSS 窃取的 token 仅本人会话可用)
const sparkTokens = new Map()

// 判定 SQL 是否可能为写操作(服务端权威校验,采用「白名单读 + 显式拒绝」策略):
// 1) 去掉注释后,若以只读关键字开头(SELECT/SHOW/DESC/DESCRIBE/EXPLAIN/SET/USE 且无写关键字),
//    放行;否则一律视为写操作,要求 X-Spark-Token。
// 2) 显式拒绝多语句走私(含分号)与 CTE 前缀的 DML(WITH cte AS (...) INSERT ...)。
export const SPARK_READONLY_KW = /^(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|SET|USE)\b/i
export const SPARK_WRITE_KW = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|MSCK|REFRESH|LOAD|OVERWRITE)\b/i
// SELECT 前缀走私:MySQL 可用 SELECT ... INTO OUTFILE/DUMPFILE 写服务器文件、
// LOAD_FILE() 读服务器文件、FOR UPDATE 行锁、GET_LOCK/SLEEP/BENCHMARK 资源消耗,
// 均视为写/敏感操作,需解锁
export const SPARK_SELECT_SMUGGLE =
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

/** 简易 SQL 表名提取(表级权限校验用;去掉库前缀与引号,过滤非表关键字)。
 *  支持逗号交叉连接(FROM t1, t2)、STRAIGHT_JOIN 等无词边界变体,子查询括号内的
 *  逗号不误提取;纯数字 token(如 LIMIT 10, 20)与边界关键字(LIMIT/SET/WHERE 等)不提取。 */
const TABLE_KW_RE = /\b(?:from|join|straight_join|update|into|table)\s+([`"']?)([A-Za-z0-9_$#.\-]+)\1/gi
// 关键字匹配后的逗号延续段需停下的边界(防止把 SELECT 列表 / LIMIT 数字吞成表名)
const TABLE_BOUNDARY_RE = /^(?:\s|,)*\b(?:where|group\s+by|order\s+by|having|limit|union|on|and|or|left|right|inner|outer|full|cross|join|straight_join|set|values|returning)\b/i
const TABLE_NON_TABLE_RE = /^(?:select|where|set|values|left|right|inner|outer|full|cross|on|and|or|as|limit|group|order|having|dual)$/i

export function extractTables(sql) {
  let s = String(sql || '').replace(/\/\*[\s\S]*?\*\//g, '')
  // 先折叠反引号/双引号双段名(`db`.`tbl` / "db"."tbl")为 db.tbl,取末段为表名;
  // 必须在字符串剥离之前,否则 "d"."t" 的引号段会被当字符串剥掉
  s = s.replace(/`([^`]+)`\.`([^`]+)`/g, '$1.$2').replace(/"([^"]+)"\."([^"]+)"/g, '$1.$2')
  // 剥离字符串字面量,防 SELECT 'INSERT INTO fake' 之类关键字误报
  s = s.replace(/'(?:[^'\\]|\\.|'')*'/g, "''").replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
  const tables = new Set()
  const add = (raw) => {
    let t = String(raw || '').replace(/[`"']/g, '')
    if (t.includes('.')) t = t.split('.').pop()
    // 纯数字(LIMIT 10,20)不入表集;关键字过滤
    if (t && /[A-Za-z_$#]/.test(t) && !TABLE_NON_TABLE_RE.test(t)) tables.add(t)
  }
  let m
  while ((m = TABLE_KW_RE.exec(s))) {
    add(m[2])
    // 逗号延续:FROM t1, t2, t3 逐段提取;遇到边界关键字/非标识符(如 FROM ( 子查询)即停
    let i = TABLE_KW_RE.lastIndex
    while (i < s.length) {
      const rest = s.slice(i)
      if (TABLE_BOUNDARY_RE.test(rest)) break
      const cm = /^[\s,]*([`"']?)([A-Za-z0-9_$#.\-]+)\1/.exec(rest)
      if (!cm) break
      add(cm[2])
      i += cm[0].length
    }
  }
  return [...tables]
}

/** 写解锁 token 签发(POST /api/spark/auth 密码验证通过后调用):绑定签发用户 */
export function issueSparkToken(username) {
  const token = randomBytes(24).toString('hex')
  sparkTokens.set(token, { username: username || null, expiresAt: Date.now() + SPARK_WRITE_TOKEN_TTL })
  return token
}

/** token 校验:存在、未过期、且认证开启时仅签发者本人可用(他人复用无效并删除,防重放) */
export function sparkTokenValid(token, req) {
  const rec = sparkTokens.get(token)
  if (!rec) return false
  if (Date.now() > rec.expiresAt) {
    sparkTokens.delete(token)
    return false
  }
  // 绑定签发用户:认证开启时仅签发者本人可用,他人复用一律无效并删除(防重放)
  if (rec.username != null) {
    const cur = req?.user?.username || null
    if (cur !== rec.username) {
      sparkTokens.delete(token)
      return false
    }
  }
  return true
}

/** 周期清理过期 spark token,防止内存无限增长(G2);由 spark.js 的定时器调用 */
export function gcSparkTokens() {
  const now = Date.now()
  for (const [tk, rec] of sparkTokens) if (rec.expiresAt < now) sparkTokens.delete(tk)
}
