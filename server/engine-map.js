// 库 → 引擎映射共享状态(从 index.js 拆出):
// 由 routes/db.js 的 /api/db/acl 响应刷新,routes/dbquery.js 与权限矩阵校验引擎级规则时读取。
// 拆为独立小模块,避免 db 路由与 dbquery 路由相互 import 造成循环依赖。
// 未命中时返回 null(而不是 ''):空串会让权限矩阵的 `!engine` 判断退化成通配,
// 导致「任意引擎规则都命中」;调用方应在 null 时按 fail-closed 处理。
import config from './config.js'

const MAP_TTL_MS = 60 * 1000
const RETRY_AFTER_FAIL_MS = 10 * 1000

let DS_ENGINE_MAP = {}
let loadedAt = 0
let lastAttemptAt = 0
let loading = null

export function dbEngine(dbName) {
  const t = DS_ENGINE_MAP[String(dbName || '')]
  return typeof t === 'string' ? t.toLowerCase() : null
}

/** 由 /api/db/acl(或 /dbs 过滤前的兜底加载)的数据源列表刷新映射 */
export function refreshEngineMap(datasources) {
  DS_ENGINE_MAP = {}
  for (const d of Array.isArray(datasources) ? datasources : []) {
    if (d && typeof d.name === 'string' && d.type) DS_ENGINE_MAP[d.name] = String(d.type).toLowerCase()
  }
  loadedAt = Date.now()
  return DS_ENGINE_MAP
}

/**
 * 首次需要时按需加载库→引擎映射(路由在 dbEngine 为 null 时调用):
 * 复用 db-proxy /acl,60s 缓存;失败 10s 内不重试(避免每个请求都打上游)。
 * 加载失败时返回 false,调用方保持 fail-closed。
 */
export async function ensureEngineMap() {
  if (!config.dbProxyUrl) return false
  const now = Date.now()
  if (Object.keys(DS_ENGINE_MAP).length && now - loadedAt < MAP_TTL_MS) return true
  if (loading) return loading
  if (now - lastAttemptAt < RETRY_AFTER_FAIL_MS) return Object.keys(DS_ENGINE_MAP).length > 0
  const promise = (async () => {
    try {
      const res = await fetch(config.dbProxyUrl + '/acl', {
        headers: { 'X-DB-Token': config.dbProxyToken || '' },
        signal: AbortSignal.timeout(5000)
      })
      if (!res.ok) return false
      const body = await res.json().catch(() => ({}))
      const datasources = Array.isArray(body?.data?.datasources) ? body.data.datasources : []
      if (!datasources.length) return false
      refreshEngineMap(datasources)
      return true
    } catch (e) {
      console.warn('[engine-map] 库→引擎映射加载失败', e instanceof Error ? e.message : e)
      return false
    } finally {
      lastAttemptAt = Date.now()
    }
  })()
  loading = promise
  try {
    return await promise
  } finally {
    if (loading === promise) loading = null
  }
}
