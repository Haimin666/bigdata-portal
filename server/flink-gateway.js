// Flink 引擎执行模块:经 db-proxy 的 /flink/* 端点执行 SQL(交互)与 PreJob 提交。
// 背景:与 spark 网关同构——门户只做网关,写拦截(isSparkWriteSql + X-Spark-Token,
// 与 Spark 共用同一密码与 token 体系)在 server/index.js 完成;db-proxy 侧
// flink.allowWrite 为第二道防线。prejob 提交会真实占用集群资源,同样要求 token。
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
 * 执行 Flink SQL(交互通道,共享常驻会话),返回 { columns, rows, costMs, truncated }
 * @param {string} sql Flink SQL 脚本(可多语句,`;` 分隔)
 * @param {{ mode?: 'batch'|'stream', writeUnlocked?: boolean, timeoutMs?: number }} [opts]
 */
export async function query(sql, { mode = 'batch', writeUnlocked = false, timeoutMs = 120000 } = {}) {
  const res = await proxy('/flink/query', {
    method: 'POST',
    body: JSON.stringify({ sql, mode, writeUnlocked, timeoutMs }),
    timeoutMs
  })
  return res.data
}

/** 取消当前正在执行的 flink 查询(前端"停止"按钮) */
export async function cancel() {
  const res = await proxy('/flink/cancel', { method: 'POST', timeoutMs: 10000 })
  return res.data
}

/** Flink 引擎状态(session state / yarnAppId / allowWrite) */
export async function status() {
  const res = await proxy('/flink/status', { timeoutMs: 10000 })
  return res.data
}

// ── 连接器 / DDL 生成(只读,不执行)──────────────────────────
export async function connectors() {
  const res = await proxy('/flink/connectors', { timeoutMs: 10000 })
  return res.data
}

export async function probeSchema(connector, params) {
  const res = await proxy(`/flink/connectors/${connector}/probe`, {
    method: 'POST',
    body: JSON.stringify({ params }),
    timeoutMs: 20000
  })
  return res.data
}

export async function generateDdl(payload) {
  const res = await proxy('/flink/ddl/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: 10000
  })
  return res.data
}

// ── 交互引擎流式任务(内存态)──────────────────────────────
export async function jobs() {
  const res = await proxy('/flink/jobs', { timeoutMs: 10000 })
  return res.data
}

export async function jobStatus(jobId) {
  const res = await proxy(`/flink/jobs/${jobId}`, { timeoutMs: 10000 })
  return res.data
}

export async function jobStop(jobId) {
  const res = await proxy(`/flink/jobs/${jobId}/stop`, { method: 'POST', timeoutMs: 10000 })
  return res.data
}

// ── PreJob 提交(yarn-per-job 独立作业)────────────────────
export async function prejobSubmit(payload, timeoutMs = 180000) {
  const res = await proxy('/flink/prejob/jobs', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs
  })
  return res.data
}

export async function prejobJobs() {
  const res = await proxy('/flink/prejob/jobs', { timeoutMs: 10000 })
  return res.data
}

export async function prejobStatus(jobId) {
  const res = await proxy(`/flink/prejob/jobs/${jobId}`, { timeoutMs: 10000 })
  return res.data
}

export async function prejobLogs(jobId, tail = 200) {
  const res = await proxy(`/flink/prejob/jobs/${jobId}/logs?tail=${tail}`, { timeoutMs: 30000 })
  return res.data
}

export async function prejobCancel(jobId) {
  const res = await proxy(`/flink/prejob/jobs/${jobId}/cancel`, { method: 'POST', timeoutMs: 30000 })
  return res.data
}

export async function prejobConfig() {
  const res = await proxy('/flink/prejob/config', { timeoutMs: 10000 })
  return res.data
}
