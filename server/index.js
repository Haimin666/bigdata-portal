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
import {
  query as flinkQuery, cancel as flinkCancel, status as flinkStatus,
  connectors as flinkConnectors, probeSchema as flinkProbeSchema, generateDdl as flinkGenerateDdl,
  jobs as flinkJobs, jobStatus as flinkJobStatus, jobStop as flinkJobStop,
  prejobSubmit, prejobJobs, prejobStatus, prejobLogs, prejobCancel, prejobConfig
} from './flink-gateway.js'
import { randomBytes, timingSafeEqual } from 'node:crypto'

// http-proxy-middleware v3 每个代理实例都会向同一 server 注册 close 监听
// (本网关共 7 个代理实例),Node 24 默认 maxListeners=10 会触发 MaxListenersExceededWarning,这里放宽。
EventEmitter.defaultMaxListeners = 20

const DIST_DIR = path.join(import.meta.dirname, '../dist')
const app = express()

// 反代部署(nginx 等)下取真实客户端 IP(登录/解锁限速按真实 IP 计)。
// 默认 0(不信任,本地直连安全);生产经反代时在 config.local.json 设 "trustProxy": 1。
if (config.trustProxy) app.set('trust proxy', config.trustProxy)

app.use(cookieParser())
app.use(express.static(DIST_DIR))

// 代理路径不解析请求体:express.json() 会消费 stream 导致 http-proxy-middleware
// 转发时 Content-Length 与实际数据不匹配,下游(海豚登录/YARN kill 等)挂起超时。
// 注意:'/api/db/' 带尾斜杠,避免误匹配 /api/dbquery/query(否则 express.json 被跳过,body 丢失)
const PROXY_PATHS = ['/apps', '/dolphinscheduler', '/static', '/webhdfs', '/stingray-static', '/__/', '/hadoopapi', '/api/db/']
app.use((req, res, next) => {
  if (PROXY_PATHS.some((p) => req.path.startsWith(p))) return next()
  express.json()(req, res, next)
})

// ── 认证与用户管理 ─────────────────────────────────────────────
// 自建账号(用户名+密码,scrypt),会话 = HttpOnly cookie + data/sessions.json。
// 阶段一只保护门户壳:门户 API 与子应用代理路径;子应用内部账号体系不打通。
import { setupAuth } from './auth.js'

const auth = setupAuth(app, config)

// 受保护路径:未登录一律 401(除 /api/auth/* 与静态资源/SPA 页面,由前端路由守卫拦截)。
// 未初始化(无任何用户)时,除初始化接口外一律 503,避免门户裸奔。
const PROTECTED_PREFIXES = [
  '/api/db', '/api/dbquery', '/api/spark', '/api/flink', '/api/users', '/api/theme',
  '/api/ds-deps', '/api/scripts', '/api/config', '/api/login',
  '/apps', '/yarniframe', '/hadoopapi', '/api/iframe-proxy', '/__/', '/stingray-static',
  '/webhdfs', '/dolphinscheduler', '/static'
]
app.use((req, res, next) => {
  if (!auth.enabled) return next()
  // Express 4 路由默认大小写不敏感,保护前缀必须统一用小写匹配,否则 /API/... 变体绕过门禁
  const p = req.path.toLowerCase()
  if (!PROTECTED_PREFIXES.some((pre) => p.startsWith(pre))) return next()
  const user = auth.currentUser(req)
  if (!user) {
    if (auth.users.isEmpty()) {
      return res.status(503).json({ code: 503, msg: '系统未初始化,请先创建管理员' })
    }
    return res.status(401).json({ code: 401, msg: '未登录或会话已过期' })
  }
  req.user = user
  next()
})

// ── 执行类操作门禁(角色 + 模块,防 viewer 越权)────────────────
// viewer(只读)一律禁止执行类操作;dev/admin 还需通过模块白名单。
// 模块白名单 null(全部)或包含 gate.module 才放行。
const EXEC_GATES = [
  { re: /^\/api\/spark\//, module: 'dbQuery' }, // SQL/PySpark 执行、解锁、停止
  { re: /^\/api\/flink\//, module: 'dbQuery' }, // Flink 查询/PreJob 提交/停止
  { re: /^\/api\/dbquery\//, module: 'dbQuery' }, // MySQL/Oracle 查询
  { re: /^\/api\/scripts\/(new|rename|delete|move|save)/, module: 'dbQuery' }, // 脚本文件写(前缀匹配,容忍尾斜杠)
  { re: /^\/api\/ds-deps\/(refresh|rerun-instances|rerun-cascade|rerun-from-node)$/, module: 'dsTask' }, // 采集/重跑
  { re: /^\/hadoopapi\//, module: 'yarn', onlyWrite: true } // RM 管理 REST(非 GET)
]
app.use((req, res, next) => {
  if (!auth.enabled) return next()
  // Express 路由大小写不敏感,门禁路径统一小写匹配,防 /API/... 变体绕过
  const p = req.path.toLowerCase()
  const gate = EXEC_GATES.find(
    (g) => g.re.test(p) && (g.onlyWrite ? !['GET', 'HEAD'].includes(req.method) : true)
  )
  if (!gate) return next()
  const user = req.user || auth.currentUser(req)
  if (!user) return res.status(401).json({ code: 401, msg: '未登录或会话已过期' })
  if (user.role === 'viewer') {
    return res.status(403).json({ code: 403, msg: '只读账号无权执行该操作' })
  }
  const mods = auth.users.modulesOf(user)
  if (gate.module && mods && Array.isArray(mods) && !mods.includes(gate.module)) {
    return res.status(403).json({ code: 403, msg: `无 ${gate.module} 模块权限,无法执行该操作` })
  }
  next()
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

// 正则转义(用于把 host 拼进 new RegExp)
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// URL 路径的目录部分(以 / 结尾):/cluster/app/app_1 → /cluster/app/; /proxy/app_1/ → /proxy/app_1/
function dirOf(path) {
  const i = path.lastIndexOf('/')
  if (i <= 0) return '/'
  return path.slice(0, i + 1)
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
    // 上游登录接口挂起兜底:15s 超时销毁,避免连接永久悬挂
    proxyReq.setTimeout(15000, () => proxyReq.destroy(new Error('login upstream timeout')))
    proxyReq.on('error', (e) => {
      if (!res.headersSent) res.status(502).json({ ok: false, msg: String(e) })
      else res.end()
    })
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

// ── YARN iframe 同构代理(/yarniframe/* → RM)────────────────
// 追踪UI / 资源管理器嵌入:iframe src 用 /yarniframe/proxy/{appId}/ 或
// /yarniframe/cluster/app/{appId},后端原样转发到 RM 的 /proxy/、/cluster/ 同路径。
// 页面内绝对根路径链接(href/src="/xxx")统一重写为 /yarniframe/xxx,子页面与
// 静态资源才能跟随(单一 query 代理做不到这一点)。
const yarnRmUrl = config.resourceManagers[0]
const yarnRmProxy = httpProxy.createProxyServer({
  target: yarnRmUrl,
  changeOrigin: true,
  secure: false,
  selfHandleResponse: true // 库不再自动 pipe,全部由下方 proxyRes 手动转发,避免双写
})
yarnRmProxy.on('proxyRes', (proxyRes, req, res) => {
  delete proxyRes.headers['x-frame-options']
  const cookies = proxyRes.headers['set-cookie']
  if (cookies) proxyRes.headers['set-cookie'] = cookies.map(rewriteCookie)
  if (proxyRes.headers.location) {
    proxyRes.headers.location = rewriteLocation(proxyRes.headers.location, yarnRmUrl, '/yarniframe')
  }
  const type = proxyRes.headers['content-type'] || ''
  if (!type.includes('text/html')) {
    // S1:非 HTML 资源也要先写响应头(selfHandleResponse 下库不会自动写),
    // 否则状态码/Content-Type 丢失 → 浏览器严格 MIME 检查拒绝执行 JS/CSS(白屏根因)
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
    return
  }
  // HTML 响应:注入 <base> + 重写链接后交给门户(保持状态码/响应头)
  const chunks = []
  proxyRes.on('data', (c) => chunks.push(c))
  proxyRes.on('end', () => {
    let html = Buffer.concat(chunks).toString('utf8')
    // <base> 注入:让页面内相对路径资源(如 static/yarn.css)解析到门户代理前缀,
    // 与原生页面基于当前目录解析的行为一致(base 只影响相对路径,不影响绝对路径)
    if (!/<base\s/i.test(html)) {
      const base = '/yarniframe' + dirOf(req.url)
      html = html.replace(/<head([^>]*)>/i, (m) => `${m}<base href="${base}">`)
    }
    // 绝对根路径链接 → /yarniframe/xxx
    html = html.replace(
      /(href|src)\s*=\s*(["'])\/(?!\/|yarniframe|api\/iframe-proxy)/g,
      `$1=$2/yarniframe/`
    )
    // 完整 URL(host 命中任一 RM)→ /yarniframe/xxx
    // RM 页面 css 常为 http://RM:8088/static/... 或 //RM:8088/static/...
    const rmHosts = config.resourceManagers
      .map((u) => {
        try {
          return new URL(u).host
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    if (rmHosts.length) {
      const fullUrlRe = new RegExp(
        '(href|src)\\s*=\\s*(["\'])(?:https?:)?\\/\\/(' + rmHosts.map(escapeRegExp).join('|') + ')((?:\\/[^"\']*)?)(["\'])',
        'g'
      )
      html = html.replace(fullUrlRe, (m, attr, q, _host, rest, q2) => `${attr}=${q}/yarniframe${rest || '/'}${q2}`)
      // 指向其他白名单主机(NM hadoop-dn-0x:8042 日志等)的完整 URL → 动态代理。
      // 否则 iframe 内点击 logs 会直连内网被拒(浏览器无法访问集群网段)。
      const otherHostRe = new RegExp(
        '(href|src)\\s*=\\s*(["\'])((?:https?:)?\\/\\/[^/"\']+)((?:\\/[^"\']*)?)(["\'])',
        'g'
      )
      html = html.replace(otherHostRe, (all, attr, q, schemeHost, rest, q2) => {
        try {
          const u = new URL(schemeHost.startsWith('//') ? 'http:' + schemeHost : schemeHost)
          if (rmHosts.includes(u.host)) return all // RM 自身交给 /yarniframe
          if (!isYarnProxyAllowed(u.hostname)) return all
          const full = (schemeHost.startsWith('//') ? 'http:' + schemeHost : schemeHost) + (rest || '')
          return `${attr}=${q}/api/iframe-proxy?url=${encodeURIComponent(full)}${q2}`
        } catch {
          return all
        }
      })
    }
    delete proxyRes.headers['content-length']
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    res.end(html)
  })
})
app.use('/yarniframe', (req, res) => {
  req.url = req.url.replace(/^\/yarniframe/, '')
  yarnRmProxy.web(req, res, {}, (err) => {
    res.status(502).json({ ok: false, msg: String(err) })
  })
})

// ── YARN iframe 动态代理(/api/iframe-proxy?url=...)──────────
// 用于非 RM 主机(如 NodeManager 日志 hadoop-dn-0x:8042):iframe src 指向门户,
// 后端按白名单主机动态转发。HTML 中的绝对根路径链接(/xxx)重写为继续走本代理,
// 使日志页的样式与 error 日志链接可跟随,不再误入门户 SPA。
function isYarnProxyAllowed(host) {
  return (config.yarnProxyAllowHosts || []).some((s) =>
    s.startsWith('.') ? host.endsWith(s) : host === s
  )
}
const yarnDynamicProxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: false,
  selfHandleResponse: true
})
yarnDynamicProxy.on('proxyRes', (proxyRes, req, res) => {
  delete proxyRes.headers['x-frame-options']
  // 302 重定向 → 继续走代理(否则浏览器直连内网失败)。
  // 重写基准 = 本次代理的目标 origin(入口 /api/iframe-proxy 挂到 req._proxyOrigin)。
  // 注意:proxyRes.req 是 http-proxy 的 upstream 请求对象,没有自定义属性,
  // 原始客户端请求是回调第二参数 req。
  const origin = req?._proxyOrigin || ''
  if (proxyRes.headers.location && origin) {
    try {
      const loc = new URL(proxyRes.headers.location, origin)
      proxyRes.headers.location = `/api/iframe-proxy?url=${encodeURIComponent(loc.href)}`
    } catch {
      /* 保持原样 */
    }
  }
  const type = proxyRes.headers['content-type'] || ''
  if (!type.includes('text/html')) {
    // S1:非 HTML 资源也要先写响应头(同 yarnRmProxy)
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
    return
  }
  const chunks = []
  proxyRes.on('data', (c) => chunks.push(c))
  proxyRes.on('end', () => {
    let html = Buffer.concat(chunks).toString('utf8')
    // 绝对根路径链接 → 继续走动态代理: /xxx?y=1 → /api/iframe-proxy?url=<enc(origin)/xxx?y=1>
    // 注意:正则在 \/(?!...) 处已消费前导斜杠,path 不含 /,需补上(否则生成 :8042node 端口非法 → bad url)
    if (origin) {
      html = html.replace(
        /(href|src)\s*=\s*(["'])\/(?!api\/iframe-proxy)((?:[^"'])*)(["'])/g,
        (m, attr, q, path, q2) => `${attr}=${q}/api/iframe-proxy?url=${encodeURIComponent(origin + '/' + path)}${q2}`
      )
      // 完整 URL(含主机)→ 继续走动态代理(NM 日志页 css 常为 http://host:8042/static/... 或 //host/...)
      html = html.replace(
        /(href|src)\s*=\s*(["'])((?:https?:)?\/\/[^\/"']+)((?:\/[^"']*)?)(["'])/g,
        (all, attr, q, schemeHost, rest, q2) => {
          try {
            const u = new URL(schemeHost.startsWith('//') ? 'http:' + schemeHost : schemeHost)
            if (!isYarnProxyAllowed(u.hostname)) return all
          } catch {
            return all
          }
          const full = schemeHost.startsWith('//') ? 'http:' + schemeHost + rest : schemeHost + rest
          return `${attr}=${q}/api/iframe-proxy?url=${encodeURIComponent(full)}${q2}`
        }
      )
    }
    delete proxyRes.headers['content-length']
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    res.end(html)
  })
})
app.get('/api/iframe-proxy', (req, res) => {
  const target = String(req.query.url || '')
  let u
  try {
    u = new URL(target)
  } catch {
    return res.status(400).json({ ok: false, msg: 'bad url' })
  }
  if (!isYarnProxyAllowed(u.hostname)) {
    return res.status(403).json({ ok: false, msg: 'target not allowed' })
  }
  // 把本次目标 origin 挂到请求对象,供 proxyRes 回调作 HTML/302 重写基准(S4)
  req._proxyOrigin = u.origin
  req.url = u.pathname + u.search
  yarnDynamicProxy.web(req, res, { target: u.origin, changeOrigin: true }, (err) => {
    if (!res.headersSent) res.status(502).json({ ok: false, msg: String(err) })
    else res.end()
  })
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
    //  - /flink/* 由 /api/flink/* 统一鉴权(写解锁 + prejob 提交),防绕过
    //  - /scripts/* 是 db-proxy 遗留端点,前端脚本树走门户本地 /api/scripts
    //  - /acl 保持透传:前端数据源列表加载依赖它,且为只读接口
    if (/^\/spark\//i.test(req.path) || /^\/flink\//i.test(req.path) || /^\/query\/?$/i.test(req.path) || /^\/scripts\//i.test(req.path)) {
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
// SELECT 前缀走私:MySQL 可用 SELECT ... INTO OUTFILE/DUMPFILE 写服务器文件,
// LOAD_FILE() 读服务器文件 —— 均视为写/敏感操作,需解锁
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
      // 超时对齐:前端/门户/db-proxy 统一默认 120s,避免 SQL 卡住时无限等待
      const timeoutMs = Math.min(Number(req.body?.timeoutMs) || 120000, 600000)
      const result = await sparkQuery(String(sql), { kind: k, writeUnlocked, timeoutMs })
      res.json({ code: 0, data: result })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[spark/query]', msg)
      res.status(502).json({ code: 502, msg: `spark 查询失败: ${msg.slice(0, 300)}` })
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
  // 周期清理过期 spark token 与解锁失败计数,防止内存无限增长(G2)
  setInterval(() => {
    const now = Date.now()
    for (const [tk, exp] of sparkTokens) if (exp < now) sparkTokens.delete(tk)
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
    const tk = req.get('X-Spark-Token')
    if (!tk || !sparkTokenValid(tk)) {
      return res.status(403).json({ code: 403, msg: 'Flink 任务需要解锁,请先输入密码(与 Spark 同一密码)' })
    }
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

  // PreJob 提交(真实占用 YARN 资源,一律要求解锁)
  app.post('/api/flink/prejob/jobs', async (req, res) => {
    const tk = req.get('X-Spark-Token')
    if (!tk || !sparkTokenValid(tk)) {
      return res.status(403).json({ code: 403, msg: 'Flink PreJob 提交需要解锁,请先输入密码(与 Spark 同一密码)' })
    }
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
    const tk = req.get('X-Spark-Token')
    if (!tk || !sparkTokenValid(tk)) {
      return res.status(403).json({ code: 403, msg: 'Flink PreJob 停止需要解锁,请先输入密码(与 Spark 同一密码)' })
    }
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
  if (isSparkWriteSql(sql)) {
    const tk = req.get('X-Spark-Token')
    if (!tk || !sparkTokenValid(tk)) {
      return res.status(403).json({ code: 403, msg: '写操作需要解锁,请先输入密码(与 Spark 同一密码)' })
    }
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

// S2:目标不可达时必须销毁 socket,否则 unhandled 'error' 会拖垮进程
const wsErr = (err, _req, socket) => {
  console.error('[ws-proxy]', err instanceof Error ? err.message : err)
  if (socket && !socket.destroyed) socket.destroy()
}
wsProxy.on('error', wsErr)
jupyterWsProxy.on('error', wsErr)

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
  } else {
    socket.destroy() // 未匹配的 upgrade 直接关闭,避免悬挂
  }
})
