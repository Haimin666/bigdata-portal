// 库 → 引擎映射共享状态(从 index.js 拆出):
// 由 routes/db.js 的 /api/db/acl 响应刷新,routes/dbquery.js 与权限矩阵校验引擎级规则时读取。
// 拆为独立小模块,避免 db 路由与 dbquery 路由相互 import 造成循环依赖。

let DS_ENGINE_MAP = {}

export function dbEngine(dbName) {
  const t = DS_ENGINE_MAP[String(dbName || '')]
  return typeof t === 'string' ? t.toLowerCase() : ''
}

/** 由 /api/db/acl 的数据源列表刷新映射 */
export function refreshEngineMap(datasources) {
  DS_ENGINE_MAP = {}
  for (const d of Array.isArray(datasources) ? datasources : []) {
    if (d && typeof d.name === 'string' && d.type) DS_ENGINE_MAP[d.name] = String(d.type).toLowerCase()
  }
}