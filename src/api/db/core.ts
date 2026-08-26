// 数据库查询域 API:公共请求封装与共享类型(自 src/api/db.ts 拆出)
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

/** /api/db 前缀请求(表目录/schema/explain/透传元数据) */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
