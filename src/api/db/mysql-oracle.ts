// MySQL/Oracle 查询与异步任务(经网关 /api/dbquery/query、/api/db/jobs)
import type { DbQueryResult } from './core'

interface ApiResponse<T> {
  code?: number
  data?: T
  detail?: string
  msg?: string
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

/** Spark 异步任务信息(mysql/oracle 异步任务复用同一结构) */
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
