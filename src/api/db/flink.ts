// Flink 通道(交互查询、异步任务、连接器/DDL、流任务、PreJob)
import type { DbQueryResult } from './core'

interface ApiResponse<T> {
  code?: number
  data?: T
  detail?: string
  msg?: string
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

// ── Flink 异步任务通道(流式 SELECT / 大结果,避免网关 60s 超时 504)──
export interface FlinkAsyncJob {
  id: string
  state: 'queued' | 'running' | 'done' | 'failed'
  sql?: string
  mode?: string
  createdAt?: number
  startedAt?: number | null
  finishedAt?: number | null
  result?: DbQueryResult | null
  error?: string | null
}

/** 异步提交 Flink SQL(提交即返回 jobId) */
export async function flinkAsyncSubmit(sql: string, mode: 'batch' | 'stream' = 'batch'): Promise<{ jobId: string }> {
  return flinkRequest('/async', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }, // 必须显式声明,否则 fetch 默认 text/plain → 网关不解析 body
    body: JSON.stringify({ sql, mode, timeoutMs: 600000 })
  })
}

/** 查询异步任务状态(结果在 state=done 时返回) */
export async function flinkAsyncStatus(jobId: string): Promise<FlinkAsyncJob> {
  return flinkRequest('/async/' + jobId)
}

/** 取消异步任务 */
export async function flinkAsyncCancel(jobId: string): Promise<{ cancelled: boolean }> {
  return flinkRequest('/async/' + jobId + '/cancel', { method: 'POST' })
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
  resources: Record<string, string | number>
  enabled: boolean
  submittedAt: string
  updatedAt: string
  error: string
  sql?: string
}

/** PreJob 资源配置 */
export interface FlinkPreJobResources {
  parallelism?: number
  jobManagerMemory?: string
  taskManagerMemory?: string
  slotsPerTaskManager?: number
}

/** 提交 Flink PreJob(需解锁;会真实向 YARN 提交独立作业) */
export async function flinkPrejobSubmit(
  name: string,
  sql: string,
  writeToken?: string,
  queue?: string,
  resources?: FlinkPreJobResources
): Promise<FlinkPreJob> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (writeToken) headers['X-Spark-Token'] = writeToken
  return flinkRequest<FlinkPreJob>('/prejob/jobs', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, sql, ...(queue ? { queue } : {}), ...(resources ? { resources } : {}) })
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

/** 下线 PreJob(停止运行 + 标记停用) */
export async function flinkPrejobDisable(jobId: string): Promise<{ disabled: boolean }> {
  return flinkRequest('/prejob/jobs/' + jobId + '/disable', { method: 'POST' })
}

/** 上线 PreJob(按定义重新提交 + 标记启用) */
export async function flinkPrejobEnable(jobId: string): Promise<FlinkPreJob> {
  return flinkRequest('/prejob/jobs/' + jobId + '/enable', { method: 'POST' })
}

/** 编辑 PreJob 定义(改 sql/name/queue/resources,持久化) */
export async function flinkPrejobUpdate(
  jobId: string,
  patch: { name?: string; sql?: string; queue?: string; resources?: FlinkPreJobResources }
): Promise<FlinkPreJob> {
  return flinkRequest('/prejob/jobs/' + jobId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  })
}

/** PreJob 配置快照 */
export async function flinkPrejobConfig(): Promise<Record<string, unknown>> {
  return flinkRequest('/prejob/config')
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
