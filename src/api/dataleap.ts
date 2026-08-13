// DataLeap 实验模块 API(/api/dataleap)

export interface ApiResponse<T> {
  code?: number
  data?: T
  msg?: string
  detail?: string
}

export type DleapNodeType = 'sql' | 'shell' | 'spark'

export interface DleapNode {
  id: string
  name: string
  type: DleapNodeType
  project: string
  deps: string[]
  cron: string
  db: string
  updatedAt: string
}

export interface DleapNodeDetail extends DleapNode {
  content: string
}

export interface DleapGraph {
  nodes: DleapNode[]
  edges: { source: string; target: string }[]
  topoOrder: string[]
  cycles: string[][]
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/dataleap${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
  const body = (await res.json()) as ApiResponse<T>
  if (body.code !== 0) throw new Error(body.msg || body.detail || `HTTP ${res.status}`)
  return body.data as T
}

export function listNodes(): Promise<{ nodes: DleapNode[] }> {
  return req('/nodes')
}

export function getNode(id: string): Promise<{ node: DleapNodeDetail }> {
  return req(`/nodes/${id}`)
}

export function createNode(payload: { name: string; type: DleapNodeType; project?: string; content?: string; cron?: string; db?: string }): Promise<{ node: DleapNode }> {
  return req('/nodes', { method: 'POST', body: JSON.stringify(payload) })
}

export function updateNode(id: string, payload: Partial<Pick<DleapNodeDetail, 'name' | 'type' | 'project' | 'content' | 'cron' | 'db'>>): Promise<{ node: DleapNode }> {
  return req(`/nodes/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
}

export function deleteNode(id: string): Promise<{ deleted: string }> {
  return req(`/nodes/${id}`, { method: 'DELETE' })
}

export function setNodeDeps(id: string, deps: string[]): Promise<{ node: DleapNode }> {
  return req(`/nodes/${id}/deps`, { method: 'PUT', body: JSON.stringify({ deps }) })
}

export function fetchGraph(): Promise<DleapGraph> {
  return req('/graph')
}

export function publishPreview(): Promise<{ message: string; workflow: unknown }> {
  return req('/publish/preview', { method: 'POST' })
}

export interface ShellRunResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  costMs: number
}

export function runShell(id: string): Promise<ShellRunResult> {
  return req('/run/shell', { method: 'POST', body: JSON.stringify({ id }) })
}
