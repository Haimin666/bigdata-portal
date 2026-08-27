// Flink SQL 执行路由(从 index.js 拆出:交互 + PreJob)。
// 安全策略:所有 flink 类型任务(交互查询/流式任务/PreJob 提交)一律要求解锁,
// 防止未授权用户向 YARN 提交作业/占用集群资源;元数据类接口(连接器/DDL 生成/
// 任务列表/日志)为只读,不强制。
import config from '../config.js'
import { checkFlinkAccess } from '../db-permissions.js'
import {
  query as flinkQuery, cancel as flinkCancel, status as flinkStatus,
  connectors as flinkConnectors, probeSchema as flinkProbeSchema, generateDdl as flinkGenerateDdl,
  jobs as flinkJobs, jobStatus as flinkJobStatus, jobStop as flinkJobStop,
  asyncSubmit as flinkAsyncSubmit, asyncStatus as flinkAsyncStatus, asyncCancel as flinkAsyncCancel,
  prejobSubmit, prejobJobs, prejobStatus, prejobLogs, prejobCancel, prejobConfig
} from '../flink-gateway.js'

export function setupFlink(app) {
  if (config.dbProxyUrl) {
    // Flink 查询:先过权限矩阵(无 flink 权限 → 403),再执行。
    // 权限校验放 try 内:校验失败须以 403 JSON 响应(async handler 顶层 throw 会挂起等待方)。
    app.post('/api/flink/query', async (req, res) => {
      try {
        checkFlinkAccess(req)
        const timeoutMs = Math.min(Number(req.body?.timeoutMs) || 120000, 600000)
        const data = await flinkQuery(String(req.body?.sql || ''), {
          mode: req.body?.mode === 'stream' ? 'stream' : 'batch',
          writeUnlocked: true,
          timeoutMs
        })
        res.json({ code: 0, data })
      } catch (e) {
        if (e?.statusCode === 403) {
          return res.status(403).json({ code: 403, msg: e.message })
        }
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[flink/query]', msg)
        res.status(502).json({ code: 502, msg: `flink 查询失败: ${msg.slice(0, 300)}` })
      }
    })

    // 异步任务通道:流式 SELECT / 大结果提交即返回 jobId,前端轮询(网关 60s 超时安全)
    app.post('/api/flink/async', async (req, res) => {
      try {
        checkFlinkAccess(req)
        const data = await flinkAsyncSubmit(String(req.body?.sql || ''), {
          mode: req.body?.mode === 'stream' ? 'stream' : 'batch',
          writeUnlocked: true,
          timeoutMs: Math.min(Number(req.body?.timeoutMs) || 600000, 3600000)
        })
        res.json({ code: 0, data })
      } catch (e) {
        if (e?.statusCode === 403) {
          return res.status(403).json({ code: 403, msg: e.message })
        }
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[flink/async]', msg)
        res.status(502).json({ code: 502, msg: `flink 异步提交失败: ${msg.slice(0, 300)}` })
      }
    })
    app.get('/api/flink/async/:jobId', async (req, res) => {
      try {
        res.json({ code: 0, data: await flinkAsyncStatus(req.params.jobId) })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[flink/async/:id]', msg)
        res.status(502).json({ code: 502, msg: `flink 任务状态获取失败: ${msg.slice(0, 300)}` })
      }
    })
    app.post('/api/flink/async/:jobId/cancel', async (req, res) => {
      try {
        res.json({ code: 0, data: await flinkAsyncCancel(req.params.jobId) })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[flink/async/cancel]', msg)
        res.status(502).json({ code: 502, msg: `flink 任务停止失败: ${msg.slice(0, 300)}` })
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

    // PreJob 提交(真实占用 YARN 资源)。已移除用户解锁要求:
    // 写凭证由网关自动携带(db-proxy 侧校验共享密钥,防直连绕过)
    app.post('/api/flink/prejob/jobs', async (req, res) => {
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
      // 停止不再要求用户解锁(与提交一致):停止是运维管控操作,无需密码。
      // 网关仅注入 db-proxy 鉴权 token(proxy 统一附加 X-DB-Token),防直连绕过靠 db-proxy 侧。
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
}