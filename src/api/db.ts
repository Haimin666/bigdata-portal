// 数据库查询 API:经网关 /api/db/* 代理到客户机 db-proxy
// (鉴权 X-DB-Token 由网关注入,前端不感知)

export interface DbDataSource {
  name: string
  type: 'mysql' | 'oracle'
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
