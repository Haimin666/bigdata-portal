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

/** 取消当前正在执行的 spark 查询/代码(前端"停止"按钮) */
export async function cancel() {
  const res = await proxy('/spark/cancel', { method: 'POST', timeoutMs: 10000 })
  return res.data
}
