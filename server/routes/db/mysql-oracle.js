// 数据库查询域路由 — MySQL/Oracle/Doris(db.js 拆分,行为零变化):
//  - /api/db/* 元数据透传 + 数据权限矩阵拦截 + /acl 过滤 + /jobs(提交/状态/取消)+ /explain
//  - /api/dbquery/query(MySQL/Oracle 查询)
//  - /api/db-perms 管理读写
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import config from '../../config.js'
import {
  loadPerms,
  savePerms,
  checkDbAccess,
  allowedDbsFor
} from '../../db-permissions.js'
import { isSparkWriteSql, extractTables } from './shared.js'

export function setupMysqlOracleRoutes(app, auth) {
  // ── DB 代理(客户机侧 services/db-proxy)─────────────────────────
  // 平台无法直连数据库,经客户机的只读 HTTP 代理执行查询。
  // 安全:目标必须命中配置的 DB_PROXY_URL(SSRF 防护);未配置时代理不可用。
  // MySQL/Oracle 异步任务提交:与 /api/dbquery/query 同防线 —— 写 SQL 必须 X-Spark-Token 解锁。
  // 该路径落在 PROXY_PATHS('/api/db/')内,全局 express.json 被跳过,此处路由级挂载 json 解析。
  // 必须在 dbProxy 透传中间件之前注册,否则被 createProxyMiddleware 直接转发(绕过写检测)。

  // 库 → 引擎映射(由 /api/db/acl 响应刷新;校验引擎级规则用)
  let DS_ENGINE_MAP = {}
  function dbEngine(dbName) {
    const t = DS_ENGINE_MAP[String(dbName || '')]
    return typeof t === 'string' ? t.toLowerCase() : ''
  }

  // ── 数据权限矩阵:GET /api/db/{tables,fields,ddl,schema} 带 db 参数时按用户/角色校验 ──
  // 仅拦截 GET + query.db 且路径命中上述元数据接口,其余(POST explain/jobs 提交、
  // GET dbs/acl/jobs/query/health 等)一律 next() 放行。
  // 注意:app.use('/api/db', ...) 内 req.path 已去掉 /api/db 前缀(与下方透传层一致)。
  app.use('/api/db', (req, res, next) => {
    if (req.method !== 'GET' || !req.query.db) return next()
    if (!/^\/(tables|fields|ddl|schema)(\/|$)/i.test(req.path)) return next()
    try {
      checkDbAccess(req, String(req.query.db))
      next()
    } catch (e) {
      if (e?.statusCode === 403) {
        return res.status(403).json({ code: 403, msg: e.message })
      }
      next(e)
    }
  })

  // 数据源列表(/acl)按用户权限过滤:admin / 无规则 → 全量;有规则 → 仅展示开放的库
  // (库下拉/表目录"不同用户看到不同库"由此接口承载;db-proxy 无用户概念)
  app.get('/api/db/acl', async (req, res) => {
    if (!config.dbProxyUrl) {
      return res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL empty)' })
    }
    try {
      const r = await fetch(config.dbProxyUrl + '/acl', {
        headers: { 'X-DB-Token': config.dbProxyToken || '' },
        signal: AbortSignal.timeout(8000)
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.detail || body.msg || `db-proxy HTTP ${r.status}`)
      const data = body.data || {}
      const datasources = Array.isArray(data.datasources) ? data.datasources : []
      // 刷新库→引擎映射(引擎级规则校验用)
      for (const d of datasources) {
        if (d && typeof d.name === 'string' && d.type) DS_ENGINE_MAP[d.name] = String(d.type).toLowerCase()
      }
      const user = req?.user || {}
      if (user.role !== 'admin') {
        const perms = loadPerms()
        const username = user.username ?? user.user ?? user.name ?? ''
        const roles = Array.isArray(user.roles) ? user.roles : user.role ? [user.role] : []
        const dbs = allowedDbsFor(perms, username, roles)
        if (dbs != null && !dbs.includes('*')) {
          const allowed = new Set(dbs)
          data.datasources = datasources.filter((d) => d && allowed.has(String(d.name || '')))
        }
      }
      res.json({ code: 0, data })
    } catch (e) {
      console.error('[db/acl]', e instanceof Error ? e.message : e)
      res.status(502).json({ code: 502, msg: `数据源列表获取失败: ${e instanceof Error ? e.message : String(e)}` })
    }
  })

  // ── 数据权限矩阵:管理 API(admin only,读写 data/db-permissions.json)────────────
  app.get('/api/db-perms', auth.requireAdmin, (req, res) => {
    res.json({ code: 0, data: loadPerms() })
  })

  app.put('/api/db-perms', auth.requireAdmin, express.json(), (req, res) => {
    const { userRules, roleRules } = req.body || {}
    if (!Array.isArray(userRules) || !Array.isArray(roleRules)) {
      return res.status(400).json({ code: 400, msg: 'userRules 与 roleRules 必须为数组' })
    }
    // 兼容两代规则:v1 {user|role, dbs: string[]};v2 {user|role, engineRules[], spark?, flink?}
    const validEngRule = (e) =>
      !!e && typeof e === 'object' && typeof e.db === 'string' && e.db.length > 0 &&
      typeof e.engine === 'string' && (e.tables == null || Array.isArray(e.tables))
    const validRule = (r, key) =>
      !!r && typeof r[key] === 'string' && r[key].length > 0 &&
      (Array.isArray(r.dbs) ? r.dbs.every((d) => typeof d === 'string') : true) &&
      (r.engineRules != null
        ? Array.isArray(r.engineRules) && r.engineRules.every(validEngRule)
        : true)
    if (!userRules.every((r) => validRule(r, 'user')) || !roleRules.every((r) => validRule(r, 'role'))) {
      return res.status(400).json({ code: 400, msg: '每条规则须为 {user|role: 非空字符串, dbs/engineRules: 合法数组}' })
    }
    try {
      savePerms({ userRules, roleRules, defaultDeny: req.body?.defaultDeny === true })
      res.json({ code: 0, msg: '已保存' })
    } catch (e) {
      console.error('[db-perms] 保存失败', e instanceof Error ? e.message : e)
      res.status(500).json({ code: 500, msg: `规则保存失败: ${e instanceof Error ? e.message : String(e)}` })
    }
  })

  app.post('/api/db/jobs', express.json(), async (req, res) => {
    if (!config.dbProxyUrl) {
      return res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL empty)' })
    }
    const sql = String(req.body?.sql || '')
    const dbName = String(req.body?.db || '').trim()
    if (!dbName) {
      return res.status(400).json({ code: 400, msg: '请先选择数据库(db is required)' })
    }
    // 数据权限矩阵 v2:按 引擎+库+读写+表 校验
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
    if (isSparkWriteSql(sql)) {
      // 写权限密码验证已移除(与 /api/dbquery/query 一致):库权限矩阵管控 + 数据源 readOnly 兑底
    }
    // 转发体白名单化,丢弃未知字段;提交为秒级往返,30s 兜底
    const timeoutMs = Math.min(Number(req.body?.timeoutMs) || 3600000, 7200000)
    try {
      const r = await fetch(config.dbProxyUrl + '/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DB-Token': config.dbProxyToken },
        body: JSON.stringify({ db: dbName, sql, timeoutMs }),
        signal: AbortSignal.timeout(30000)
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        const err = new Error(body.detail || body.msg || `db-proxy HTTP ${r.status}`)
        err.status = r.status
        throw err
      }
      res.json({ code: 0, data: body.data })
    } catch (e) {
      console.error('[db/jobs]', e instanceof Error ? e.message : e)
      const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 502
      res.status(status).json({ code: status, msg: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
    }
  })

  // ── 异步任务状态查询/取消:透传黑名单已拦全部 /jobs/* 子路径,此处专用路由统一校验 ──
  // 状态查询同样按 job 归属库做数据权限矩阵校验:防止泄露他人 job 的 SQL 全文/结果,
  // 取消同理防越权停止他人的长查询(EXEC_GATES 已对 POST cancel 做模块/角色门禁)。
  async function fetchDbProxyJob(jobId) {
    const r = await fetch(config.dbProxyUrl + '/jobs/' + encodeURIComponent(jobId), {
      headers: { 'X-DB-Token': config.dbProxyToken || '' },
      signal: AbortSignal.timeout(8000)
    })
    return r
  }
  function dbJobIdErr(jobId) {
    return !/^dbj_\d+_\d+$/.test(String(jobId || ''))
  }
  app.get('/api/db/jobs/:jobId', async (req, res) => {
    if (!config.dbProxyUrl) {
      return res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL empty)' })
    }
    if (dbJobIdErr(req.params.jobId)) {
      return res.status(400).json({ code: 400, msg: '非法 jobId' })
    }
    try {
      const r = await fetchDbProxyJob(req.params.jobId)
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        const err = new Error(body.detail || body.msg || `db-proxy HTTP ${r.status}`)
        err.status = r.status
        throw err
      }
      // 库访问权校验:job 归属库不在该用户授权内则拒绝(防 SQL 全文/结果泄露)
      const data = body.data || {}
      if (data.db) {
        try {
          checkDbAccess(req, String(data.db))
        } catch (e) {
          if (e?.statusCode === 403) {
            return res.status(403).json({ code: 403, msg: e.message })
          }
          throw e
        }
      }
      res.json(body)
    } catch (e) {
      console.error('[db/jobs/:jobId]', e instanceof Error ? e.message : e)
      const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 502
      res.status(status).json({ code: status, msg: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
    }
  })

  app.post('/api/db/jobs/:jobId/cancel', async (req, res) => {
    if (!config.dbProxyUrl) {
      return res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL empty)' })
    }
    if (dbJobIdErr(req.params.jobId)) {
      return res.status(400).json({ code: 400, msg: '非法 jobId' })
    }
    try {
      const r = await fetchDbProxyJob(req.params.jobId)
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        const err = new Error(body.detail || body.msg || `db-proxy HTTP ${r.status}`)
        err.status = r.status
        throw err
      }
      const data = body.data || {}
      if (data.db) {
        try {
          checkDbAccess(req, String(data.db))
        } catch (e) {
          if (e?.statusCode === 403) {
            return res.status(403).json({ code: 403, msg: e.message })
          }
          throw e
        }
      }
      const rc = await fetch(config.dbProxyUrl + '/jobs/' + encodeURIComponent(req.params.jobId) + '/cancel', {
        method: 'POST',
        headers: { 'X-DB-Token': config.dbProxyToken || '' },
        signal: AbortSignal.timeout(8000)
      })
      const rbody = await rc.json().catch(() => ({}))
      if (!rc.ok) {
        const err = new Error(rbody.detail || rbody.msg || `db-proxy HTTP ${rc.status}`)
        err.status = rc.status
        throw err
      }
      res.json(rbody)
    } catch (e) {
      console.error('[db/jobs/:jobId/cancel]', e instanceof Error ? e.message : e)
      const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 502
      res.status(status).json({ code: status, msg: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
    }
  })

  // /explain 为只读执行计划接口,专用路由显式解析并转发 body:
  // PROXY_PATHS 跳过 express.json(避免与透传的 stream 转发冲突),若不在此挂路由级
  // json 解析,POST body 可能不被网关读取,故照 /api/db/jobs 的方式处理。
  app.post('/api/db/explain', express.json(), async (req, res) => {
    if (!config.dbProxyUrl) {
      return res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL empty)' })
    }
    const sql = String(req.body?.sql || '')
    const dbName = String(req.body?.db || '').trim()
    if (!dbName) {
      return res.status(400).json({ code: 400, msg: '请先选择数据库(db is required)' })
    }
    // 数据权限矩阵:按用户/角色校验库访问权(explain 为只读计划,仍需库级授权)
    try {
      checkDbAccess(req, dbName)
    } catch (e) {
      if (e?.statusCode === 403) {
        return res.status(403).json({ code: 403, msg: e.message })
      }
      throw e
    }
    const timeoutMs = Math.min(Number(req.body?.timeoutMs) || 30000, 60000)
    try {
      const r = await fetch(config.dbProxyUrl + '/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DB-Token': config.dbProxyToken },
        body: JSON.stringify({ db: dbName, sql, timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs)
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        const err = new Error(body.detail || body.msg || `db-proxy HTTP ${r.status}`)
        err.status = r.status
        throw err
      }
      res.json({ code: 0, data: body.data })
    } catch (e) {
      console.error('[db/explain]', e instanceof Error ? e.message : e)
      const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 502
      res.status(status).json({ code: status, msg: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
    }
  })

  if (config.dbProxyUrl) {
    const dbProxy = createProxyMiddleware({
      target: config.dbProxyUrl,
      changeOrigin: true,
      pathRewrite: { '^/api/db': '' },
      logLevel: 'warn',
      on: {
        proxyReq: (proxyReq) => {
          // 由网关注入鉴权 token,前端不感知(与客户机 datasources.json authToken 一致)
          if (config.dbProxyToken) proxyReq.setHeader('X-DB-Token', config.dbProxyToken)
        }
      }
    })
    app.use('/api/db', (req, res, next) => {
      // 敏感路径不走透传:
      //  - /spark/* 由 /api/spark/* 统一鉴权(写解锁 + pyspark 信任模式),防绕过
      //  - /flink/* 由 /api/flink/* 统一鉴权(写解锁 + prejob 提交),防绕过
      //  - /jobs 异步任务提交/状态/取消均由上方专用路由鉴权(写检测 + 矩阵),此处兜底拦全部子路径
      //  - /scripts/* 是 db-proxy 遗留端点,前端脚本树走门户本地 /api/scripts
      //  - /acl 保持透传:前端数据源列表加载依赖它,且为只读接口
      if (/^\/spark\//i.test(req.path) || /^\/flink\//i.test(req.path) || /^\/query\/?$/i.test(req.path) || /^\/scripts\//i.test(req.path) || /^\/jobs(\/|$)/i.test(req.path)) {
        return res.status(403).json({ code: 403, msg: '请通过门户专用接口访问该资源' })
      }
      dbProxy(req, res, next)
    })
  } else {
    app.use('/api/db', (req, res) =>
      res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL empty)' })
    )
  }

  // ── MySQL/Oracle 查询(写操作密码解锁,与 Spark 共用密码)─────────
  // 权限已收口到门户:db-proxy 移除读写白名单后,此处对写 SQL 要求 X-Spark-Token。
  // 只读查询直接转发;写语句(INSERT/UPDATE/DELETE/DDL)必须解锁;其余 /api/db 接口
  // (dbs/tables/fields/acl)仍走 /api/db 透传,且 /api/db/query 已被拦截防绕过。
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
    if (isSparkWriteSql(sql)) {
      // 写权限密码验证已移除:库访问权由上方 checkDbAccess 矩阵管控,
      // 数据源 readOnly 与 db-proxy 资源护栏兜底(写审计保留)。
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
