// bigdata-portal 网关装配器(2026-08 重构):
// 业务逻辑已按模块拆出 —— 中间件 /utils/proxy-utils.py、/utils/sql-write-detect.js、
// engine-map.js、middleware/*、routes/*。本文件只负责:
//   1) 基础中间件(静态托管、cookie、代理路径跳过 body 解析、trust proxy)
//   2) 挂载顺序:auth → 门禁 → 各路由模块(顺序与原单文件完全一致,行为等价)
//   3) SPA fallback 与 WebSocket 代理装配
// 新增模块只需在此追加一行 setupXxx(app) + 一个独立 routes/*.js,不再需要改门禁定义。
import { EventEmitter } from 'node:events'
import express from 'express'
import path from 'node:path'
import cookieParser from 'cookie-parser'
import config from './config.js'
import { setupAuth } from './auth.js'
import { createAuthGate } from './middleware/auth-gate.js'
import { createExecGate } from './middleware/exec-gate.js'
import { setupAssistant } from './routes/assistant.js'
import { setupYarnProxy } from './routes/yarn-proxy.js'
import { setupSubappsProxy } from './routes/subapps-proxy.js'
import { setupPortal } from './routes/portal.js'
import { setupDb } from './routes/db.js'
import { setupSpark } from './routes/spark.js'
import { setupFlink } from './routes/flink.js'
import { setupDbQuery } from './routes/dbquery.js'
import { setupWsProxies } from './routes/ws-proxy.js'
import { initDsDeps, dsDepsRouter } from './ds-deps.js'
import { dbScriptsRouter } from './db-scripts.js'
import { dataleapRouter, initDataleap } from './dataleap.js'

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

// 登录门禁(PROTECTED_PREFIXES)与执行门禁(EXEC_GATES)顺次挂载;
// 未初始化(无任何用户)时,除初始化接口外一律 503,避免门户裸奔。
app.use(createAuthGate(auth))
app.use(createExecGate(auth))

// ── 各业务路由模块(注册顺序与拆分前的单文件完全一致)────────────
setupAssistant(app) // /api/assistant:项目路由 + 8787 代理(代理在项目路由之后挂载,前缀精确转发)
setupYarnProxy(app) // YARN:hadoopapi 动态代理 + yarniframe HTML 重写 + iframe-proxy
setupSubappsProxy(app) // 子应用 iframe:HDFS/DS Web/Jupyter/DolphinScheduler/Stingray
setupPortal(app) // 门户配置下发:/api/config/modules + /api/config
setupDb(app, auth) // DB 访问:/api/db(权限+acl+jobs+explain+透传)+ /api/db-perms 管理
setupSpark(app) // Spark SQL:token 体系 + 限速 + query/jobs/logs/status/config/stages/cancel
setupFlink(app) // Flink SQL:交互/async/连接器/DDL/jobs/PreJob
setupDbQuery(app) // MySQL/Oracle 同步查询:/api/dbquery/query

// ── 工作流依赖采集与级联重跑(/api/ds-deps)───────────────────
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

// ── WebSocket 代理(stingray/jupyter)+ upgrade 登录鉴权 ─────────
const server = app.listen(config.port, () => {
  console.log(`[bigdata-portal] gateway listening on http://localhost:${config.port}`)
  console.log(`  RM:      ${config.resourceManagers.join(', ')}`)
  console.log(`  HDFS:    ${config.hdfsUrl}`)
  console.log(`  DS Web:  ${config.dsWebUrl}`)
  console.log(`  OMD:     ${config.omdUrl}`)
  console.log(`  Stingray:${config.stingrayUrl}`)
  console.log(`  Jupyter: ${config.jupyterUrl}`)
})
setupWsProxies(server, { auth })