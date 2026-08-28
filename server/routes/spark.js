// Spark SQL 执行路由(从 index.js 拆出):
// 不代理整个 Livy,只暴露查询入口,避免前端直接操作 session。
// 安全:spark.sql() 无只读限制,写语句(INSERT/CREATE/DROP/ALTER/TRUNCATE 等)
// 必须携带 POST /api/spark/auth 签发的 X-Spark-Token(密码解锁,类似 Jupyter 登录),
// 未配置 SPARK_WRITE_PASSWORD 时写操作一律禁止(默认只读)。
// 暴力破解防护、token 签发/校验/清理(12h TTL、绑定签发用户)均在本模块内。
import { randomBytes, timingSafeEqual } from 'node:crypto'
import config from '../config.js'
import { isSparkWriteSql } from '../utils/sql-write-detect.js'
import { checkSparkAccess } from '../db-permissions.js'
import {
  query as sparkQuery, readLogs as sparkReadLogs, status as sparkStatus,
  stagesStatus as sparkStages, cancel as sparkCancel, submitJob as sparkSubmitJob,
  jobStatus as sparkJobStatus, cancelJob as sparkCancelJob, setExecutors as sparkSetExecutors,
  schemaDatabases as sparkSchemaDatabases, schemaTables as sparkSchemaTables, schemaFields as sparkSchemaFields
} from '../spark-gateway.js'

const SPARK_WRITE_TOKEN_TTL = 12 * 60 * 60 * 1000 // 12h
// token -> { username, expiresAt }:绑定签发用户,防跨用户复用(XSS 窃取的 token 仅本人会话可用)
const sparkTokens = new Map()

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

export function setupSpark(app) {
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

    // ── Spark 元数据(表结构树/补全;只读 SHOW/DESC,db-proxy 侧 TTL 缓存)──
    const sparkSchemaHandler =
      (fn) =>
      async (req, res) => {
        try {
          const data = await fn(req)
          res.json({ code: 0, data })
        } catch (e) {
          if (e?.statusCode === 503) {
            return res.status(503).json({ code: 503, msg: e.message })
          }
          const msg = e instanceof Error ? e.message : String(e)
          console.error('[spark/schema]', msg)
          res.status(502).json({ code: 502, msg: `spark 元数据获取失败: ${msg.slice(0, 300)}` })
        }
      }
    app.get('/api/spark/schema/databases', sparkSchemaHandler(() => sparkSchemaDatabases()))
    app.get('/api/spark/schema/tables', sparkSchemaHandler((req) => sparkSchemaTables(String(req.query.db || ''))))
    app.get('/api/spark/schema/fields', sparkSchemaHandler((req) => sparkSchemaFields(String(req.query.db || ''), String(req.query.table || ''))))

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
}