// MySQL/Oracle 同步查询路由(从 index.js 拆出)。
// 写操作密码解锁已移除:写权限由数据权限矩阵(checkDbAccess)管控,
// 数据源 readOnly 与 db-proxy 资源护栏兜底(写审计保留)。
import config from '../config.js'
import { isSparkWriteSql, extractTables } from '../utils/sql-write-detect.js'
import { dbEngine } from '../engine-map.js'
import { checkDbAccess } from '../db-permissions.js'

export function setupDbQuery(app) {
  app.post('/api/dbquery/query', async (req, res) => {
    if (!config.dbProxyUrl) {
      return res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL empty)' })
    }
    const sql = String(req.body?.sql || '')
    const dbName = String(req.body?.db || '').trim()
    if (!dbName) {
      // 空 db 直接清晰报错,避免转发后得到 db-proxy 隐晦的 "database '' not in ALLOWED_DBS"
      return res.status(400).json({ code: 400, msg: '请先选择数据库(db is required)' })
    }
    // 数据权限矩阵 v2:按 引擎+库+读写+表 校验(优先于写解锁,权限优先于操作放行)
    try {
      checkDbAccess(req, dbName, {
        engine: dbEngine(dbName),
        write: isSparkWriteSql(sql),
        tables: extractTables(sql)
      })
    } catch (e) {
      if (e?.statusCode === 403) {
        return res.status(403).json({ code: 403, msg: e.message })
      }
      throw e
    }
    // 超时对齐:统一默认 120s,上限 10 分钟;转发体白名单化,丢弃未知字段(G5)
    const timeoutMs = Math.min(Number(req.body?.timeoutMs) || 120000, 600000)
    try {
      const r = await fetch(config.dbProxyUrl + '/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DB-Token': config.dbProxyToken },
        body: JSON.stringify({ db: dbName, sql, timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs)
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        // 透传 db-proxy 的错误(状态码 + detail + 结构化 errorType/errorCode)
        const err = new Error(body.detail || body.msg || `db-proxy HTTP ${r.status}`)
        err.status = r.status
        err.errorType = body.errorType
        err.errorCode = body.errorCode
        throw err
      }
      res.json({ code: 0, data: body.data })
    } catch (e) {
      console.error('[dbquery/query]', e instanceof Error ? e.message : e)
      const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 502
      res.status(status).json({
        code: status,
        msg: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        ...(e?.errorType ? { errorType: e.errorType } : {}),
        ...(e?.errorCode !== undefined ? { errorCode: e.errorCode } : {})
      })
    }
  })
}