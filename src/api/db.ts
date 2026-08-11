// 数据库查询 API:经网关 /api/db/* 代理到客户机 db-proxy
// (鉴权 X-DB-Token 由网关注入,前端不感知)

export interface DbDataSource {
  name: string
  /** 显示别名(缺省回退 name) */
  label?: string
  type: 'mysql' | 'oracle' | 'sparksql' | 'pyspark'
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

/** 执行查询 */
export async function queryDb(db: string, sql: string): Promise<DbQueryResult> {
  return request<DbQueryResult>('/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ db, sql })
  })
}

/** Spark SQL/PySpark 查询(经网关 /api/spark/query 走 db-proxy 常驻 SparkSession) */
export async function querySpark(sql: string, writeToken?: string, kind: 'sql' | 'pyspark' = 'sql'): Promise<DbQueryResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (writeToken) headers['X-Spark-Token'] = writeToken
  const res = await fetch('/api/spark/query', {
    method: 'POST',
    headers,
    body: JSON.stringify({ sql, kind })
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
