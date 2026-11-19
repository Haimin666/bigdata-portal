export type DbConnectionType = 'mysql' | 'oracle' | 'doris'

export interface DbConnection {
  name: string
  label: string
  type: DbConnectionType
  host: string
  port: number
  user: string
  database: string
  serviceName: string
  charset: string
  rowLimit: string
  readOnly: boolean
  hasPassword: boolean
}

/** Credentials are write-only: the API never returns password. */
export interface DbConnectionPayload {
  name: string
  label: string
  type: DbConnectionType
  host: string
  port: number
  user: string
  database: string
  serviceName: string
  charset: string
  rowLimit: string
  readOnly: boolean
  password: string
  expectedRevision?: string
}

export interface DbConnectionList {
  datasources: DbConnection[]
  revision: string
}

export interface DbConnectionTestResult {
  ok: boolean
  elapsedMs: number
  error?: string
}

interface ApiEnvelope<T> {
  code?: number
  data?: T
  msg?: string
  detail?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/db-config${path}`, init)
  let body: ApiEnvelope<T> | null = null
  try {
    body = (await response.json()) as ApiEnvelope<T>
  } catch {
    // Keep the HTTP status as the useful error for non-JSON responses.
  }
  if (!response.ok) throw new Error(body?.detail || body?.msg || `HTTP ${response.status}`)
  if (body?.code !== undefined && body.code !== 0) throw new Error(body.detail || body.msg || '请求失败')
  return body?.data as T
}

function jsonBody(payload: DbConnectionPayload): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }
}

export async function listDbConnections(): Promise<DbConnectionList> {
  const data = await request<DbConnectionList>('/datasources')
  return { datasources: Array.isArray(data?.datasources) ? data.datasources : [], revision: data?.revision || '' }
}

export async function createDbConnection(payload: DbConnectionPayload): Promise<void> {
  await request<unknown>('/datasources', jsonBody(payload))
}

export async function updateDbConnection(name: string, payload: DbConnectionPayload): Promise<void> {
  await request<unknown>(`/datasources/${encodeURIComponent(name)}`, {
    ...jsonBody(payload),
    method: 'PUT'
  })
}

export async function deleteDbConnection(name: string, revision: string): Promise<void> {
  await request<unknown>(`/datasources/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: revision ? { 'If-Match': revision } : undefined
  })
}

export async function testDbConnection(payload: DbConnectionPayload): Promise<DbConnectionTestResult> {
  const data = await request<DbConnectionTestResult>('/test', jsonBody(payload))
  return data
}
