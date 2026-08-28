// 子应用 iframe 代理(从 index.js 拆出):
// HDFS(/apps/hdfs + /static + /webhdfs)、DS Web、Jupyter、DolphinScheduler、
// Stingray(HTML 重写 + /stingray-static + /__/stingray API)。
import http from 'node:http'
import { createProxyMiddleware } from 'http-proxy-middleware'
import config from '../config.js'
import { onProxyRes, iframeProxy } from '../utils/proxy-utils.js'

export function setupSubappsProxy(app) {
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
  // 邮件 Web(/apps/mail):经 Windows 节点 portproxy 中转的反代地址(mailProxyUrl),
  // iframeProxy 剥 X-Frame-Options 并改写相对链接,登录态 cookie 种在门户域(避免跨源 iframe 第三方 cookie 被拒)
  if (config.mailProxyUrl) {
    // ── 附件下载接口:绕开 corp 网关对 /apps/mail/*viewfile* 的 502 拦截 ──
    // 原理:浏览器请求同域 /api/mail/download?url=<base64附件地址>,门户在服务端经 Windows
    // 反代拉取附件流再回传(不经 corp 网关的 viewfile 路径);附件地址白名单只放 viewfile。
    app.get('/api/mail/download', async (req, res) => {
      const encoded = String(req.query.url || '')
      let target = ''
      try {
        target = Buffer.from(encoded, 'base64').toString('utf8')
      } catch {
        return res.status(400).json({ code: 400, msg: 'url 参数非法' })
      }
      // 白名单:仅允许邮件站附件下载路径(viewfile),防开放代理
      const up = new URL(target)
      if (!up.pathname.includes('/viewfile/') || !/^https?:$/.test(up.protocol)) {
        return res.status(400).json({ code: 400, msg: '仅允许邮件站附件下载(viewfile)' })
      }
      // 转成 Windows 反代地址(把邮件站 origin 替换为 mailProxyUrl origin,路径不变)
      const winUrl = config.mailProxyUrl + up.pathname + up.search
      try {
        // 转发用户的邮件站 cookie(门户域下存的 tm*/JSESSIONID 等,原样带给 Windows/邮件站)
        const headers = {}
        const cookie = req.headers.cookie
        if (cookie) headers['Cookie'] = cookie
        headers['Referer'] = new URL(config.mailProxyUrl).origin + '/'
        const r = await fetch(winUrl, { headers, redirect: 'follow', signal: AbortSignal.timeout(60000) })
        const buf = Buffer.from(await r.arrayBuffer())
        // 透传 Content-Type;附件下载头(文件名可能已在 query 的 filename 里,由浏览器用 URL 兜底)
        res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream')
        res.setHeader('Content-Length', buf.length)
        // 尽量透传上游 Content-Disposition(附件原名)
        const cd = r.headers.get('content-disposition')
        if (cd) res.setHeader('Content-Disposition', cd)
        res.status(r.status)
        res.end(buf)
      } catch (e) {
        console.error('[mail/download]', e instanceof Error ? e.message : e)
        res.status(502).json({ code: 502, msg: '附件下载失败' })
      }
    })

    app.use(
      '/apps/mail',
      createProxyMiddleware({
        target: config.mailProxyUrl,
        changeOrigin: true,
        on: {
          proxyReq: (proxyReq, req) => {
            // 邮件站防盗链:附件下载(viewfile)校验 Referer 必须为邮件站自身域;
            // 门户代理后 Referer 是 bigdata-portal 域 → 被拒 502。转发前重写为邮件站域。
            if (proxyReq.getHeader('referer')) {
              proxyReq.setHeader('referer', proxyReq.getHeader('referer').replace(/^https?:\/\/[^/]+/i, new URL(config.mailProxyUrl).origin))
            }
          },
          proxyRes: (proxyRes, req, res) => {
            onProxyRes(config.mailProxyUrl, '/apps/mail')(proxyRes, req, res)
            // 附件链接改写:HTML 里的 viewfile 链接 → /api/mail/download?url=<base64 完整附件地址>
            // (绕开 corp 网关对 /apps/mail/*viewfile* 的 502;仅 HTML 响应做,二进制原样透传)
            const ct = proxyRes.headers['content-type'] || ''
            if (ct.includes('text/html') || ct.includes('application/xhtml')) {
              let chunks = []
              proxyRes.on('data', (c) => chunks.push(c))
              proxyRes.on('end', () => {
                let html = Buffer.concat(chunks).toString('utf8')
                html = html.replace(/\/apps\/mail([^"'\s>]*viewfile[^"'\s>]*)/g, (_, p) => {
                  const full = config.mailProxyUrl + p   // p 是 /creditreference/...viewfile?...
                  return `/api/mail/download?url=${Buffer.from(full).toString('base64')}`
                })
                const buf = Buffer.from(html)
                res.statusCode = proxyRes.statusCode
                res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'text/html; charset=utf-8')
                res.setHeader('Content-Length', buf.length)
                res.end(buf)
              })
            } else {
              // 非 HTML(图片/JS/CSS/二进制):原样透传,不劫持
              proxyRes.pipe(res)
            }
          },
        },
        logLevel: 'warn'
      })
    )
  }
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