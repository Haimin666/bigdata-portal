// 我的目录脚本存储(平台本地 data/scripts,经网关 /api/scripts)+ 表目录/Schema/EXPLAIN + 数据权限矩阵
import { request } from './core'
import type { DbDataSource } from './core'

interface ApiResponse<T> {
  code?: number
  data?: T
  detail?: string
  msg?: string
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

/** 表元数据(detail=1,含注释) */
export interface TableMeta {
  name: string
  comment?: string
}

/** 字段完整元数据(detail=1:注释/可空/键) */
export interface TableFieldDetail extends TableField {
  comment?: string
  nullable?: boolean
  key?: string
  default?: unknown
}

/** 建表 DDL(需账号有 SHOW VIEW / EXECUTE_CATALOG_ROLE 权限) */
export interface TableDDL {
  name: string
  ddl: string
}

/** 数据源列表(GET /api/db/acl;按用户权限过滤) */
export async function listDataSources(): Promise<DbDataSource[]> {
  const data = await request<{ datasources?: DbDataSource[] }>('/acl')
  return data.datasources || []
}

/** 表列表;detail=true 时返回 [{name, comment}](含表注释),否则 string[] */
export async function listTables(db: string, detail = false): Promise<string[] | TableMeta[]> {
  const q = `db=${encodeURIComponent(db)}${detail ? '&detail=1' : ''}`
  return request<string[] | TableMeta[]>(`/tables?${q}`)
}

/** 字段列表;detail=true 时返回完整元数据(注释/可空/键),否则 [{name, type}] */
export async function listFields(db: string, table: string, detail = false): Promise<TableField[] | TableFieldDetail[]> {
  const q = `db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}${detail ? '&detail=1' : ''}`
  return request<TableField[] | TableFieldDetail[]>(`/fields?${q}`)
}

/** 生成建表 DDL */
export async function getTableDDL(db: string, table: string): Promise<TableDDL> {
  return request<TableDDL>(`/ddl?db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`)
}

// ── Schema 元数据补全 / EXPLAIN(经网关 /api/db/schema、/api/db/explain)────────

/** 单表元数据(供 SQL 编辑器补全) */
export interface DbSchemaTable {
  name: string
  comment?: string
  columns: Array<{ name: string; type?: string }>
}

/** 数据源全部表+字段(一次性拉取;表数超限时 truncated=true) */
export interface DbSchema {
  tables: DbSchemaTable[]
  truncated?: boolean
  engine?: string
}

/** 拉取数据源 schema(表+字段,供编辑器补全;GET /api/db/schema 经网关透传 db-proxy /schema) */
export async function getSchema(db: string): Promise<DbSchema> {
  return request<DbSchema>(`/schema?db=${encodeURIComponent(db)}`)
}

/** EXPLAIN 树节点(root 展开;MySQL/Oracle 字段略有差异) */
export interface ExplainNode {
  operation?: string
  name?: string
  access_type?: string
  object_name?: string
  rows?: number | string
  filtered?: number | string
  cost?: number | string
  extra?: string
  children?: ExplainNode[]
}

/** EXPLAIN 响应:tree(结构化执行计划树)或 table(普通 EXPLAIN 行) */
export type ExplainResult =
  | { kind: 'tree'; root: ExplainNode | null }
  | { kind: 'table'; columns?: string[]; rows?: unknown[] }

/** 获取执行计划(只读 SQL;POST /api/db/explain,网关有专用路由) */
export async function explainSql(params: { db: string; sql: string }): Promise<ExplainResult> {
  return request<ExplainResult>('/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ db: params.db, sql: params.sql })
  })
}

// ── 数据权限矩阵(admin only;网关 /api/db-perms,契约见 docs/modules/db-permissions.md)──
/** v2 规则:引擎级(库/表/读写) + Spark + Flink(与 server/db-permissions.js 一致) */
export interface DbEngRule {
  engine: string
  db: string
  tables: string[] | null
  read: boolean
  write: boolean
}
export interface DbUserRule {
  user: string
  engineRules?: DbEngRule[]
  spark?: { read: boolean; write: boolean } | null
  flink?: { enabled: boolean } | null
}

export interface DbRoleRule {
  role: string
  engineRules?: DbEngRule[]
  spark?: { read: boolean; write: boolean } | null
  flink?: { enabled: boolean } | null
}

export interface DbPerms {
  userRules: DbUserRule[]
  roleRules: DbRoleRule[]
  /** 默认拒绝:开启后未配置规则的用户/角色无法访问数据库模块(admin 不受限) */
  defaultDeny?: boolean
}

/** /api/db-perms 专用请求(独立于 /api/db 前缀的 request;非 2xx 或业务 code 非 0 抛错) */
async function permsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/db-perms${path}`, init)
  let body: ApiResponse<T> | null = null
  try {
    body = (await res.json()) as ApiResponse<T>
  } catch {
    /* 忽略非 JSON */
  }
  if (!res.ok) {
    throw new Error(body?.detail || body?.msg || `HTTP ${res.status}`)
  }
  if (body && body.code !== undefined && body.code !== 0) {
    throw new Error(body.detail || body.msg || '请求失败')
  }
  return (body?.data ?? {}) as T
}

/** 读取数据权限矩阵规则(GET /api/db-perms) */
export async function getDbPerms(): Promise<DbPerms> {
  const data = await permsRequest<Partial<DbPerms>>('')
  return {
    userRules: Array.isArray(data.userRules) ? data.userRules : [],
    roleRules: Array.isArray(data.roleRules) ? data.roleRules : [],
    defaultDeny: data.defaultDeny === true
  }
}

/** 全量覆盖保存数据权限矩阵规则(PUT /api/db-perms,body { userRules, roleRules, defaultDeny }) */
export async function saveDbPerms(rules: DbPerms): Promise<unknown> {
  return permsRequest<unknown>('', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userRules: rules.userRules, roleRules: rules.roleRules, defaultDeny: rules.defaultDeny === true })
  })
}
