// YARN 三套代理(从 index.js 拆出):
// 1. /hadoopapi:按 X-Resource-Manager 请求头动态转发(白名单防 SSRF)
// 2. /yarniframe:RM 页面 HTML 重写(注入 <base> + 绝对链接改走代理前缀)
// 3. /api/iframe-proxy:白名单主机(如 NM 日志页)动态转发 + HTML/302 重写
import httpProxy from 'http-proxy'
import { createProxyMiddleware } from 'http-proxy-middleware'
import config from '../config.js'
import { rewriteCookie, rewriteLocation, escapeRegExp, dirOf } from '../utils/proxy-utils.js'

function isYarnProxyAllowed(host) {
  return (config.yarnProxyAllowHosts || []).some((s) =>
    s.startsWith('.') ? host.endsWith(s) : host === s
  )
}

export function setupYarnProxy(app) {
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
}