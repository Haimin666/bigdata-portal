// Spark 引擎执行模块:经 db-proxy 的 /spark/* 端点执行 SQL / PySpark。
// 背景:自建 Spark 网关(放弃 Livy)——db-proxy 集成一个常驻 client 模式 SparkSession,
// 门户只做网关:写拦截(isSparkWriteSql + X-Spark-Token)在 server/index.js 完成,
// 解锁后的请求带 writeUnlocked=true 透传给 db-proxy;db-proxy 侧 allowWrite 为第二道防线。
import config from './config.js'

const BASE = config.dbProxyUrl
const TOKEN = config.dbProxyToken

async function proxy(path, opts = {}) {
  if (!BASE) throw new Error('db-proxy not configured (DB_PROXY_URL empty)')
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-DB-Token': TOKEN,
      ...(opts.headers || {})
    },
    signal: AbortSignal.timeout(opts.timeoutMs || 300000)
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.detail || body.msg || `db-proxy HTTP ${res.status} ${path}`)
  }
  return body
}

/**
 * Spark 元数据(表结构树/补全):只读 SHOW/DESC,db-proxy 侧 TTL 缓存,不重复打集群
 */
export async function schemaDatabases() {
  const body = await proxy('/spark/schema/databases', { method: 'GET', timeoutMs: 60000 })
  return body.data
}

export async function schemaTables(db) {
  const body = await proxy(`/spark/schema/tables?db=${encodeURIComponent(db)}`, { method: 'GET', timeoutMs: 60000 })
  return body.data
}

export async function schemaFields(db, table) {
  const q = `db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`
  const body = await proxy(`/spark/schema/fields?${q}`, { method: 'GET', timeoutMs: 60000 })
  return body.data
}
  /**
 * 执行 SQL 或 PySpark 代码,返回 { columns, rows, costMs, truncated }
 * @param {string} sql  SQL 文本(kind=sql)或 PySpark 代码(kind=pyspark)
 * @param {{ kind?: 'sql'|'pyspark', writeUnlocked?: boolean, timeoutMs?: number }} [opts]
 */
export async function query(sql, { kind = 'sql', writeUnlocked = false, timeoutMs = 120000 } = {}) {
  const payload =
    kind === 'pyspark'
      ? { kind: 'pyspark', code: sql, writeUnlocked, timeoutMs }
      : { kind: 'sql', sql, writeUnlocked, timeoutMs }
  // 写解锁凭证:仅当 writeUnlocked=true 时附加共享密钥头,供 db-proxy 侧服务端校验(S1)
  const headers = {}
  if (writeUnlocked) headers['X-Spark-Write'] = config.dbProxyWriteToken
  const res = await proxy('/spark/query', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers,
    timeoutMs
  })
  return res.data
}

/**
 * 异步提交 spark 任务:立即返回 jobId,后台线程执行。
 * 动机:公司网关固定 60s 读超时,大查询同步挂起会被掐断 504;异步化后
 * 提交/查状态/取消都是秒级往返,永不撞超时。
 */
export async function submitJob(
  sql,
  { kind = 'sql', writeUnlocked = false, timeoutMs = 600000 } = {}
) {
  const payload =
    kind === 'pyspark'
      ? { kind: 'pyspark', code: sql, writeUnlocked, timeoutMs }
      : { kind: 'sql', sql, writeUnlocked, timeoutMs }
  const headers = {}
  if (writeUnlocked) headers['X-Spark-Write'] = config.dbProxyWriteToken
  const res = await proxy('/spark/jobs', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers,
    timeoutMs: 30000
  })
  return res.data // { jobId }
}

/** 查询异步任务状态(queued|running|done|failed) */
export async function jobStatus(jobId, timeoutMs = 30000) {
  const res = await proxy(`/spark/jobs/${encodeURIComponent(jobId)}`, { timeoutMs })
  return res.data
}

/** 取消异步任务(大查询中途停止) */
export async function cancelJob(jobId, timeoutMs = 30000) {
  const res = await proxy(`/spark/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    timeoutMs
  })
  return res.data
}

/** 读取 spark 引擎日志增量(driver JVM 日志 + 审计),供前端日志面板透传 */
export async function readLogs(offsets = { jvm: 0, audit: 0 }) {
  const q = new URLSearchParams({
    jvm: String(offsets.jvm || 0),
    audit: String(offsets.audit || 0)
  })
  const res = await proxy(`/spark/logs?${q}`, { timeoutMs: 10000 })
  return res.data
}

/** Spark 引擎状态(session state / appId / 配置快照) */
export async function status() {
  const res = await proxy('/spark/status', { timeoutMs: 10000 })
  return res.data
}

/** 前端设置 Spark executor 数量(方案A):0=动态分配;5/10/15/20=固定常驻,下次查询生效 */
export async function setExecutors(executorInstances) {
  const res = await proxy('/spark/config', {
    method: 'POST',
    body: JSON.stringify({ executorInstances }),
    timeoutMs: 10000,
  })
  return res.data
}

/** Spark 活跃 job/stage 进度(statusTracker,供日志面板进度条) */
export async function stagesStatus() {
  const res = await proxy('/spark/stages', { timeoutMs: 10000 })
  return res.data
}

/** 取消当前正在执行的 spark 查询/代码(前端"停止"按钮) */
export async function cancel() {
  const res = await proxy('/spark/cancel', { method: 'POST', timeoutMs: 10000 })
  return res.data
}
