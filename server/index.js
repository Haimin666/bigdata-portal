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

// 自动登录端点(凭证:请求体 > 环境变量)
// transport: 'json' 请求体 JSON | 'form' 请求体表单 | 'query' 凭证放 URL query
// passwordEncode: 'base64' 密码先 base64 编码再发送(OMD)
function createLoginEndpoint({
  target,
  loginPath,
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
    const user = bodyUser || process.env[envUserKey]
    const rawPassword = bodyPass || process.env[envPassKey]
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
    dbProxy(req, res, next)
  })
} else {
  app.use('/api/db', (req, res) =>
    res.status(503).json({ code: 503, msg: 'db-proxy not configured (DB_PROXY_URL empty)' })
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

const server = app.listen(config.port, () => {
  console.log(`[bigdata-portal] gateway listening on http://localhost:${config.port}`)
  console.log(`  RM:      ${config.resourceManagers.join(', ')}`)
  console.log(`  HDFS:    ${config.hdfsUrl}`)
  console.log(`  DS Web:  ${config.dsWebUrl}`)
  console.log(`  OMD:     ${config.omdUrl}`)
  console.log(`  Stingray:${config.stingrayUrl}`)
})

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/__/stingray')) {
    wsProxy.ws(req, socket, head)
  }
})
