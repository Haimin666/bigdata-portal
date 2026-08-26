// bigdata-portal 独立网关入口:静态托管 + 认证门禁 + 各模块路由挂载。
// 业务路由一律放在 server/routes/<module>.js(见 docs/DEVELOPMENT.md §3.1 模块归属表),
// 本文件只做装配,不堆业务逻辑:
//   routes/db.js    → /api/db*、/api/dbquery、/api/spark/*、/api/flink/*(含写防线)
//   routes/proxy.js → 子应用 iframe 代理体系 + WS upgrade 鉴权
import { EventEmitter } from 'node:events'
import express from 'express'
import http from 'node:http'
import path from 'node:path'
import cookieParser from 'cookie-parser'
import { createProxyMiddleware } from 'http-proxy-middleware'
import config from './config.js'
import { setupAuth } from './auth.js'
import { setupDbRoutes } from './routes/db.js'
import { setupProxy, setupWsUpgrade } from './routes/proxy.js'

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
const PROXY_PATHS = ['/apps', '/dolphinscheduler', '/static', '/webhdfs', '/stingray-static', '/__/', '/hadoopapi', '/api/db/', '/api/assistant']
app.use((req, res, next) => {
  if (PROXY_PATHS.some((p) => req.path.startsWith(p))) return next()
  express.json({ limit: '20mb' })(req, res, next)
})

// ── 认证与用户管理 ─────────────────────────────────────────────
// 自建账号(用户名+密码,scrypt),会话 = HttpOnly cookie + data/sessions.json。
// 阶段一只保护门户壳:门户 API 与子应用代理路径;子应用内部账号体系不打通。
const auth = setupAuth(app, config)

// 受保护路径:未登录一律 401(除 /api/auth/* 与静态资源/SPA 页面,由前端路由守卫拦截)。
// 未初始化(无任何用户)时,除初始化接口外一律 503,避免门户裸奔。
const PROTECTED_PREFIXES = [
  '/api/db', '/api/dbquery', '/api/spark', '/api/flink', '/api/users',
  '/api/ds-deps', '/api/scripts', '/api/config', '/api/dataleap',
  '/api/assistant',
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
  { re: /^\/api\/dbquery\//, module: 'dbQuery' }, // MySQL/Oracle 查询(/schema /explain 已改走 /api/db/* 透传)
  { re: /^\/api\/db\/jobs/, module: 'dbQuery', onlyWrite: true }, // MySQL/Oracle 异步任务提交/取消(GET 状态查询放行)
  { re: /^\/api\/db\/(schema|explain)(\/|$)/, module: 'dbQuery' }, // 元数据补全/执行计划(只读,仍需模块与角色门禁)
  { re: /^\/api\/scripts\/(new|rename|delete|move|save)/, module: 'dbQuery' }, // 脚本文件写(前缀匹配,容忍尾斜杠)
  { re: /^\/api\/ds-deps\/(refresh|rerun-instances|rerun-cascade|rerun-from-node)$/, module: 'dsTask' }, // 采集/重跑
  { re: /^\/api\/assistant\/projects/, module: 'devAssistant', onlyWrite: true }, // 项目/文件/目录/上传/会话绑定(POST/PUT/PATCH/DELETE;GET 只读放行);module 必须与菜单 name 一致(menu.ts: devAssistant)
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

// ── 配置下发 ───────────────────────────────────────────────────
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
app.get('/api/config', (req, res) =>
  res.json({
    resourceManagers: config.resourceManagers,
    hdfsUrl: config.hdfsUrl,
    dsWebUrl: config.dsWebUrl,
    omdUrl: config.omdUrl,
    stingrayUrl: config.stingrayUrl
  })
)

// ── 开发助手:项目制(元数据 + workspace 目录创建)─────────
// 注意:/api/assistant/* 全量走 8787 代理,项目路由必须先挂载,代理按前缀精确转发剩余路径。
import { createAssistantProjectsRoutes } from './assistant-projects.js'
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

// ── 开发助手:转发到本地 Reasonix serve(8787),注入 auth cookie ──
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

// ── 数据库查询域(db-query 模块):/api/db*、/api/dbquery、spark/flink ──
setupDbRoutes(app, auth)

// ── 子应用同源代理(platform):HDFS/DS/Jupyter/Stingray/YARN iframe ──
setupProxy(app)

// ── 工作流依赖采集与级联重跑(/api/ds-deps)───────────────────
import { initDsDeps, dsDepsRouter } from './ds-deps.js'
import { dbScriptsRouter } from './db-scripts.js'
import { dataleapRouter, initDataleap } from './dataleap.js'
initDsDeps() // 启动加载缓存 + 初始化采集 + 定时刷新
initDataleap() // DataLeap cron 调度器(本地,分钟级)
app.use('/api/ds-deps', dsDepsRouter())
app.use('/api/scripts', dbScriptsRouter())
app.use('/api/dataleap', dataleapRouter())

// ── SPA fallback(仅非 API 的 GET 路由) ────────────────────────
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  // index.html 必须 no-cache:dist 每次构建后 chunk 文件名带新 hash,
  // 浏览器若命中旧的 index.html(304)会去加载已删除的旧 chunk 而白屏。
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.sendFile(path.join(DIST_DIR, 'index.html'))
})

const server = app.listen(config.port, () => {
  console.log(`[bigdata-portal] gateway listening on http://localhost:${config.port}`)
})

// WebSocket 代理接线(Stingray 日志推送 / Jupyter kernel),鉴权在 proxy.js 内完成
setupWsUpgrade(server, auth)
