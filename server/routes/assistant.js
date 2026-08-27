// 开发助手路由(从 index.js 拆出):
// /api/assistant/* 项目路由(元数据 + workspace 目录操作)在前,8787 代理在后,
// 代理按前缀精确转发剩余路径;项目路由必须先挂载,否则会被代理吞掉。
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import config from '../config.js'
import { createAssistantProjectsRoutes } from '../assistant-projects.js'

export function setupAssistant(app) {
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