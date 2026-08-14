// 数据库查询 API:经网关 /api/db/* 代理到客户机 db-proxy
// (鉴权 X-DB-Token 由网关注入,前端不感知)

export interface DbDataSource {
  name: string
  /** 显示别名(缺省回退 name) */
  label?: string
  type: 'mysql' | 'oracle' | 'sparksql' | 'pyspark' | 'flinksql'
  host: string
  port: number
  user: string
  rowLimit?: string
}

export interface DbQueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  costMs: number
  truncated: boolean
}

/** 门户模块显隐配置(服务端 config.local.json 的 enabledModules) */
export async function getEnabledModules(): Promise<string[]> {
  try {
    const res = await fetch('/api/config/modules')
    if (!res.ok) return []
    const body = (await res.json()) as { code?: number; data?: { enabledModules?: string[] } }
    if (body.code !== undefined && body.code !== 0) return []
    const list = body.data?.enabledModules
    return Array.isArray(list) ? list : []
  } catch {
    // 配置接口不可用时按"全部展示"处理
    return []
  }
}

interface ApiResponse<T> {
  code?: number
  data?: T
  detail?: string
  msg?: string
  ok?: boolean
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/db${path}`, init)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略非 JSON */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<T>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '请求失败')
  return body.data as T
}

/** 拉取数据源列表(带类型,来自 /acl) */
export async function listDataSources(): Promise<DbDataSource[]> {
  const data = await request<{ datasources?: DbDataSource[] }>('/acl')
  return data.datasources || []
}

/** 执行查询(mysql/oracle;经网关 /api/dbquery/query,写操作需 X-Spark-Token 解锁) */
export async function queryDb(db: string, sql: string, writeToken?: string): Promise<DbQueryResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (writeToken) headers['X-Spark-Token'] = writeToken
  const res = await fetch('/api/dbquery/query', {
    method: 'POST',
    headers,
    body: JSON.stringify({ db, sql })
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略非 JSON */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<DbQueryResult>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '请求失败')
  return body.data as DbQueryResult
}

// ── mysql/oracle 异步任务(慢查询/大查询,规避公司网关 60s 超时)──
/** 异步提交 mysql/oracle 查询:立即返回 jobId(不阻塞等结果)
 *  写 SQL 需 X-Spark-Token 解锁(网关 /api/db/jobs 校验,与 /api/dbquery/query 同防线) */
export async function submitDbJob(db: string, sql: string, timeoutMs = 3600000, writeToken?: string): Promise<{ jobId: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (writeToken) headers['X-Spark-Token'] = writeToken
  const res = await fetch('/api/db/jobs', {
    method: 'POST',
    headers,
    body: JSON.stringify({ db, sql, timeoutMs })
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略 */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<{ jobId: string }>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '提交失败')
  return body.data as { jobId: string }
}

/** 查询 mysql/oracle 异步任务状态 */
export async function getDbJob(jobId: string): Promise<SparkJobInfo> {
  const res = await fetch(`/api/db/jobs/${encodeURIComponent(jobId)}`)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略 */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<SparkJobInfo>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '查询失败')
  return body.data as SparkJobInfo
}

/** 取消 mysql/oracle 异步任务(手动停止) */
export async function cancelDbJob(jobId: string): Promise<{ cancelled: boolean }> {
  const res = await fetch(`/api/db/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略 */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<{ cancelled: boolean }>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '取消失败')
  return body.data as { cancelled: boolean }
}

/** Spark SQL/PySpark 查询(经网关 /api/spark/query 走 db-proxy 常驻 SparkSession)
 *  timeoutMs:前端侧 AbortSignal 超时 + 透传后端统一超时,默认 120s。
 *  超时后自动请求 cancelSpark 清理后端挂起的 job,避免查询无限等待占锁。 */
export async function querySpark(
  sql: string,
  writeToken?: string,
  kind: 'sql' | 'pyspark' = 'sql',
  timeoutMs = 120000
): Promise<DbQueryResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (writeToken) headers['X-Spark-Token'] = writeToken
  const run = (t: number) =>
    fetch('/api/spark/query', {
      method: 'POST',
      headers,
      body: JSON.stringify({ sql, kind, timeoutMs: t }),
      signal: AbortSignal.timeout(t)
    })
  let res: Response
  try {
    res = await run(timeoutMs)
  } catch (e) {
    // 前端/网关超时:尝试取消后端 job,避免 collect 挂起占住 db-proxy 串行锁
    try {
      await fetch('/api/spark/cancel', { method: 'POST' })
    } catch {
      /* 忽略取消失败 */
    }
    throw new Error(`执行超时(${Math.round(timeoutMs / 1000)}s),已自动取消后端任务,请缩小数据量或简化 SQL 后重试`)
  }
  // 504 冷启动补偿:网关/代理超时(nginx 60s)但 db-proxy 可能仍在执行(session 冷启动),
  // 自动重试一次 —— 第二次 session 已就绪,通常秒回;重试超时给更长(180s)
  if (res.status === 504) {
    try {
      await fetch('/api/spark/cancel', { method: 'POST' })
    } catch {
      /* 忽略 */
    }
    try {
      res = await run(Math.max(timeoutMs, 180000))
    } catch (e) {
      try {
        await fetch('/api/spark/cancel', { method: 'POST' })
      } catch {
        /* 忽略 */
      }
      throw new Error(`执行超时,已自动取消后端任务,请缩小数据量或简化 SQL 后重试`)
    }
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略非 JSON */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<DbQueryResult>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '请求失败')
  return body.data as DbQueryResult
}

/** 停止当前执行的 Spark 查询/代码(前端"停止"按钮) */
export async function cancelSpark(): Promise<{ cancelled: boolean }> {
  const res = await fetch('/api/spark/cancel', { method: 'POST' })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略非 JSON */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<{ cancelled: boolean }>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '请求失败')
  return body.data as { cancelled: boolean }
}

// ── Spark 异步任务(大查询/长任务,规避公司网关 60s 超时)────────
export interface SparkJobInfo {
  id: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  sql?: string
  kind?: string
  createdAt?: number
  startedAt?: number
  finishedAt?: number
  result?: DbQueryResult
  error?: string
}

/** 异步提交 Spark 任务,立即返回 jobId(不阻塞等结果) */
export async function submitSparkJob(
  sql: string,
  writeToken?: string,
  kind: 'sql' | 'pyspark' = 'sql',
  timeoutMs = 600000
): Promise<{ jobId: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (writeToken) headers['X-Spark-Token'] = writeToken
  const payload = kind === 'pyspark' ? { kind, code: sql, timeoutMs } : { kind, sql, timeoutMs }
  const res = await fetch('/api/spark/jobs', { method: 'POST', headers, body: JSON.stringify(payload) })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略 */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<{ jobId: string }>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '提交失败')
  return body.data as { jobId: string }
}

/** 查询异步任务状态 */
export async function getSparkJob(jobId: string): Promise<SparkJobInfo> {
  const res = await fetch(`/api/spark/jobs/${encodeURIComponent(jobId)}`)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略 */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<SparkJobInfo>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '查询失败')
  return body.data as SparkJobInfo
}

/** 取消异步任务(大查询中途停止) */
export async function cancelSparkJob(jobId: string): Promise<{ cancelled: boolean }> {
  const res = await fetch(`/api/spark/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略 */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<{ cancelled: boolean }>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '取消失败')
  return body.data as { cancelled: boolean }
}

/** Flink 专用请求:走网关 /api/flink/*(不经 /api/db 透传,网关统一鉴权) */
async function flinkRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/flink${path}`, init)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略非 JSON */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<T>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '请求失败')
  return body.data as T
}

/** FlinkSQL 查询(经网关 /api/flink/query;所有 flink 任务需 X-Spark-Token 解锁,与 Spark 共用密码) */
export async function queryFlink(sql: string, mode: 'batch' | 'stream' = 'batch', writeToken?: string): Promise<DbQueryResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (writeToken) headers['X-Spark-Token'] = writeToken
  return flinkRequest<DbQueryResult>('/query', {
    method: 'POST',
    headers,
    body: JSON.stringify({ sql, mode })
  })
}

/** Flink 连接器定义列表(密码已脱敏) */
export async function flinkConnectors(): Promise<FlinkConnector[]> {
  const res = await flinkRequest<{ connectors: FlinkConnector[] }>('/connectors')
  return res.connectors
}

/** Flink 连接器字段探测(仅 mysql-cdc) */
export async function flinkProbeSchema(connector: string, params: Record<string, string>): Promise<{
  fields: FlinkField[]
  primaryKeys: string[]
  source: string
}> {
  return flinkRequest('/connectors/' + connector + '/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params })
  })
}

/** 生成 CREATE TABLE DDL */
export async function flinkGenerateDdl(tableName: string, connector: string, params: Record<string, string>, fields: FlinkField[]): Promise<{ ddl: string }> {
  return flinkRequest('/ddl/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableName, connector, params, fields })
  })
}

/** Flink 流式任务列表 */
export async function flinkJobs(): Promise<FlinkJob[]> {
  const res = await flinkRequest<{ jobs: FlinkJob[] }>('/jobs')
  return res.jobs
}

/** Flink 流式任务状态 */
export async function flinkJobStatus(jobId: string): Promise<FlinkJob> {
  return flinkRequest<FlinkJob>('/jobs/' + jobId)
}

/** 停止 Flink 流式任务 */
export async function flinkJobStop(jobId: string): Promise<{ stopped: boolean }> {
  return flinkRequest('/jobs/' + jobId + '/stop', { method: 'POST' })
}

/** Flink 引擎状态 */
export async function flinkStatus(): Promise<Record<string, unknown>> {
  return flinkRequest('/status')
}

// ── Flink PreJob(yarn-per-job 独立作业)──────────────────
export interface FlinkPreJob {
  jobId: string
  name: string
  appId: string
  status: string
  finalStatus: string
  trackingUrl: string
  queue: string
  submittedAt: string
  updatedAt: string
  error: string
  sql?: string
}

/** 提交 Flink PreJob(需解锁;会真实向 YARN 提交独立作业) */
export async function flinkPrejobSubmit(name: string, sql: string, writeToken?: string, queue?: string): Promise<FlinkPreJob> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (writeToken) headers['X-Spark-Token'] = writeToken
  return flinkRequest<FlinkPreJob>('/prejob/jobs', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, sql, ...(queue ? { queue } : {}) })
  })
}

/** PreJob 作业列表 */
export async function flinkPrejobJobs(): Promise<FlinkPreJob[]> {
  const res = await flinkRequest<{ jobs: FlinkPreJob[] }>('/prejob/jobs')
  return res.jobs
}

/** PreJob 作业详情 */
export async function flinkPrejobStatus(jobId: string): Promise<FlinkPreJob> {
  return flinkRequest<FlinkPreJob>('/prejob/jobs/' + jobId)
}

/** PreJob 作业日志(尾部) */
export async function flinkPrejobLogs(jobId: string, tail = 200): Promise<{ appId: string; logs: string; error: string }> {
  return flinkRequest('/prejob/jobs/' + jobId + '/logs?tail=' + tail)
}

/** 停止 PreJob 作业 */
export async function flinkPrejobCancel(jobId: string): Promise<{ cancelled: boolean }> {
  return flinkRequest('/prejob/jobs/' + jobId + '/cancel', { method: 'POST' })
}

/** PreJob 配置快照 */
export async function flinkPrejobConfig(): Promise<Record<string, unknown>> {
  return flinkRequest('/prejob/config')
}

export interface FlinkConnector {
  name: string
  label: string
  type: string
  defaults: Record<string, string>
  dynamicFields: { key: string; label: string; placeholder?: string }[]
  probe: boolean
}

export interface FlinkField {
  name: string
  type: string
  primaryKey?: boolean
  comment?: string
}

export interface FlinkJob {
  jobId: string
  sql: string
  status: string
  submittedAt: string
  mode: string
}

/** 停止当前执行的 Flink 查询 */
export async function cancelFlink(): Promise<{ cancelled: boolean }> {
  const res = await fetch('/api/flink/cancel', { method: 'POST' })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略非 JSON */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<{ cancelled: boolean }>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '请求失败')
  return body.data as { cancelled: boolean }
}

/** Spark driver 日志增量读取(经网关透传 db-proxy;per-file offset 防漂移) */
export async function sparkLogs(offsets: { jvm?: number; audit?: number } = {}): Promise<{
  content: string
  offsets: { jvm: number; audit: number }
  files: { jvm: number; audit: number }
}> {
  const q = new URLSearchParams({
    jvm: String(offsets.jvm || 0),
    audit: String(offsets.audit || 0)
  })
  const res = await fetch(`/api/spark/logs?${q}`)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略非 JSON */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<{
    content: string
    offsets: { jvm: number; audit: number }
    files: { jvm: number; audit: number }
  }>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '请求失败')
  return body.data as {
    content: string
    offsets: { jvm: number; audit: number }
    files: { jvm: number; audit: number }
  }
}

/** Spark 引擎状态(会话/appId/配置快照) */
export async function sparkStatus(): Promise<Record<string, unknown>> {
  const res = await fetch('/api/spark/status')
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略非 JSON */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<Record<string, unknown>>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '请求失败')
  return body.data as Record<string, unknown>
}

/** Spark 写操作解锁:密码换取 token(类似 Jupyter 登录) */
export async function sparkAuth(password: string): Promise<{ token: string; expiresIn: number }> {
  const res = await fetch('/api/spark/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略非 JSON */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<{ token: string; expiresIn: number }>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '请求失败')
  return body.data as { token: string; expiresIn: number }
}

// ── 脚本存储(我的目录:平台本地 data/scripts/,经 /api/scripts)──
export interface ScriptNode {
  id: string
  name: string
  type: 'dir' | 'file'
  children?: ScriptNode[]
}

export interface ScriptTree {
  my: ScriptNode[]
}

async function scriptRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/scripts${path}`, init)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiResponse<unknown>
      msg = body.detail || body.msg || msg
    } catch {
      /* 忽略非 JSON */
    }
    throw new Error(msg)
  }
  const body = (await res.json()) as ApiResponse<T>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '请求失败')
  return body.data as T
}

export async function listScriptTree(): Promise<ScriptTree> {
  return scriptRequest<ScriptTree>('/tree')
}

export async function createScriptNode(parentId: string | null, name: string, kind: 'dir' | 'file'): Promise<ScriptNode> {
  return scriptRequest<ScriptNode>('/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId, name, kind })
  })
}

export async function renameScriptNode(id: string, name: string): Promise<ScriptNode> {
  return scriptRequest<ScriptNode>('/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name })
  })
}

export async function deleteScriptNode(id: string): Promise<void> {
  await scriptRequest<never>('/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  })
}

export async function moveScriptNode(id: string, targetParentId: string | null): Promise<ScriptNode> {
  return scriptRequest<ScriptNode>('/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, targetParentId })
  })
}

export async function saveScriptContent(id: string, content: string): Promise<void> {
  await scriptRequest<never>('/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, content })
  })
}

export async function getScriptContent(id: string): Promise<{ id: string; content: string }> {
  return scriptRequest<{ id: string; content: string }>(`/get?id=${encodeURIComponent(id)}`)
}

// ── 表目录(库→表→字段)────────────────────────────────────────
export interface TableField {
  name: string
  type: string
}

export async function listTables(db: string): Promise<string[]> {
  return request<string[]>(`/tables?db=${encodeURIComponent(db)}`)
}

export async function listFields(db: string, table: string): Promise<TableField[]> {
  return request<TableField[]>(`/fields?db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`)
}
