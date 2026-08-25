// 代理体系(自 server/index.js 原样迁出,行为零变化):
//  - iframeProxy 工厂 + onProxyRes 响应重写(cookie/location/去 frame 限制)
//  - YARN 动态代理(/hadoopapi → RM,按 X-Resource-Manager 头路由)
//  - YARN iframe 同构代理(/yarniframe/* → RM[0],HTML <base> 注入 + 链接重写)
//  - YARN iframe 动态代理(/api/iframe-proxy?url=...,host 白名单防 SSRF)
//  - 子应用代理:HDFS(/apps/hdfs、/static、/webhdfs)、DS Web、Jupyter、
//    /dolphinscheduler(token 注入)、Stingray(HTML 重写 + /stingray-static + /__/stingray)
import { createProxyMiddleware } from 'http-proxy-middleware'
import httpProxy from 'http-proxy'
import http from 'node:http'
import config from '../config.js'
import { rewriteCookie, rewriteLocation, escapeRegExp, dirOf } from '../util.js'

export function setupProxy(app) {
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
      // 注意:WebSocket 由 index.js 的 server.on('upgrade') + setupWsProxy 显式处理,
      // 此处不能开 ws:true(否则 http-proxy-middleware 自动订阅 upgrade,
      // 与手动代理形成双监听,转发数据被双写 → Invalid frame header)
      on: { proxyRes: onProxyRes(targetUrl, prefix) },
      logLevel: 'warn'
    })
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
}

// ── WebSocket 代理(由 index.js 在 listen 后接线 upgrade 事件)──
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

/**
 * 接线 server.on('upgrade'):手动解析 portal_session cookie 校验后分发 WS 代理。
 * @param {import('node:http').Server} server Express app.listen 返回的 HTTP server
 * @param {{ enabled: boolean, currentUser: (reqLike: unknown) => unknown }} auth setupAuth 返回的认证上下文
 */
export function setupWsUpgrade(server, auth) {
  server.on('upgrade', (req, socket, head) => {
    // WS 鉴权:upgrade 请求不经过 Express 中间件(PROTECTED_PREFIXES 登录门禁对其失效),
    // 这里手动解析 portal_session cookie 校验;未登录/未初始化一律断开。
    if (auth.enabled) {
      const cookies = {}
      for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=')
        if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim()
      }
      const user = auth.currentUser({ cookies })
      if (!user) {
        socket.destroy()
        return
      }
    }
    if (req.url.startsWith('/__/stingray')) {
      wsProxy.ws(req, socket, head)
    } else if (req.url.startsWith('/apps/jupyter')) {
      jupyterWsProxy.ws(req, socket, head)
    } else {
      socket.destroy() // 未匹配的 upgrade 直接关闭,避免悬挂
    }
  })
}
