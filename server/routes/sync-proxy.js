// 数据同步模块(从 index.js 拆出):代理内部 DBA 服务的 db2hive 接口。
// 上游:http://10.25.100.51:8000/api/dba/db2hive?db_name=&table_name=
// 返回 { code, data: { sql_content, json_content } }
// 门户侧鉴权(登录门禁 /api 前缀)后再转发,避免内网 DBA 服务直接暴露。
import config from '../config.js'

const DBA_BASE = config.dbaSyncUrl // 如 http://10.25.100.51:8000

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
  if (!DBA_BASE) return

  // 生成 db2hive 同步代码(SQL + JSON)
  app.post('/api/sync/db2hive', requireApiToken, async (req, res) => {
    const dbName = String(req.body?.db_name || '').trim()
    const tableName = String(req.body?.table_name || '').trim()
    if (!dbName || !tableName) {
      return res.status(400).json({ code: 400, msg: 'db_name 和 table_name 不能为空' })
    }
    try {
      const url = `${DBA_BASE}/api/dba/db2hive?db_name=${encodeURIComponent(dbName)}&table_name=${encodeURIComponent(tableName)}`
      const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30000) })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.detail || body.msg || `DBA 服务 HTTP ${r.status}`)
      // 上游结构 { code, data: { sql_content, json_content } }
      const data = body.data || {}
      res.json({ code: 0, data: { sqlContent: data.sql_content || '', jsonContent: data.json_content || '' } })
    } catch (e) {
      console.error('[sync/db2hive]', e instanceof Error ? e.message : e)
      res.status(502).json({ code: 502, msg: `同步代码生成失败: ${e instanceof Error ? e.message : String(e)}` })
    }
  })
}
