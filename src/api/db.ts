// 数据库查询 API:经网关 /api/db/* 代理到客户机 db-proxy
// (鉴权 X-DB-Token 由网关注入,前端不感知)

export interface DbDataSource {
  name: string
  /** 显示别名(缺省回退 name) */
  label?: string
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
