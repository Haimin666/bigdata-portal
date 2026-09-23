// 开发助手路由(从 index.js 拆出):
// /api/assistant/* 项目路由(元数据 + workspace 目录操作)在前,8787 代理在后,
// 代理按前缀精确转发剩余路径;项目路由必须先挂载,否则会被代理吞掉。
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import config from '../config.js'
import { createAssistantProjectsRoutes } from '../assistant-projects.js'
import { datadeckPath, isDatadeckIframeRequest } from '../utils/datadeck-proxy.js'

function mobileAssistantTarget(path, method) {
  const queryIndex = path.indexOf('?')
  const pathname = queryIndex < 0 ? path : path.slice(0, queryIndex)
  const query = queryIndex < 0 ? '' : path.slice(queryIndex)
  const thread = /^\/threads\/([a-zA-Z0-9_-]{1,128})\/(history|active-run)$/.exec(pathname)
  const run = /^\/runs\/([a-zA-Z0-9_-]{1,128})(?:\/(events|cancel))?$/.exec(pathname)

  if (method === 'GET' && pathname === '/auth/goai') return '/api/auth/goai?user_id=1030437'
  if (method === 'GET' && pathname === '/agent/default') return `/api/agent/default${query}`
  if (method === 'GET' && pathname === '/threads') return `/api/chat/threads${query}`
  if (method === 'POST' && pathname === '/threads') return '/api/chat/thread'
  if (thread && method === 'GET') return `/api/chat/thread/${thread[1]}/${thread[2]}${query}`
  if (method === 'POST' && pathname === '/runs') return '/api/agent/runs'
  if (run && run[2] === 'events' && method === 'GET') return `/api/agent/runs/${run[1]}/events${query}`
  if (run && run[2] === 'cancel' && method === 'POST') return `/api/agent/runs/${run[1]}/cancel`
  if (run && !run[2] && method === 'GET') return `/api/agent/runs/${run[1]}${query}`
  return null
}

export function setupAssistant(app, auth) {
  const datadeckProxy = (pathRewrite) => createProxyMiddleware({
    target: config.datadeckUrl,
    changeOrigin: true,
    ws: true,
    ...(pathRewrite ? { pathRewrite } : {}),
    on: {
      proxyRes(_proxyRes, _req, res) {
        // 浏览器同源请求需保留 iframe 页面路径,供下方 API 代理区分 Datadeck 与门户请求。
        res.setHeader('Referrer-Policy', 'same-origin')
      }
    }
  })
  const requireDatadeckAccess = (req, res) => {
    if (!auth?.enabled) return true
    const user = auth.currentUser(req)
    if (!user) {
      res.status(401).json({ code: 401, msg: '未登录或会话已过期' })
      return false
    }
    if (user.role !== 'admin') {
      const modules = auth.users.modulesOf(user)
      if (Array.isArray(modules) && modules.length > 0 && !modules.includes('devAssistant')) {
        res.status(403).json({ code: 403, msg: '无开发助手模块权限' })
        return false
      }
    }
    return true
  }

  // Datadeck 页面位于同源 /agent,将 Express 挂载剥掉的路径前缀补回上游。
  const datadeckPageProxy = datadeckProxy((path) => datadeckPath('/agent', path))
  app.use('/agent', (req, res, next) => {
    if (!requireDatadeckAccess(req, res)) return
    datadeckPageProxy(req, res, next)
  })

  // 移动端使用原生聊天 UI，只开放 Datadeck 对话必需的 API，不暴露管理/文件等任意接口。
  const mobileAssistantProxy = datadeckProxy((path, req) => mobileAssistantTarget(path, req.method) || path)
  app.use('/api/mobile/assistant', (req, res, next) => {
    if (!requireDatadeckAccess(req, res)) return
    if (!mobileAssistantTarget(req.url, req.method)) {
      return res.status(404).json({ code: 404, msg: '移动助手接口不存在' })
    }
    mobileAssistantProxy(req, res, next)
  })

  // Datadeck 使用根路径静态资源。门户 dist 优先提供自己的文件,未命中才落到这里。
  for (const prefix of ['/assets', '/uploads']) {
    const resourceProxy = datadeckProxy((path) => datadeckPath(prefix, path))
    app.use(prefix, (req, res, next) => {
      if (!requireDatadeckAccess(req, res)) return
      resourceProxy(req, res, next)
    })
  }

  // 同源 iframe 的 API 仍请求 /api/*;以 Referer 的 /agent 页面路径区分,不改写 Datadeck 前端,
  // 也不接管门户其他页面发起的 API。/api/auth/me 在 setupAuth 路由中会先 next('route')。
  const datadeckApiProxy = datadeckProxy()
  app.use((req, res, next) => {
    if (!isDatadeckIframeRequest(req) || !req.path.startsWith('/api/')) return next()
    if (!requireDatadeckAccess(req, res)) return
    datadeckApiProxy(req, res, next)
  })

  const assistantProjects = createAssistantProjectsRoutes({ workspaceRoot: config.assistantWorkspace })
  app.get('/api/assistant/projects', (req, res) => res.json(assistantProjects.list()))
  app.post('/api/assistant/projects', express.json(), (req, res) => {
    try {
      res.json(assistantProjects.create(req.body?.name || ''))
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
  })
  // 统一错误包装:模块方法同步抛错 → {code, msg} JSON(Express 默认会返回 HTML 500)
  const wrap = (fn) => (req, res) => {
    try {
      res.json(fn(req))
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
  }
  app.delete('/api/assistant/projects/:id', wrap((req) => assistantProjects.remove(req.params.id)))
  app.get('/api/assistant/projects/:id/files', wrap((req) => assistantProjects.listFiles(req.params.id, req.query.rel || '')))
  app.get('/api/assistant/projects/:id/file', wrap((req) => assistantProjects.readFile(req.params.id, req.query.rel || '')))
  app.delete('/api/assistant/projects/:id/file', wrap((req) => assistantProjects.removeFile(req.params.id, req.query.rel || '')))
  app.patch('/api/assistant/projects/:id/file', express.json(), wrap((req) => assistantProjects.renameFile(req.params.id, req.body?.rel || '', req.body?.name, req.body?.newName)))
  app.post('/api/assistant/projects/:id/dir', express.json(), wrap((req) => assistantProjects.mkdir(req.params.id, req.body?.rel || '', req.body?.name || '')))
  app.post('/api/assistant/projects/:id/file', express.json(), wrap((req) => assistantProjects.createFile(req.params.id, req.body?.rel || '', req.body?.name || '', req.body?.content)))
  app.post('/api/assistant/projects/:id/upload', express.json({ limit: '20mb' }), (req, res) => {
    try {
      res.json(assistantProjects.upload(req.params.id, req.body?.name, req.body?.contentBase64))
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
  })
  app.put('/api/assistant/projects/session', express.json(), (req, res) => {
    try {
      res.json(assistantProjects.bindSession(req.body?.sessionId, req.body?.projectId || null))
    } catch (e) {
      res.status(e.status || 500).json({ code: e.status || 500, msg: e.message })
    }
  })

  // ── 转发到本地 Reasonix serve(8787),注入 auth cookie ──────
  // 8787 为 token 模式(/auth/token 换取 HttpOnly cookie reasonix_token,
  // 且 cookie 值就是 token 本身),网关持有 token 直接附加,浏览器同源无感。
  // /events SSE 由 http-proxy 流式透传,EventSource 指向门户同源路径。
  if (config.assistantUrl) {
    app.use('/api/assistant', createProxyMiddleware({
      target: config.assistantUrl,
      changeOrigin: true,
      pathRewrite: { '^/api/assistant': '' },
      logLevel: 'warn',
      on: {
        proxyReq(proxyReq) {
          if (config.assistantToken) {
            proxyReq.setHeader('Cookie', `reasonix_token=${config.assistantToken}`)
          }
        },
        proxyRes(proxyRes) {
          delete proxyRes.headers['x-frame-options']
        }
      }
    }))
  }
}
