// bigdata-portal 独立网关:静态托管 + 同源代理(子应用) + 自动登录 + 配置下发
import { EventEmitter } from 'node:events'
import express from 'express'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import cookieParser from 'cookie-parser'
import { createProxyMiddleware } from 'http-proxy-middleware'
import httpProxy from 'http-proxy'
import config from './config.js'
import { query as sparkQuery, readLogs as sparkReadLogs, status as sparkStatus, cancel as sparkCancel } from './spark-gateway.js'
import { randomBytes, timingSafeEqual } from 'node:crypto'

// http-proxy-middleware v3 每个代理实例都会向同一 server 注册 close 监听
// (本网关共 7 个代理实例),Node 24 默认 maxListeners=10 会触发 MaxListenersExceededWarning,这里放宽。
EventEmitter.defaultMaxListeners = 20

const DIST_DIR = path.join(import.meta.dirname, '../dist')
const app = express()

app.use(cookieParser())
app.use(express.static(DIST_DIR))

// 代理路径不解析请求体:express.json() 会消费 stream 导致 http-proxy-middleware
// 转发时 Content-Length 与实际数据不匹配,下游(海豚登录/YARN kill 等)挂起超时。
const PROXY_PATHS = ['/apps', '/dolphinscheduler', '/static', '/webhdfs', '/stingray-static', '/__/', '/hadoopapi', '/api/db']
app.use((req, res, next) => {
  if (PROXY_PATHS.some((p) => req.path.startsWith(p))) return next()
  express.json()(req, res, next)
})

// ── 通用工具 ───────────────────────────────────────────────────

// Set-Cookie 重写:同源代理后种到门户域。
// 只去掉 HttpOnly(海豚前端需通过 JS 读取 sessionId 放入请求头)。
// 注意:不要设置 SameSite=None 又去掉 Secure——该组合会被浏览器拒绝整个 cookie,
// 导致自动登录的会话 cookie 永远种不上(白屏根因)。同源 iframe 下保持默认 SameSite 即可。
function rewriteCookie(cookie) {
  return cookie.replace(/;\s*HttpOnly/i, '')
}

// Location 重写:目标源绝对地址 → 门户代理前缀
function rewriteLocation(location, targetUrl, prefix) {
  if (!location) return location
  const targetOrigin = new URL(targetUrl).origin
  if (location.startsWith(targetOrigin)) {
    return prefix + location.slice(targetOrigin.length)
  }
  return location
}

// 代理响应处理:去 frame 限制、cookie/location 重写
function onProxyRes(targetUrl, prefix) {
  return (proxyRes) => {
    delete proxyRes.headers['x-frame-options']
    const cookies = proxyRes.headers['set-cookie']
    if (cookies) proxyRes.headers['set-cookie'] = cookies.map(rewriteCookie)
    if (proxyRes.headers.location) {
      proxyRes.headers.location = rewriteLocation(proxyRes.headers.location, targetUrl, prefix)
    }
  }
}

// 带 cookie 重写的 iframe/子应用代理
function iframeProxy(targetUrl, prefix) {
  return createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,
    // 注意:WebSocket 由底部 server.on('upgrade') + wsProxy 显式处理,
    // 此处不能开 ws:true(否则 http-proxy-middleware 自动订阅 upgrade,
    // 与手动代理形成双监听,转发数据被双写 → Invalid frame header)
    on: { proxyRes: onProxyRes(targetUrl, prefix) },
    logLevel: 'warn'
  })
}

// 自动登录端点(凭证:请求体 > config.accounts 配置)
// transport: 'json' 请求体 JSON | 'form' 请求体表单 | 'query' 凭证放 URL query
// passwordEncode: 'base64' 密码先 base64 编码再发送(OMD)
function createLoginEndpoint({
  target,
  loginPath,
  accountKey,
  envUserKey,
  envPassKey,
  userField = 'username',
  passField = 'password',
  transport = 'json',
  passwordEncode
}) {
  return (req, res) => {
    // 安全:用户名与密码必须成对提供(任一来自请求体则两者都必须来自请求体),
    // 禁止用"请求体用户名 + 环境变量密码"的组合冒用账号。
    const bodyUser = req.body?.user
    const bodyPass = req.body?.password
    if (!!bodyUser !== !!bodyPass) {
      return res.status(400).json({ ok: false, msg: 'user and password must be provided together' })
    }
    const user = bodyUser || (accountKey ? config.accounts[accountKey]?.user : undefined) || process.env[envUserKey]
    const rawPassword = bodyPass || (accountKey ? config.accounts[accountKey]?.pass : undefined) || process.env[envPassKey]
    if (!user || !rawPassword) {
      return res.status(400).json({ ok: false, msg: 'missing credentials' })
    }
    const password = passwordEncode === 'base64' ? Buffer.from(rawPassword, 'utf8').toString('base64') : rawPassword
    let fullPath = target + loginPath
    const headers = {}
    let payload = ''
    if (transport === 'query') {
      const sep = fullPath.includes('?') ? '&' : '?'
      fullPath += `${sep}${userField}=${encodeURIComponent(user)}&${passField}=${encodeURIComponent(password)}`
      // Stingray 登录必须携带该 Content-Type,否则返回"处理失败"
      headers['Content-Type'] = 'application/json;charset=UTF-8'
      headers['Content-Length'] = 0
    } else if (transport === 'form') {
      payload = new URLSearchParams({ [userField]: user, [passField]: password }).toString()
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      headers['Content-Length'] = Buffer.byteLength(payload)
    } else {
      payload = JSON.stringify({ [userField]: user, [passField]: password })
      headers['Content-Type'] = 'application/json;charset=UTF-8'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const mod = target.startsWith('https://') ? https : http
    const proxyReq = mod.request(
      fullPath,
      {
        method: 'POST',
        rejectUnauthorized: false,
        headers
      },
      (resp) => {
        const chunks = []
        resp.on('data', (c) => chunks.push(c))
        resp.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          const cookies = resp.headers['set-cookie'] || []
          // 海豚登录 Set-Cookie 无 Path 属性,浏览器会按请求路径 /api/login/ 收窄生效范围,
          // 导致 /dolphinscheduler/* 请求不带会话 cookie(401)。统一补 Path=/ 全路径生效。
          const setCookies = () =>
            res.setHeader(
              'Set-Cookie',
              cookies.map((c) => {
                const rewritten = rewriteCookie(c)
                return rewritten.includes('Path=') ? rewritten : `${rewritten}; Path=/`
              })
            )
          // 成功判定:有 cookie 且 2xx,或 JSON 返回 ok/code 0
          if (cookies.length && resp.statusCode < 400) {
            setCookies()
            return res.json({ ok: true })
          }
          try {
            const data = JSON.parse(raw)
            // 成功:result_code 00000 / code 0 / success / OMD 返回 accessToken
            if (data.result_code === '00000' || data.code === 0 || data.success || data.accessToken) {
              if (cookies.length) setCookies()
              res.json({ ok: true })
            } else {
              res.json({ ok: false, msg: data.result_msg || data.msg || data.message || 'login failed' })
            }
          } catch {
            res.json({ ok: false, msg: 'login response parse error' })
          }
        })
      }
    )
    proxyReq.on('error', (e) => res.status(502).json({ ok: false, msg: String(e) }))
    proxyReq.write(payload)
    proxyReq.end()
  }
}

// ── YARN:动态代理(按 X-Resource-Manager 请求头) ───────────────
// 安全:目标必须命中配置的 RM 白名单,防止被当作任意内网代理(SSRF)。
const hadoopProxy = createProxyMiddleware({
  router: (req) => req.get('X-Resource-Manager'),
  changeOrigin: true,
  pathRewrite: { '^/hadoopapi': '' },
  logLevel: 'warn'
})
app.use('/hadoopapi', (req, res, next) => {
  const rm = req.get('X-Resource-Manager')
  if (!rm) return res.status(400).end('missing X-Resource-Manager header')
  if (!config.resourceManagers.some((allowed) => rm === allowed || rm.startsWith(`${allowed}/`))) {
    return res.status(403).end('X-Resource-Manager not in whitelist')
  }
  hadoopProxy(req, res, next)
})

// ── HDFS 子应用(/apps/hdfs + 绝对路径 /static + WebHDFS API) ─
app.use(
  '/apps/hdfs',
  createProxyMiddleware({
    target: config.hdfsUrl,
    changeOrigin: true,
    pathRewrite: { '^/apps/hdfs': '' },
    on: { proxyRes: onProxyRes(config.hdfsUrl, '/apps/hdfs') },
    logLevel: 'warn'
  })
)
app.use(
  '/static',
  createProxyMiddleware({
    target: config.hdfsUrl,
    changeOrigin: true,
    on: { proxyRes: onProxyRes(config.hdfsUrl, '/static') },
    logLevel: 'warn'
  })
)
app.use(
  '/webhdfs',
  createProxyMiddleware({
    target: config.hdfsUrl,
    changeOrigin: true,
    // express 挂载中间件会剥掉 /webhdfs 前缀,需加回(WebHDFS API 路径必须为 /webhdfs/v1/...)
    pathRewrite: { '^/': '/webhdfs/' },
    on: { proxyRes: onProxyRes(config.hdfsUrl, '/webhdfs') },
    logLevel: 'warn'
  })
)

// ── DS Web 子应用 ──────────────────────────────────────────────
app.use('/apps/dsweb', iframeProxy(config.dsWebUrl, '/apps/dsweb'))
// ── JupyterLab 子应用 ──────────────────────────────────────────
// jupyter 容器 host 网络监听宿主机 8888,start.sh 注入 --ServerApp.base_url=/apps/jupyter,
// 因此其页面/API/ws 路径自带 /apps/jupyter 前缀;express 挂载会剥掉前缀,
// 必须用 pathRewrite 加回后原样转发,否则 jupyter 收到 /lab 返回 404。
// 认证沿用 jupyter 自身密码,首次打开手动登录一次,cookie 经 onProxyRes 重写后种在门户域。
app.use(
  '/apps/jupyter',
  createProxyMiddleware({
    target: config.jupyterUrl,
    changeOrigin: true,
    // express 挂载剥掉 /apps/jupyter 前缀,加回后原样转发(base_url 必须保留)
    pathRewrite: { '^/': '/apps/jupyter/' },
    on: { proxyRes: onProxyRes(config.jupyterUrl, '/apps/jupyter') },
    logLevel: 'warn'
  })
)
// 海豚 UI 的 HTML 内资源与运行时 API 均为绝对路径 /dolphinscheduler/...(见 ui/index.html),
// 门户域需提供同路径代理,否则子应用资源会命中 SPA fallback 导致白屏。
// 配置了 DS_TOKEN 时向所有请求注入 token header(海豚 API token 认证优先于 cookie,
// 项目列表即 token 用户可见;海豚 UI 免登录同样依赖它)。
app.use(
  '/dolphinscheduler',
  createProxyMiddleware({
    target: new URL(config.dsWebUrl).origin,
    changeOrigin: true,
    // express 挂载剥掉 /dolphinscheduler 前缀,加回后转发到海豚(dsWebUrl 自带该前缀)
    pathRewrite: { '^/': '/dolphinscheduler/' },
    on: {
      proxyRes: onProxyRes(config.dsWebUrl, '/dolphinscheduler'),
      proxyReq: (proxyReq) => {
        if (config.dsToken) proxyReq.setHeader('token', config.dsToken)
      }
    },
    logLevel: 'warn'
  })
)
app.post(
  '/api/login/ds',
  createLoginEndpoint({
    target: config.dsWebUrl,
    // dsWebUrl 已含 /dolphinscheduler 前缀,此处只补 /login(createLoginEndpoint 拼接 target + loginPath)
    loginPath: '/login',
    // 海豚登录为表单格式:userName / userPassword
    transport: 'form',
    userField: 'userName',
    passField: 'userPassword',
    accountKey: 'dsWeb',
    envUserKey: 'DSWEB_USER',
    envPassKey: 'DSWEB_PASS'
  })
)

// ── OMD 自动登录(跨源 iframe 当前不使用,保留供未来同源接入) ─────
app.post(
  '/api/login/omd',
  createLoginEndpoint({
    target: config.omdUrl,
    // OpenMetadata 登录:POST /api/v1/users/login,body {email, password: base64(密码)}
    loginPath: '/api/v1/users/login',
    userField: 'email',
    passField: 'password',
    passwordEncode: 'base64',
    accountKey: 'omd',
    envUserKey: 'OMD_USER',
    envPassKey: 'OMD_PASS'
  })
)

// ── Stingray 子应用(HTML 重写 + 独立静态前缀) ──────────────────
// SPA 入口:任意 /apps/stingray/* 都返回根 HTML,并重写 /static/ → /stingray-static/static/
app.use('/apps/stingray', (req, res) => {
  if (req.method !== 'GET') return res.status(405).end()
  const headers = { ...req.headers }
  delete headers.host
  const proxyReq = http.request(
    config.stingrayUrl + '/',
    { method: 'GET', headers, rejectUnauthorized: false },
    (proxyRes) => {
      const respHeaders = { ...proxyRes.headers }
      delete respHeaders['x-frame-options']
      // 必须禁用缓存:HTML 内含路由注入脚本,被浏览器缓存旧版会导致 React 路由
      // 不匹配 → 显示 404 → 点"返回首页"跳到门户首页
      respHeaders['cache-control'] = 'no-store'
      const ct = respHeaders['content-type'] || ''
      if (!ct.includes('text/html')) {
        res.writeHead(proxyRes.statusCode || 200, respHeaders)
        return proxyRes.pipe(res)
      }
      const chunks = []
      proxyRes.on('data', (c) => chunks.push(c))
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8')
        body = body.replace(/(["'(])\/static\//g, '$1/stingray-static/static/')
        body = body.replace(/([a-zA-Z_$]\.[a-zA-Z_$])=(["'])\/(["'])/g, '$1=$2/stingray-static/$3')
        // favicon:iframe 内 /favicon.ico 会打到门户 404,改写走 stingray 自身资源
        body = body.replace(/(href=)["']\/favicon\.ico["']/g, '$1"/stingray-static/favicon.ico"')
        // Stingray 的 React Router basename="/",代理前缀 /apps/stingray 会导致路由不匹配
        // (catch-all 404 → 白屏)。在 React 加载前把 pathname 去掉前缀,匹配 /login、/home 等路由。
        const routerInject =
          '<script>!function(){var p=location.pathname;if(p.indexOf("/apps/stingray")===0){var t=p.slice("/apps/stingray".length)||"/";history.replaceState(history.state,"",t)}}()<\/script>'
        body = body.replace('<head>', '<head>' + routerInject)
        respHeaders['content-length'] = Buffer.byteLength(body)
        res.writeHead(proxyRes.statusCode || 200, respHeaders)
        res.end(body)
      })
    }
  )
  proxyReq.on('error', (e) => {
    console.error('[stingray] html proxy error:', e.message)
    res.status(502).end('stingray proxy error')
  })
  proxyReq.end()
})

// Stingray 静态资源(避开与 HDFS 的 /static 冲突)
app.use(
  '/stingray-static',
  createProxyMiddleware({
    target: config.stingrayUrl,
    changeOrigin: true,
    pathRewrite: { '^/stingray-static': '/static' },
    on: { proxyRes: onProxyRes(config.stingrayUrl, '/stingray-static') },
    logLevel: 'warn'
  })
)

// Stingray API(cookie 代理)
app.use('/__/stingray', iframeProxy(config.stingrayUrl + '/__/stingray', '/__/stingray'))

// ── 门户配置(前端可读):模块显隐等───────────────────────────────
// 仅暴露白名单配置(模块列表),不泄露账号密码等敏感字段。
app.get('/api/config/modules', (req, res) => {
  res.json({
    code: 0,
    data: {
      // 空数组 = 全部展示;非空 = 仅展示名单内模块(菜单 name)
      enabledModules: config.enabledModules
    }
  })
})

// ── DB 代理(客户机侧 services/db-proxy)─────────────────────────
// 平台无法直连数据库,经客户机的只读 HTTP 代理执行查询。
// 安全:目标必须命中配置的 DB_PROXY_URL(SSRF 防护);未配置时代理不可用。
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
    //  - /scripts/* 是 db-proxy 遗留端点,前端脚本树走门户本地 /api/scripts
    //  - /acl 保持透传:前端数据源列表加载依赖它,且为只读接口
    if (/^\/spark\//.test(req.path) || req.path.startsWith('/scripts')) {
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
const sparkTokens = new Map() // token -> expiresAt

// 判定 SQL 是否可能为写操作(服务端权威校验,采用「白名单读 + 显式拒绝」策略):
// 1) 去掉注释后,若以只读关键字开头(SELECT/SHOW/DESC/DESCRIBE/EXPLAIN/SET/USE/WITH 且无写关键字),
//    放行;否则一律视为写操作,要求 X-Spark-Token。
// 2) 显式拒绝多语句走私(含分号)与 CTE 前缀的 DML(WITH cte AS (...) INSERT ...)。
const SPARK_READONLY_KW = /^(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|SET|USE)\b/i
const SPARK_WRITE_KW = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|MSCK|REFRESH|LOAD|OVERWRITE)\b/i
function isSparkWriteSql(sql) {
  let s = String(sql)
    // 去注释(行注释与块注释)
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '')
    .trim()
  if (!s) return false
  // 多语句走私:任何非末尾分号都拒绝(末尾分号允许)
  const semi = s.split(';')
  if (semi.length > 2 || (semi.length === 2 && semi[1].trim() !== '')) return true
  if (semi.length === 2) s = semi[0].trim()
  // 只读关键字开头 → 放行(但要排除 WITH ... INSERT 的 CTE-DML)
  if (SPARK_READONLY_KW.test(s)) return false
  if (/^WITH\b/i.test(s) && !SPARK_WRITE_KW.test(s)) return false
  // 其余(含 CTE 前缀 DML、CACHE/ANALYZE 等)一律视为写
  return true
}

function issueSparkToken() {
  const token = randomBytes(24).toString('hex')
  sparkTokens.set(token, Date.now() + SPARK_WRITE_TOKEN_TTL)
  return token
}

function sparkTokenValid(token) {
  const exp = sparkTokens.get(token)
  if (!exp) return false
  if (Date.now() > exp) {
    sparkTokens.delete(token)
    return false
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
    res.json({ code: 0, data: { token: issueSparkToken(), expiresIn: SPARK_WRITE_TOKEN_TTL } })
  })

  app.post('/api/spark/query', async (req, res) => {
    try {
      const { sql, kind } = req.body || {}
      const k = kind === 'pyspark' ? 'pyspark' : 'sql'
      if (!sql || !String(sql).trim()) {
        return res.status(400).json({ code: 400, msg: k === 'sql' ? 'sql is required' : 'code is required' })
      }
      // 写语句必须解锁(SQL 引擎);pyspark 为任意 Python 执行,同样必须解锁(信任模式)
      let writeUnlocked = false
      if (k === 'sql' && isSparkWriteSql(sql)) {
        const tk = req.get('X-Spark-Token')
        if (!tk || !sparkTokenValid(tk)) {
          return res.status(403).json({ code: 403, msg: '写操作需要解锁,请先输入 Spark 写权限密码' })
        }
        writeUnlocked = true
      }
      if (k === 'pyspark') {
        const tk = req.get('X-Spark-Token')
        if (!tk || !sparkTokenValid(tk)) {
          return res.status(403).json({ code: 403, msg: 'PySpark 为任意代码执行,请先解锁 Spark 写权限' })
        }
        writeUnlocked = true
      }
      const result = await sparkQuery(String(sql), { kind: k, writeUnlocked })
      res.json({ code: 0, data: result })
    } catch (e) {
      console.error('[spark/query]', e instanceof Error ? e.message : e)
      res.status(502).json({ code: 502, msg: 'spark 查询失败,请查看服务端日志' })
    }
  })

  // Spark driver 日志透传(增量),供前端查询页日志面板展示
  app.get('/api/spark/logs', async (req, res) => {
    try {
      const offset = Number(req.query.offset) || 0
      const data = await sparkReadLogs(offset)
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

app.post(
  '/api/login/stingray',
  createLoginEndpoint({
    target: config.stingrayUrl,
    loginPath: '/__/stingray/authc/login',
    // Stingray 前端以 URL query 传凭证(axios params,body 为空)
    transport: 'query',
    userField: 'username',
    passField: 'password',
    accountKey: 'stingray',
    envUserKey: 'STINGRAY_USER',
    envPassKey: 'STINGRAY_PASS'
  })
)

// ── 配置下发 ───────────────────────────────────────────────────
app.get('/api/config', (req, res) =>
  res.json({
    resourceManagers: config.resourceManagers,
    hdfsUrl: config.hdfsUrl,
    dsWebUrl: config.dsWebUrl,
    omdUrl: config.omdUrl,
    stingrayUrl: config.stingrayUrl
  })
)

// ── 工作流依赖采集与级联重跑(/api/ds-deps)───────────────────
import { initDsDeps, dsDepsRouter } from './ds-deps.js'
import { dbScriptsRouter } from './db-scripts.js'
initDsDeps() // 启动加载缓存 + 初始化采集 + 定时刷新
app.use('/api/ds-deps', dsDepsRouter())
app.use('/api/scripts', dbScriptsRouter())

// ── SPA fallback(仅非 API 的 GET 路由) ────────────────────────
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(DIST_DIR, 'index.html'))
})

// ── WebSocket 代理 ─────────────────────────────────────────────
// Stingray SQL 查询结果经 ws://…/__/stingray/log/* 实时推送。
// http-proxy-middleware 的 upgrade 订阅依赖 HTTP 请求触发(且 express 剥前缀后
// pathFilter 不匹配,订阅时机易错过),这里用底层 http-proxy 显式处理 upgrade。
const wsProxy = httpProxy.createProxyServer({
  target: config.stingrayUrl,
  ws: true,
  changeOrigin: true
})

// JupyterLab kernel 通信/终端走 ws,路径自带 /apps/jupyter 前缀(base_url),
// 原样转发给宿主机 jupyter 即可。
const jupyterWsProxy = httpProxy.createProxyServer({
  target: config.jupyterUrl,
  ws: true,
  changeOrigin: true
})

const server = app.listen(config.port, () => {
  console.log(`[bigdata-portal] gateway listening on http://localhost:${config.port}`)
  console.log(`  RM:      ${config.resourceManagers.join(', ')}`)
  console.log(`  HDFS:    ${config.hdfsUrl}`)
  console.log(`  DS Web:  ${config.dsWebUrl}`)
  console.log(`  OMD:     ${config.omdUrl}`)
  console.log(`  Stingray:${config.stingrayUrl}`)
  console.log(`  Jupyter: ${config.jupyterUrl}`)
})

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/__/stingray')) {
    wsProxy.ws(req, socket, head)
  } else if (req.url.startsWith('/apps/jupyter')) {
    jupyterWsProxy.ws(req, socket, head)
  }
})
