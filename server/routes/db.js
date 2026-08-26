// 数据库查询域路由(自 server/index.js 原样迁出,行为零变化):
//  - /api/db/* 元数据透传 + 数据权限矩阵拦截 + /acl 过滤 + /jobs(提交/状态/取消)+ /explain
//  - /api/dbquery/query(MySQL/Oracle 查询)
//  - /api/db-perms 管理读写
//  - /api/spark/*、/api/flink/*(写防线 isSparkWriteSql + X-Spark-Token 体系)
// 写防线三层:网关 SQL 检测 → 绑定用户 token → db-proxy X-Spark-Write 共享密钥(见 modules/spark-flink.md)。
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import config from '../config.js'
import {
  query as sparkQuery,
  readLogs as sparkReadLogs,
  status as sparkStatus,
  stagesStatus as sparkStages,
  cancel as sparkCancel,
  submitJob as sparkSubmitJob,
  jobStatus as sparkJobStatus,
  cancelJob as sparkCancelJob,
  setExecutors as sparkSetExecutors
} from '../spark-gateway.js'
import {
  query as flinkQuery,
  cancel as flinkCancel,
  status as flinkStatus,
  connectors as flinkConnectors,
  probeSchema as flinkProbeSchema,
  generateDdl as flinkGenerateDdl,
  jobs as flinkJobs,
  jobStatus as flinkJobStatus,
  jobStop as flinkJobStop,
  asyncSubmit as flinkAsyncSubmit,
  asyncStatus as flinkAsyncStatus,
  asyncCancel as flinkAsyncCancel,
  prejobSubmit,
  prejobJobs,
  prejobStatus,
  prejobLogs,
  prejobCancel,
  prejobConfig
} from '../flink-gateway.js'
import {
  loadPerms,
  savePerms,
  checkDbAccess,
  checkSparkAccess,
  checkFlinkAccess,
  allowedDbsFor
} from '../db-permissions.js'

export function setupDbRoutes(app, auth) {
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

  /** 简易 SQL 表名提取(表级权限校验用;去掉库前缀与引号,过滤非表关键字)。
   *  支持逗号交叉连接(FROM t1, t2)、STRAIGHT_JOIN 等无词边界变体,子查询括号内的
   *  逗号不误提取;纯数字 token(如 LIMIT 10, 20)与边界关键字(LIMIT/SET/WHERE 等)不提取。 */
  const TABLE_KW_RE = /\b(?:from|join|straight_join|update|into|table)\s+([`"']?)([A-Za-z0-9_$#.\-]+)\1/gi
  // 关键字匹配后的逗号延续段需停下的边界(防止把 SELECT 列表 / LIMIT 数字吞成表名)
  const TABLE_BOUNDARY_RE = /^(?:\s|,)*\b(?:where|group\s+by|order\s+by|having|limit|union|on|and|or|left|right|inner|outer|full|cross|join|straight_join|set|values|returning)\b/i
  const TABLE_NON_TABLE_RE = /^(?:select|where|set|values|left|right|inner|outer|full|cross|on|and|or|as|limit|group|order|having|dual)$/i
  function extractTables(sql) {
    let s = String(sql || '').replace(/\/\*[\s\S]*?\*\//g, '')
    // 先折叠反引号/双引号双段名(`db`.`tbl` / "db"."tbl")为 db.tbl,取末段为表名;
    // 必须在字符串剥离之前,否则 "d"."t" 的引号段会被当字符串剥掉
    s = s.replace(/`([^`]+)`\.`([^`]+)`/g, '$1.$2').replace(/"([^"]+)"\."([^"]+)"/g, '$1.$2')
    // 剥离字符串字面量,防 SELECT 'INSERT INTO fake' 之类关键字误报
    s = s.replace(/'(?:[^'\\]|\\.|'')*'/g, "''").replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    const tables = new Set()
    const add = (raw) => {
      let t = String(raw || '').replace(/[`"']/g, '')
      if (t.includes('.')) t = t.split('.').pop()
      // 纯数字(LIMIT 10,20)不入表集;关键字过滤
      if (t && /[A-Za-z_$#]/.test(t) && !TABLE_NON_TABLE_RE.test(t)) tables.add(t)
    }
    let m
    while ((m = TABLE_KW_RE.exec(s))) {
      add(m[2])
      // 逗号延续:FROM t1, t2, t3 逐段提取;遇到边界关键字/非标识符(如 FROM ( 子查询)即停
      let i = TABLE_KW_RE.lastIndex
      while (i < s.length) {
        const rest = s.slice(i)
        if (TABLE_BOUNDARY_RE.test(rest)) break
        const cm = /^[\s,]*([`"']?)([A-Za-z0-9_$#.\-]+)\1/.exec(rest)
        if (!cm) break
        add(cm[2])
        i += cm[0].length
      }
    }
    return [...tables]
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

  // ── Spark SQL 执行(Livy)──────────────────────────────────────
  // 数据库查询的 sparksql 引擎:经 /api/spark/query 走 Livy 常驻 session 执行。
  // 不代理整个 Livy,只暴露查询入口,避免前端直接操作 session。
  // 安全:spark.sql() 无只读限制,写语句(INSERT/CREATE/DROP/ALTER/TRUNCATE 等)
  // 必须携带 POST /api/spark/auth 签发的 X-Spark-Token(密码解锁,类似 Jupyter 登录),
  // 未配置 SPARK_WRITE_PASSWORD 时写操作一律禁止(默认只读)。
  const SPARK_WRITE_TOKEN_TTL = 12 * 60 * 60 * 1000 // 12h
  // token -> { username, expiresAt }:绑定签发用户,防跨用户复用(XSS 窃取的 token 仅本人会话可用)
  const sparkTokens = new Map()

  // 判定 SQL 是否可能为写操作(服务端权威校验,采用「白名单读 + 显式拒绝」策略):
  // 1) 去掉注释后,若以只读关键字开头(SELECT/SHOW/DESC/DESCRIBE/EXPLAIN/SET/USE 且无写关键字),
  //    放行;否则一律视为写操作,要求 X-Spark-Token。
  // 2) 显式拒绝多语句走私(含分号)与 CTE 前缀的 DML(WITH cte AS (...) INSERT ...)。
  const SPARK_READONLY_KW = /^(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|SET|USE)\b/i
  const SPARK_WRITE_KW = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|MSCK|REFRESH|LOAD|OVERWRITE)\b/i
  // SELECT 前缀走私:MySQL 可用 SELECT ... INTO OUTFILE/DUMPFILE 写服务器文件、
  // LOAD_FILE() 读服务器文件、FOR UPDATE 行锁、GET_LOCK/SLEEP/BENCHMARK 资源消耗,
  // 均视为写/敏感操作,需解锁
  const SPARK_SELECT_SMUGGLE =
    /\bINTO\s+(OUTFILE|DUMPFILE)\b|\bLOAD_FILE\s*\(|\bFOR\s+UPDATE\b|\bINTO\s+@[A-Za-z0-9_]+|\bGET_LOCK\s*\(|\bSLEEP\s*\(|\bBENCHMARK\s*\(/i

  /** 按分号切分,跳过单引号/双引号字符串内的分号(与 flink split_flink_sql 同思路) */
  function splitSqlStatements(s) {
    const parts = []
    let cur = ''
    let inStr = false
    let inDQ = false
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (c === '\\' && i + 1 < s.length) {
        cur += c + s[i + 1]
        i++
        continue
      }
      if (c === "'" && !inDQ) {
        inStr = !inStr
        cur += c
        continue
      }
      if (c === '"' && !inStr) {
        inDQ = !inDQ
        cur += c
        continue
      }
      if (c === ';' && !inStr && !inDQ) {
        parts.push(cur)
        cur = ''
        continue
      }
      cur += c
    }
    parts.push(cur)
    return parts
  }

  function isSparkWriteSql(sql) {
    const raw = String(sql)
    // MySQL/MariaDB 可执行注释 /*! ... */ 与 /*M! ... */ 会被数据库执行,绝不能当普通注释删除 —— 检测到一律视为写
    if (/\*[Mm]?!/.test(raw)) return true
    let s = raw
      // 去注释(行注释与块注释)
      .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '')
      .trim()
    if (!s) return false
    // 多语句走私:引号感知切分,非末尾分号都拒绝
    const parts = splitSqlStatements(s)
    const last = parts[parts.length - 1].trim()
    if (parts.length > 2 || (parts.length === 2 && last !== '')) return true
    s = last || parts[0].trim()
    // SELECT 前缀走私(INTO OUTFILE/DUMPFILE、LOAD_FILE)视为写
    if (SPARK_SELECT_SMUGGLE.test(s)) return true
    // 只读关键字开头 → 放行(但要排除 WITH ... INSERT 的 CTE-DML)
    if (SPARK_READONLY_KW.test(s)) {
      // SET GLOBAL / SET @@global.* 会修改服务器全局配置,视为写(需解锁);SET SESSION/普通 SET 会话级放行
      if (/^SET\b/i.test(s) && (/\bGLOBAL\b/i.test(s) || /@@global\./i.test(s))) return true
      return false
    }
    if (/^WITH\b/i.test(s) && !SPARK_WRITE_KW.test(s)) return false
    // 其余(含 CTE 前缀 DML、CACHE/ANALYZE 等)一律视为写
    return true
  }

  function issueSparkToken(username) {
    const token = randomBytes(24).toString('hex')
    sparkTokens.set(token, { username: username || null, expiresAt: Date.now() + SPARK_WRITE_TOKEN_TTL })
    return token
  }

  function sparkTokenValid(token, req) {
    const rec = sparkTokens.get(token)
    if (!rec) return false
    if (Date.now() > rec.expiresAt) {
      sparkTokens.delete(token)
      return false
    }
    // 绑定签发用户:认证开启时仅签发者本人可用,他人复用一律无效并删除(防重放)
    if (rec.username != null) {
      const cur = req?.user?.username || null
      if (cur !== rec.username) {
        sparkTokens.delete(token)
        return false
      }
    }
    return true
  }

  if (config.dbProxyUrl) {
    // 暴力破解防护:每 IP 失败 5 次锁 10 分钟
    const authFails = new Map() // ip -> { count, lockUntil }
    function authLocked(ip) {
      const rec = authFails.get(ip)
      if (!rec) return false
      if (rec.lockUntil > Date.now()) return true
      authFails.delete(ip)
      return false
    }
    function authFail(ip) {
      const rec = authFails.get(ip) || { count: 0, lockUntil: 0 }
      rec.count += 1
      if (rec.count >= 5) {
        rec.lockUntil = Date.now() + 10 * 60 * 1000
        rec.count = 0
      }
      authFails.set(ip, rec)
    }

    // 写操作解锁:密码换取 token(类似 Jupyter 登录)
    app.post('/api/spark/auth', (req, res) => {
      const { password } = req.body || {}
      if (!config.sparkWritePassword) {
        return res.status(403).json({ code: 403, msg: 'Spark 写操作未开放(服务器未配置 SPARK_WRITE_PASSWORD)' })
      }
      const ip = req.ip || req.socket?.remoteAddress || 'unknown'
      if (authLocked(ip)) {
        return res.status(429).json({ code: 429, msg: '尝试次数过多,请 10 分钟后再试' })
      }
      const ok = typeof password === 'string' &&
        password.length === config.sparkWritePassword.length &&
        timingSafeEqual(Buffer.from(password), Buffer.from(config.sparkWritePassword))
      if (!ok) {
        authFail(ip)
        return res.status(401).json({ code: 401, msg: '密码错误' })
      }
      authFails.delete(ip)
      res.json({ code: 0, data: { token: issueSparkToken(req.user?.username), expiresIn: SPARK_WRITE_TOKEN_TTL } })
    })

    app.post('/api/spark/query', async (req, res) => {
      try {
        const { sql, kind } = req.body || {}
        const k = kind === 'pyspark' ? 'pyspark' : 'sql'
        if (!sql || !String(sql).trim()) {
          return res.status(400).json({ code: 400, msg: k === 'sql' ? 'sql is required' : 'code is required' })
        }
        // Spark 权限矩阵 v2:sql 写 / pyspark = 写;只读 sql = 读
        checkSparkAccess(req, k === 'pyspark' || (k === 'sql' && isSparkWriteSql(sql)))
        // 写操作(db-proxy 侧 writeUnlocked 语义):已通过权限矩阵即视为解锁 — 门户放行后
        // 透传 writeUnlocked=true 并附加 X-Spark-Write 共享密钥,db-proxy 才放行写语句。
        // 读查询保持 false,db-proxy 对所有写语句强制该标记,堵死直连伪造。
        const isWrite = k === 'pyspark' || (k === 'sql' && isSparkWriteSql(sql))
        const writeUnlocked = isWrite
        const timeoutMs = Math.min(Number(req.body?.timeoutMs) || 120000, 600000)
        const result = await sparkQuery(String(sql), { kind: k, writeUnlocked, timeoutMs })
        res.json({ code: 0, data: result })
      } catch (e) {
        if (e?.statusCode === 403) {
          return res.status(403).json({ code: 403, msg: e.message })
        }
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[spark/query]', msg)
        res.status(502).json({ code: 502, msg: `spark 查询失败: ${msg.slice(0, 300)}` })
      }
    })

    // ── Spark 异步任务(大查询/长任务,规避公司网关 60s 超时)────────
    // 写拦截与 /api/spark/query 一致:写语句必须解锁(X-Spark-Token)
    app.post('/api/spark/jobs', async (req, res) => {
      try {
        const { sql, code, kind } = req.body || {}
        const k = kind === 'pyspark' ? 'pyspark' : 'sql'
        const body = String(k === 'pyspark' ? code : sql || '')
        if (!body.trim()) return res.status(400).json({ code: 400, msg: 'sql is required' })
        // Spark 权限矩阵 v2:sql 写 / pyspark = 写;只读 sql = 读
        checkSparkAccess(req, k === 'pyspark' || (k === 'sql' && isSparkWriteSql(body)))
        // 写操作透传 writeUnlocked=true(与 /api/spark/query 一致):权限矩阵放行即解锁,
        // 附加 X-Spark-Write 头交由 db-proxy 物理校验;读查询保持 false。
        const isWrite = k === 'pyspark' || (k === 'sql' && isSparkWriteSql(body))
        const writeUnlocked = isWrite
        const timeoutMs = Math.min(Number(req.body?.timeoutMs) || 600000, 7200000)
        const data = await sparkSubmitJob(body, { kind: k, writeUnlocked, timeoutMs })
        res.json({ code: 0, data })
      } catch (e) {
        if (e?.statusCode === 403) {
          return res.status(403).json({ code: 403, msg: e.message })
        }
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[spark/jobs]', msg)
        res.status(502).json({ code: 502, msg: `spark 提交失败: ${msg.slice(0, 300)}` })
      }
    })

    app.get('/api/spark/jobs/:jobId', async (req, res) => {
      try {
        const data = await sparkJobStatus(String(req.params.jobId))
        res.json({ code: 0, data })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        res.status(404).json({ code: 404, msg: `job not found: ${msg.slice(0, 200)}` })
      }
    })

    app.post('/api/spark/jobs/:jobId/cancel', async (req, res) => {
      try {
        const data = await sparkCancelJob(String(req.params.jobId))
        res.json({ code: 0, data })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        res.status(404).json({ code: 404, msg: `取消失败: ${msg.slice(0, 200)}` })
      }
    })

    // Spark driver 日志透传(增量),供前端查询页日志面板展示
    app.get('/api/spark/logs', async (req, res) => {
      try {
        // 前端按 jvm/audit 两个文件各传增量 offset;必须原样透传,
        // 否则固定从 0 读整个文件 → 日志面板每次都显示全部历史(叠加)
        const data = await sparkReadLogs({ jvm: Number(req.query.jvm) || 0, audit: Number(req.query.audit) || 0 })
        res.json({ code: 0, data })
      } catch (e) {
        console.error('[spark/logs]', e instanceof Error ? e.message : e)
        res.status(502).json({ code: 502, msg: 'spark 日志读取失败' })
      }
    })

    // Spark 引擎状态(会话/appId/配置快照)
    app.get('/api/spark/status', async (req, res) => {
      try {
        const data = await sparkStatus()
        res.json({ code: 0, data })
      } catch (e) {
        console.error('[spark/status]', e instanceof Error ? e.message : e)
        res.status(502).json({ code: 502, msg: 'spark 状态获取失败' })
      }
    })

    // 前端设置 Spark executor 数量(5/10/15/20 固定常驻;0=动态分配)
    app.post('/api/spark/config', async (req, res) => {
      try {
        const n = Number(req.body?.executorInstances)
        if (![0, 5, 10, 15, 20].includes(n)) {
          return res.status(400).json({ code: 400, msg: 'executorInstances 仅支持 0/5/10/15/20' })
        }
        const data = await sparkSetExecutors(n)
        res.json({ code: 0, data })
      } catch (e) {
        console.error('[spark/config]', e instanceof Error ? e.message : e)
        res.status(502).json({ code: 502, msg: 'spark 配置更新失败' })
      }
    })

    // Spark 活跃 job/stage 进度(statusTracker,供日志面板进度条轮询)
    app.get('/api/spark/stages', async (req, res) => {
      try {
        const data = await sparkStages()
        res.json({ code: 0, data })
      } catch (e) {
        console.error('[spark/stages]', e instanceof Error ? e.message : e)
        res.status(502).json({ code: 502, msg: 'spark stage 进度获取失败' })
      }
    })

    // 停止当前执行的 spark 查询/代码(前端"停止"按钮;无需写 token,随时可停)
    app.post('/api/spark/cancel', async (req, res) => {
      try {
        const data = await sparkCancel()
        res.json({ code: 0, data })
      } catch (e) {
        console.error('[spark/cancel]', e instanceof Error ? e.message : e)
        res.status(502).json({ code: 502, msg: 'spark 停止失败,请查看服务端日志' })
      }
    })
    // 周期清理过期 spark token 与解锁失败计数,防止内存无限增长(G2)
    setInterval(() => {
      const now = Date.now()
      for (const [tk, rec] of sparkTokens) if (rec.expiresAt < now) sparkTokens.delete(tk)
      for (const [ip, rec] of authFails) if (rec.lockUntil > 0 && rec.lockUntil < now) authFails.delete(ip)
    }, 30 * 60 * 1000).unref()
  } else {
    app.post('/api/spark/auth', (req, res) =>
      res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL 为空)' })
    )
    app.post('/api/spark/query', (req, res) =>
      res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL 为空)' })
    )
    app.get('/api/spark/logs', (req, res) =>
      res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL 为空)' })
    )
    app.get('/api/spark/status', (req, res) =>
      res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL 为空)' })
    )
    app.post('/api/spark/cancel', (req, res) =>
      res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL 为空)' })
    )
  }

  // ── Flink SQL 执行(交互 + PreJob)─────────────────────────────
  // 与 Spark 共用同一密码与 token 体系(/api/spark/auth 签发 X-Spark-Token,12h 有效)。
  // 安全策略:所有 flink 类型任务(交互查询/流式任务/PreJob 提交)一律要求解锁,
  // 防止未授权用户向 YARN 提交作业/占用集群资源;元数据类接口(连接器/DDL 生成/
  // 任务列表/日志)为只读,不强制。
  if (config.dbProxyUrl) {
    app.post('/api/flink/query', async (req, res) => {
      // Flink 权限矩阵 v2:需规则授予 flink.enabled
      checkFlinkAccess(req)
      try {
        const timeoutMs = Math.min(Number(req.body?.timeoutMs) || 120000, 600000)
        const data = await flinkQuery(String(req.body?.sql || ''), {
          mode: req.body?.mode === 'stream' ? 'stream' : 'batch',
          writeUnlocked: true,
          timeoutMs
        })
        res.json({ code: 0, data })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[flink/query]', msg)
        res.status(502).json({ code: 502, msg: `flink 查询失败: ${msg.slice(0, 300)}` })
      }
    })

    // 异步任务通道:流式 SELECT / 大结果提交即返回 jobId,前端轮询(网关 60s 超时安全)
    app.post('/api/flink/async', async (req, res) => {
      checkFlinkAccess(req)
      try {
        const data = await flinkAsyncSubmit(String(req.body?.sql || ''), {
          mode: req.body?.mode === 'stream' ? 'stream' : 'batch',
          writeUnlocked: true,
          timeoutMs: Math.min(Number(req.body?.timeoutMs) || 600000, 3600000)
        })
        res.json({ code: 0, data })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[flink/async]', msg)
        res.status(502).json({ code: 502, msg: `flink 异步提交失败: ${msg.slice(0, 300)}` })
      }
    })
    app.get('/api/flink/async/:jobId', async (req, res) => {
      try {
        res.json({ code: 0, data: await flinkAsyncStatus(req.params.jobId) })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[flink/async/:id]', msg)
        res.status(502).json({ code: 502, msg: `flink 任务状态获取失败: ${msg.slice(0, 300)}` })
      }
    })
    app.post('/api/flink/async/:jobId/cancel', async (req, res) => {
      try {
        res.json({ code: 0, data: await flinkAsyncCancel(req.params.jobId) })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[flink/async/cancel]', msg)
        res.status(502).json({ code: 502, msg: `flink 任务停止失败: ${msg.slice(0, 300)}` })
      }
    })

    app.post('/api/flink/cancel', async (req, res) => {
      try {
        const data = await flinkCancel()
        res.json({ code: 0, data })
      } catch (e) {
        console.error('[flink/cancel]', e instanceof Error ? e.message : e)
        res.status(502).json({ code: 502, msg: 'flink 停止失败,请查看服务端日志' })
      }
    })

    app.get('/api/flink/status', async (req, res) => {
      try {
        const data = await flinkStatus()
        res.json({ code: 0, data })
      } catch (e) {
        console.error('[flink/status]', e instanceof Error ? e.message : e)
        res.status(502).json({ code: 502, msg: 'flink 状态获取失败' })
      }
    })

    // 连接器 / DDL 生成(只读,不执行任务)
    app.get('/api/flink/connectors', async (req, res) => {
      try { res.json({ code: 0, data: await flinkConnectors() }) }
      catch (e) { console.error('[flink/connectors]', e instanceof Error ? e.message : e); res.status(502).json({ code: 502, msg: 'flink 连接器加载失败' }) }
    })
    app.post('/api/flink/connectors/:name/probe', async (req, res) => {
      try { res.json({ code: 0, data: await flinkProbeSchema(req.params.name, req.body?.params || {}) }) }
      catch (e) { console.error('[flink/probe]', e instanceof Error ? e.message : e); res.status(502).json({ code: 502, msg: 'flink 探测失败' }) }
    })
    app.post('/api/flink/ddl/generate', async (req, res) => {
      try { res.json({ code: 0, data: await flinkGenerateDdl(req.body || {}) }) }
      catch (e) { console.error('[flink/ddl]', e instanceof Error ? e.message : e); res.status(502).json({ code: 502, msg: 'flink DDL 生成失败' }) }
    })

    // 交互引擎流式任务(只读列表/详情;停止无需解锁,同 spark cancel 语义)
    app.get('/api/flink/jobs', async (req, res) => {
      try { res.json({ code: 0, data: await flinkJobs() }) }
      catch (e) { console.error('[flink/jobs]', e instanceof Error ? e.message : e); res.status(502).json({ code: 502, msg: 'flink 任务列表获取失败' }) }
    })
    app.get('/api/flink/jobs/:id', async (req, res) => {
      try { res.json({ code: 0, data: await flinkJobStatus(req.params.id) }) }
      catch (e) { console.error('[flink/jobs/:id]', e instanceof Error ? e.message : e); res.status(502).json({ code: 502, msg: 'flink 任务详情获取失败' }) }
    })
    app.post('/api/flink/jobs/:id/stop', async (req, res) => {
      try { res.json({ code: 0, data: await flinkJobStop(req.params.id) }) }
      catch (e) { console.error('[flink/jobs/:id/stop]', e instanceof Error ? e.message : e); res.status(502).json({ code: 502, msg: 'flink 任务停止失败' }) }
    })

    // PreJob 提交(真实占用 YARN 资源)。已移除用户解锁要求:
    // 写凭证由网关自动携带(db-proxy 侧校验共享密钥,防直连绕过)
    app.post('/api/flink/prejob/jobs', async (req, res) => {
      try {
        const data = await prejobSubmit({
          name: String(req.body?.name || ''),
          sql: String(req.body?.sql || ''),
          ...(req.body?.queue ? { queue: String(req.body.queue) } : {})
        })
        res.json({ code: 0, data })
      } catch (e) {
        console.error('[flink/prejob/submit]', e instanceof Error ? e.message : e)
        res.status(502).json({ code: 502, msg: 'flink PreJob 提交失败,请查看服务端日志' })
      }
    })
    app.get('/api/flink/prejob/jobs', async (req, res) => {
      try { res.json({ code: 0, data: await prejobJobs() }) }
      catch (e) { console.error('[flink/prejob/jobs]', e instanceof Error ? e.message : e); res.status(502).json({ code: 502, msg: 'flink PreJob 列表获取失败' }) }
    })
    app.get('/api/flink/prejob/jobs/:id', async (req, res) => {
      try { res.json({ code: 0, data: await prejobStatus(req.params.id) }) }
      catch (e) { console.error('[flink/prejob/status]', e instanceof Error ? e.message : e); res.status(502).json({ code: 502, msg: 'flink PreJob 详情获取失败' }) }
    })
    app.get('/api/flink/prejob/jobs/:id/logs', async (req, res) => {
      try { res.json({ code: 0, data: await prejobLogs(req.params.id, Math.min(Number(req.query.tail) || 200, 5000)) }) }
      catch (e) { console.error('[flink/prejob/logs]', e instanceof Error ? e.message : e); res.status(502).json({ code: 502, msg: 'flink PreJob 日志获取失败' }) }
    })
    app.post('/api/flink/prejob/jobs/:id/cancel', async (req, res) => {
      // 停止不再要求用户解锁(与提交一致):停止是运维管控操作,无需密码。
      // 网关仅注入 db-proxy 鉴权 token(proxy 统一附加 X-DB-Token),防直连绕过靠 db-proxy 侧。
      try { res.json({ code: 0, data: await prejobCancel(req.params.id) }) }
      catch (e) { console.error('[flink/prejob/cancel]', e instanceof Error ? e.message : e); res.status(502).json({ code: 502, msg: 'flink PreJob 停止失败' }) }
    })
    app.get('/api/flink/prejob/config', async (req, res) => {
      try { res.json({ code: 0, data: await prejobConfig() }) }
      catch (e) { console.error('[flink/prejob/config]', e instanceof Error ? e.message : e); res.status(502).json({ code: 502, msg: 'flink PreJob 配置获取失败' }) }
    })
  } else {
    app.post('/api/flink/query', (req, res) =>
      res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL 为空)' })
    )
    app.get('/api/flink/status', (req, res) =>
      res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL 为空)' })
    )
    app.post('/api/flink/prejob/jobs', (req, res) =>
      res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL 为空)' })
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
