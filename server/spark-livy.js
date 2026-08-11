// Spark SQL 执行模块:经 Livy REST API 运行 SQL
// 常驻一个 kind=sql 的 session(idle 复用),提交纯 SQL 并轮询结果,
// 把 Livy 的结构化表格结果统一为 { columns, rows } 供前端表格渲染。
import config from './config.js'

let cachedSessionId = null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchLivy(path, opts = {}) {
  const res = await fetch(config.livyUrl + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    // 单次请求超时:建 session/提交/查询各 10s 足够
    signal: AbortSignal.timeout(10000)
  })
  if (!res.ok) throw new Error(`livy HTTP ${res.status} ${path}`)
  return res.json()
}

/** 确保存在一个 idle 的 sql session(复用已有,避免反复向 YARN 申请资源) */
async function ensureSession() {
  if (cachedSessionId) {
    try {
      const s = await fetchLivy(`/sessions/${cachedSessionId}`)
      if (s.state === 'idle') return cachedSessionId
    } catch {
      /* 会话已失效,重建 */
    }
    cachedSessionId = null
  }
  // 优先复用集群里现成的 idle sql session
  const list = await fetchLivy('/sessions')
  const existing = (list.sessions || []).find((s) => s.kind === 'sql' && s.state === 'idle')
  if (existing) {
    cachedSessionId = existing.id
    return existing.id
  }
  // 新建 sql session 并等它就绪(最长 180s)
  const created = await fetchLivy('/sessions', {
    method: 'POST',
    body: JSON.stringify({ kind: 'sql', name: 'portal-spark-sql' })
  })
  cachedSessionId = created.id
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    const s = await fetchLivy(`/sessions/${created.id}`)
    if (s.state === 'idle') return created.id
    if (s.state === 'dead' || s.state === 'error' || s.state === 'killed') {
      throw new Error(`spark session 异常退出:${s.state}`)
    }
    await sleep(2000)
  }
  throw new Error('spark session 创建超时(180s)')
}

/**
 * 执行一条 SQL,返回 { columns, rows, costMs, truncated }
 * @param {string} sql
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function query(sql, { timeoutMs = 120000 } = {}) {
  const sessionId = await ensureSession()
  const sub = await fetchLivy(`/sessions/${sessionId}/statements`, {
    method: 'POST',
    body: JSON.stringify({ code: sql })
  })
  const stmtId = sub.id
  const t0 = Date.now()
  let stmt = sub
  while (stmt.state === 'waiting' || stmt.state === 'running') {
    if (Date.now() - t0 > timeoutMs) throw new Error('spark 查询超时')
    await sleep(1000)
    stmt = await fetchLivy(`/sessions/${sessionId}/statements/${stmtId}`)
  }
  if (!stmt.output || stmt.output.status !== 'ok') {
    throw new Error(stmt.output?.evalue || `spark statement 状态:${stmt.state}`)
  }
  const data = stmt.output.data || {}
  // Livy sql session 的结构化表格输出
  const table = data['application/vnd.livy.table.v1+json'] || data['application/json']
  if (table && Array.isArray(table.columns)) {
    return {
      columns: table.columns,
      rows: (table.rows || []).map((r) =>
        Object.fromEntries(table.columns.map((c, i) => [c, r[i]]))
      ),
      costMs: Date.now() - t0,
      truncated: false
    }
  }
  // text/plain 兜底(如 SHOW 类输出)
  const text = data['text/plain'] || ''
  return {
    columns: ['output'],
    rows: text.split('\n').map((line) => ({ output: line })),
    costMs: Date.now() - t0,
    truncated: false
  }
}
