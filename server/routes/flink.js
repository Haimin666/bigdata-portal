// Flink SQL 执行路由(从 index.js 拆出:交互 + PreJob)。
// 安全策略:Flink 执行类接口由数据权限矩阵 flink 规则管控 —— 只读 SQL 需读权限,
// 写 SQL(INSERT/CREATE/... 以及多语句脚本中的任一条写)需写权限;writeUnlocked
// 仅在判定为写时置位(与 Spark 一致)。元数据类接口(连接器/DDL 生成/任务列表/日志)
// 为只读,校验 Flink 读权限(admin 放行;无规则用户不受影响)。
import config from '../config.js'
import { checkFlinkAccess } from '../db-permissions.js'
import { isAnySqlWrite } from '../utils/sql-write-detect.js'
import { clampTimeoutMs } from '../utils/timeout.js'
import { sendUpstreamError } from '../utils/upstream-error.js'
import { jobOwnership } from '../utils/job-ownership.js'
import {
  query as flinkQuery, cancel as flinkCancel, status as flinkStatus,
  connectors as flinkConnectors, probeSchema as flinkProbeSchema, generateDdl as flinkGenerateDdl,
  jobs as flinkJobs, jobStatus as flinkJobStatus, jobStop as flinkJobStop,
  asyncSubmit as flinkAsyncSubmit, asyncStatus as flinkAsyncStatus, asyncCancel as flinkAsyncCancel,
  prejobSubmit, prejobJobs, prejobStatus, prejobLogs, prejobCancel, prejobConfig
} from '../flink-gateway.js'

function denyOrUpstream(res, e, prefix, scope) {
  if (e?.statusCode === 403) return res.status(403).json({ code: 403, msg: e.message })
  console.error(`[${scope}]`, e instanceof Error ? e.message : e)
  sendUpstreamError(res, e, { prefix })
}

export function setupFlink(app) {
  if (config.dbProxyUrl) {
    // Flink 查询:先过权限矩阵(无 flink 读/写权限 → 403),再执行。
    // 权限校验放 try 内:校验失败须以 403 JSON 响应(async handler 顶层 throw 会挂起等待方)。
    app.post('/api/flink/query', async (req, res) => {
      try {
        const sql = String(req.body?.sql || '')
        const isWrite = isAnySqlWrite(sql)
        checkFlinkAccess(req, isWrite)
        const timeoutMs = clampTimeoutMs(req.body?.timeoutMs, 120000, 1000, 600000)
        const data = await flinkQuery(sql, {
          mode: req.body?.mode === 'stream' ? 'stream' : 'batch',
          writeUnlocked: isWrite,
          timeoutMs
        })
        res.json({ code: 0, data })
      } catch (e) {
        denyOrUpstream(res, e, 'flink 查询失败', 'flink/query')
      }
    })

    // 异步任务通道:流式 SELECT / 大结果提交即返回 jobId,前端轮询(网关 60s 超时安全)
    app.post('/api/flink/async', async (req, res) => {
      try {
        const sql = String(req.body?.sql || '')
        const isWrite = isAnySqlWrite(sql)
        checkFlinkAccess(req, isWrite)
        const data = await flinkAsyncSubmit(sql, {
          mode: req.body?.mode === 'stream' ? 'stream' : 'batch',
          writeUnlocked: isWrite,
          timeoutMs: clampTimeoutMs(req.body?.timeoutMs, 600000, 1000, 3600000)
        })
        if (data?.jobId) jobOwnership.register(req, 'flink-async', data.jobId)
        res.json({ code: 0, data })
      } catch (e) {
        denyOrUpstream(res, e, 'flink 异步提交失败', 'flink/async')
      }
    })
    app.get('/api/flink/async/:jobId', async (req, res) => {
      try {
        checkFlinkAccess(req, false)
        if (!jobOwnership.allows(req, 'flink-async', req.params.jobId)) {
          return res.status(403).json({ code: 403, msg: '无权访问该 Flink 任务(非提交者或已过期)' })
        }
        res.json({ code: 0, data: await flinkAsyncStatus(req.params.jobId) })
      } catch (e) {
        denyOrUpstream(res, e, 'flink 任务状态获取失败', 'flink/async/:id')
      }
    })
    app.post('/api/flink/async/:jobId/cancel', async (req, res) => {
      try {
        if (!jobOwnership.allows(req, 'flink-async', req.params.jobId)) {
          return res.status(403).json({ code: 403, msg: '无权访问该 Flink 任务(非提交者或已过期)' })
        }
        res.json({ code: 0, data: await flinkAsyncCancel(req.params.jobId) })
      } catch (e) {
        denyOrUpstream(res, e, 'flink 任务停止失败', 'flink/async/cancel')
      }
    })

    app.post('/api/flink/cancel', async (req, res) => {
      try {
        const data = await flinkCancel()
        res.json({ code: 0, data })
      } catch (e) {
        denyOrUpstream(res, e, 'flink 停止失败', 'flink/cancel')
      }
    })

    app.get('/api/flink/status', async (req, res) => {
      try {
        checkFlinkAccess(req, false)
        const data = await flinkStatus()
        res.json({ code: 0, data })
      } catch (e) {
        denyOrUpstream(res, e, 'flink 状态获取失败', 'flink/status')
      }
    })

    // 连接器 / DDL 生成(只读,不执行任务)
    app.get('/api/flink/connectors', async (req, res) => {
      try {
        checkFlinkAccess(req, false)
        res.json({ code: 0, data: await flinkConnectors() })
      } catch (e) {
        denyOrUpstream(res, e, 'flink 连接器加载失败', 'flink/connectors')
      }
    })
    app.post('/api/flink/connectors/:name/probe', async (req, res) => {
      try {
        checkFlinkAccess(req, false)
        res.json({ code: 0, data: await flinkProbeSchema(req.params.name, req.body?.params || {}) })
      } catch (e) {
        denyOrUpstream(res, e, 'flink 探测失败', 'flink/probe')
      }
    })
    app.post('/api/flink/ddl/generate', async (req, res) => {
      try {
        checkFlinkAccess(req, false)
        res.json({ code: 0, data: await flinkGenerateDdl(req.body || {}) })
      } catch (e) {
        denyOrUpstream(res, e, 'flink DDL 生成失败', 'flink/ddl')
      }
    })

    // 交互引擎流式任务(只读列表/详情;停止无需解锁,同 spark cancel 语义)
    app.get('/api/flink/jobs', async (req, res) => {
      try {
        checkFlinkAccess(req, false)
        res.json({ code: 0, data: await flinkJobs() })
      } catch (e) {
        denyOrUpstream(res, e, 'flink 任务列表获取失败', 'flink/jobs')
      }
    })
    app.get('/api/flink/jobs/:id', async (req, res) => {
      try {
        checkFlinkAccess(req, false)
        res.json({ code: 0, data: await flinkJobStatus(req.params.id) })
      } catch (e) {
        denyOrUpstream(res, e, 'flink 任务详情获取失败', 'flink/jobs/:id')
      }
    })
    app.post('/api/flink/jobs/:id/stop', async (req, res) => {
      try {
        checkFlinkAccess(req, false)
        res.json({ code: 0, data: await flinkJobStop(req.params.id) })
      } catch (e) {
        denyOrUpstream(res, e, 'flink 任务停止失败', 'flink/jobs/:id/stop')
      }
    })

    // PreJob 提交(真实占用 YARN 资源)。写凭证由网关按写判定附加
    // (db-proxy 侧校验共享密钥,防直连绕过)。
    app.post('/api/flink/prejob/jobs', async (req, res) => {
      try {
        const sql = String(req.body?.sql || '')
        const isWrite = isAnySqlWrite(sql)
        checkFlinkAccess(req, isWrite)
        const data = await prejobSubmit({
          name: String(req.body?.name || ''),
          sql,
          ...(req.body?.queue ? { queue: String(req.body.queue) } : {})
        }, { writeUnlocked: isWrite })
        if (data?.jobId) jobOwnership.register(req, 'flink-prejob', data.jobId)
        res.json({ code: 0, data })
      } catch (e) {
        denyOrUpstream(res, e, 'flink PreJob 提交失败', 'flink/prejob/submit')
      }
    })
    app.get('/api/flink/prejob/jobs', async (req, res) => {
      try {
        checkFlinkAccess(req, false)
        res.json({ code: 0, data: await prejobJobs() })
      } catch (e) {
        denyOrUpstream(res, e, 'flink PreJob 列表获取失败', 'flink/prejob/jobs')
      }
    })
    app.get('/api/flink/prejob/jobs/:id', async (req, res) => {
      try {
        checkFlinkAccess(req, false)
        if (!jobOwnership.allows(req, 'flink-prejob', req.params.id)) {
          return res.status(403).json({ code: 403, msg: '无权访问该 Flink PreJob(非提交者或已过期)' })
        }
        res.json({ code: 0, data: await prejobStatus(req.params.id) })
      } catch (e) {
        denyOrUpstream(res, e, 'flink PreJob 详情获取失败', 'flink/prejob/status')
      }
    })
    app.get('/api/flink/prejob/jobs/:id/logs', async (req, res) => {
      try {
        checkFlinkAccess(req, false)
        if (!jobOwnership.allows(req, 'flink-prejob', req.params.id)) {
          return res.status(403).json({ code: 403, msg: '无权访问该 Flink PreJob(非提交者或已过期)' })
        }
        res.json({ code: 0, data: await prejobLogs(req.params.id, Math.min(Number(req.query.tail) || 200, 5000)) })
      } catch (e) {
        denyOrUpstream(res, e, 'flink PreJob 日志获取失败', 'flink/prejob/logs')
      }
    })
    app.post('/api/flink/prejob/jobs/:id/cancel', async (req, res) => {
      // 停止不再要求用户解锁(与提交一致):停止是运维管控操作,无需密码。
      // 归属校验:仅提交者(或 admin)可停止,防跨用户取消。
      try {
        if (!jobOwnership.allows(req, 'flink-prejob', req.params.id)) {
          return res.status(403).json({ code: 403, msg: '无权访问该 Flink PreJob(非提交者或已过期)' })
        }
        res.json({ code: 0, data: await prejobCancel(req.params.id) })
      } catch (e) {
        denyOrUpstream(res, e, 'flink PreJob 停止失败', 'flink/prejob/cancel')
      }
    })
    app.get('/api/flink/prejob/config', async (req, res) => {
      try {
        checkFlinkAccess(req, false)
        res.json({ code: 0, data: await prejobConfig() })
      } catch (e) {
        denyOrUpstream(res, e, 'flink PreJob 配置获取失败', 'flink/prejob/config')
      }
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
