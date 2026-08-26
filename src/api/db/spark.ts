// Spark 通道(同步/异步查询、日志、stage 进度、状态/配置/解锁)
import type { DbQueryResult } from './core'
import type { SparkJobInfo } from './mysql-oracle'

interface ApiResponse<T> {
  code?: number
  data?: T
  detail?: string
  msg?: string
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
  } catch {
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
    } catch {
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

/** Spark 活跃 job/stage 进度(statusTracker,供日志面板进度条) */
export interface SparkStage {
  stageId: number
  name: string
  status: string
  numTasks: number
  completedTasks: number
  failedTasks: number
}
export interface SparkStagesData {
  activeJobs: Array<{ jobId: number; status: string; stageIds: number[] }>
  stages: SparkStage[]
  numActiveJobs: number
  numActiveStages: number
}
export async function sparkStages(): Promise<SparkStagesData> {
  const res = await fetch('/api/spark/stages')
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
  const body = (await res.json()) as ApiResponse<SparkStagesData>
  if (body.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '获取 Stage 进度失败')
  return body.data as SparkStagesData
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

/** 前端设置 Spark executor 数量(0=动态分配;5/10/15/20=固定常驻,下次查询生效) */
export async function setSparkExecutors(executorInstances: number): Promise<Record<string, unknown>> {
  const res = await fetch('/api/spark/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ executorInstances }),
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
