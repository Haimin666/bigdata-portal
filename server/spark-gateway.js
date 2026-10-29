// Spark SQL 执行模块:经 db-proxy 的 /spark/* 端点连接 Spark Thrift 或 SparkSession。
// 写权限由门户网关检查;db-proxy 的访问认证仍由 X-DB-Token 控制。
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
export async function schemaDatabases(executionMode = 'thrift') {
  const body = await proxy(`/spark/schema/databases?executionMode=${encodeURIComponent(executionMode)}`, { method: 'GET', timeoutMs: 60000 })
  return body.data
}

export async function schemaTables(db, executionMode = 'thrift') {
  const body = await proxy(`/spark/schema/tables?db=${encodeURIComponent(db)}&executionMode=${encodeURIComponent(executionMode)}`, { method: 'GET', timeoutMs: 60000 })
  return body.data
}

export async function schemaFields(db, table, executionMode = 'thrift') {
  const q = `db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}&executionMode=${encodeURIComponent(executionMode)}`
  const body = await proxy(`/spark/schema/fields?${q}`, { method: 'GET', timeoutMs: 60000 })
  return body.data
}
  /**
 * 执行 Spark SQL,返回 { columns, rows, costMs, truncated }
 * @param {string} sql SQL 文本
 * @param {{ writeUnlocked?: boolean, timeoutMs?: number, executionMode?: string }} [opts]
 */
export async function query(sql, { writeUnlocked = false, timeoutMs = 120000, executionMode = 'thrift' } = {}) {
  const payload = { kind: 'sql', sql, writeUnlocked, timeoutMs, executionMode }
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
  { kind = 'sql', writeUnlocked = false, timeoutMs = 600000, executionMode = 'thrift' } = {}
) {
  if (kind !== 'sql' && kind !== 'export') throw new Error('Spark 工作台仅支持 SparkSQL')
  const payload = { kind, sql, writeUnlocked, timeoutMs, executionMode }
  const headers = {}
  if (writeUnlocked) headers['X-Spark-Write'] = config.dbProxyWriteToken
  const res = await proxy(kind === 'export' ? '/spark/export/jobs' : '/spark/jobs', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers,
    timeoutMs: 30000
  })
  return res.data // { jobId }
}

/** 查询异步任务状态(queued|running|done|failed) */
export async function jobStatus(jobId, timeoutMs = 30000, executionMode = 'thrift') {
  const res = await proxy(`/spark/jobs/${encodeURIComponent(jobId)}?executionMode=${encodeURIComponent(executionMode)}`, { timeoutMs })
  return res.data
}

/** 取消异步任务(大查询中途停止) */
export async function cancelJob(jobId, timeoutMs = 30000, executionMode = 'thrift') {
  const res = await proxy(`/spark/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ executionMode }),
    timeoutMs
  })
  return res.data
}

/** 读取 spark 引擎日志增量(driver JVM 日志 + 审计),供前端日志面板透传 */
export async function readLogs(offsets = { jvm: 0, audit: 0 }, executionMode = 'thrift') {
  const q = new URLSearchParams({
    jvm: String(offsets.jvm || 0),
    audit: String(offsets.audit || 0),
    executionMode
  })
  const res = await proxy(`/spark/logs?${q}`, { timeoutMs: 10000 })
  return res.data
}

/** 所选 Spark 通道状态,用于门户探测引擎可用性 */
export async function status(executionMode = 'thrift') {
  const res = await proxy(`/spark/status?executionMode=${encodeURIComponent(executionMode)}`, { timeoutMs: 10000 })
  return res.data
}

/** 取消当前正在执行的 Spark SQL(前端"停止"按钮) */
export async function cancel(executionMode = 'thrift') {
  const res = await proxy('/spark/cancel', { method: 'POST', body: JSON.stringify({ executionMode }), timeoutMs: 10000 })
  return res.data
}

/** Session Stage 快照;Thrift 返回空快照。 */
export async function stages(executionMode = 'thrift') {
  const res = await proxy(`/spark/stages?executionMode=${encodeURIComponent(executionMode)}`, { timeoutMs: 10000 })
  return res.data
}
