// 数据同步模块:网关认证后转发到 db-proxy 的 SQL/JSON 生成接口。
// 门户 URL 与响应字段保持兼容，底层不再依赖 bigdata-service。
import config from '../config.js'

const DB_PROXY_BASE = config.dbProxyUrl

// API Token 守卫:支持 X-API-Token header 鉴权,绕过 cookie 认证
// 优先级:1. token 匹配直接放行;2. 无 token 时回退到 cookie 认证(auth-gate 处理)
function requireApiToken(req, res, next) {
  // 未配置 token 时,完全走 cookie 认证
  if (!config.syncApiToken) return next()
  // 检查 header token
  const token = req.headers['x-api-token']
  if (token === config.syncApiToken) return next()
  // 没有 token 或 token 不匹配,回退到 cookie 认证(让 auth-gate 处理)
  return next()
}

export function setupSyncProxy(app) {
  // 生成 db2hive 同步代码(SQL + JSON)
  app.post('/api/sync/db2hive', requireApiToken, async (req, res) => {
    const dbName = String(req.body?.db_name || '').trim()
    const tableName = String(req.body?.table_name || '').trim()
    if (!dbName || !tableName) {
      return res.status(400).json({ code: 400, msg: 'db_name 和 table_name 不能为空' })
    }
    if (!DB_PROXY_BASE) {
      return res.status(503).json({ code: 503, msg: 'db-proxy URL 未配置' })
    }
    try {
      const url = new URL('/sync/db2hive', DB_PROXY_BASE.endsWith('/') ? DB_PROXY_BASE : `${DB_PROXY_BASE}/`)
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-DB-Token': config.dbProxyToken || '',
        },
        body: JSON.stringify({ db_name: dbName, table_name: tableName, align_with_hive: true }),
        signal: AbortSignal.timeout(60000),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok || body.code !== 0) {
        const status = r.ok ? 502 : r.status
        const message = body.detail || body.msg || `db-proxy HTTP ${r.status}`
        return res.status(status).json({ code: status, msg: message })
      }
      const data = body.data || {}
      res.json({ code: 0, data: { sqlContent: data.sql_content || '', jsonContent: data.json_content || '' } })
    } catch (e) {
      console.error('[sync/db2hive]', e instanceof Error ? e.message : e)
      res.status(502).json({ code: 502, msg: `同步代码生成失败: ${e instanceof Error ? e.message : String(e)}` })
    }
  })
}
