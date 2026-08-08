// ds-deps:海豚工作流依赖采集 + 缓存 + 级联重跑支持
//
// 背景:离线任务工作流分散,ODS 失败后下游整串受影响,需要"一键级联重跑"。
// 依赖关系来自海豚工作流定义:
//   1. 工作流间依赖:DEPENDENT 任务的 dependence(dependTaskList → 上游项目/工作流/任务)
//   2. 任务间依赖(工作流内 DAG):connects 边(任务节点前后关系)
// 采集是重操作(全量扫所有项目/工作流/定义),所以:
//   - 启动时初始化一次 + 定时(默认 1h)刷新 + 手动刷新接口
//   - 缓存到内存 + 文件(重启不丢);docker 部署需挂载缓存目录

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { Router } from 'express'

// ── 配置 ──────────────────────────────────────────────────────
const DS_BASE = process.env.DS_WEB_URL || 'http://olds.bigdata.shiqiao.com/dolphinscheduler'
const DS_TOKEN = process.env.DS_TOKEN || ''
// 缓存文件路径(默认项目根 data/;docker 挂载 /app/data)
const CACHE_FILE =
  process.env.DS_DEPS_CACHE_FILE || path.join(import.meta.dirname, '../data/ds-deps.json')
// 定时刷新周期(毫秒,默认 1h)
const REFRESH_INTERVAL = parseInt(process.env.DS_DEPS_REFRESH_INTERVAL || String(60 * 60 * 1000), 10)
// 采集并发数
const CONCURRENCY = 10

// ── 数据模型 ──────────────────────────────────────────────────
// node: 一个工作流定义
// {
//   projectId, projectName, processId, processName,
//   tasks: [{id, name, type}],          // 工作流内任务节点
//   connects: [{from, to}],             // 任务 DAG 边
//   upstream: [{projectId, processId, taskName}]  // 工作流间依赖(DEPENDENT → 上游)
// }

let cache = {
  updatedAt: null,
  nodes: new Map() // processId → node
}

// ── HTTP 工具(直连海豚,带 token)────────────────────────────
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https://') ? https : http
    const payload = body ? JSON.stringify(body) : null
    const req = mod.request(
      url,
      {
        method,
        headers: {
          'token': DS_TOKEN || '',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve({ code: -1, msg: `parse error, raw=${data.slice(0, 100)}` })
          }
        })
      }
    )
    req.on('error', (e) => reject(e))
    req.setTimeout(15000, () => req.destroy(new Error('timeout')))
    if (payload) req.write(payload)
    req.end()
  })
}

async function dsApi(pathname, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const url = `${DS_BASE}${pathname}${qs ? '?' + qs : ''}`
  return request('GET', url)
}

async function dsPost(pathname, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const url = `${DS_BASE}${pathname}${qs ? '?' + qs : ''}`
  return request('POST', url)
}

// ── 依赖解析 ──────────────────────────────────────────────────
function parseProcessDefinition(data) {
  // data = process/select-by-id 返回的 data(含 processDefinitionJson / connects)
  const pdj = data.processDefinitionJson
  let tasks = []
  try {
    const pd = typeof pdj === 'string' ? JSON.parse(pdj) : pdj
    tasks = pd?.tasks || []
  } catch {
    /* 解析失败按空处理 */
  }
  // 任务 DAG 边(connects 可能是 JSON 字符串)
  let connects = []
  try {
    const c = typeof data.connects === 'string' ? JSON.parse(data.connects) : data.connects
    connects = (c || []).map((e) => ({
      from: e.endPointSourceId,
      to: e.endPointTargetId
    }))
  } catch {
    /* 忽略 */
  }
  // 工作流间依赖:找 DEPENDENT 任务的 dependence
  const upstream = []
  for (const t of tasks) {
    const type = String(t.type || t.taskType || '').toUpperCase()
    if (type === 'DEPENDENT' && t.dependence?.dependTaskList) {
      for (const dt of t.dependence.dependTaskList) {
        for (const item of dt.dependItemList || []) {
          if (item.definitionId) {
            upstream.push({
              projectId: item.projectId,
              processId: item.definitionId,
              taskName: item.depTasks || ''
            })
          }
        }
      }
    }
  }
  return {
    tasks: tasks.map((t) => ({ id: t.id, name: t.name, type: t.type || t.taskType })),
    connects,
    upstream
  }
}

// ── 采集 ──────────────────────────────────────────────────────
async function fetchAllProcessIds(projectName) {
  // 分页拉全量工作流列表,返回 [{id, name, releaseState}]
  const out = []
  let page = 1
  const PAGE_SIZE = 100
  for (;;) {
    const d = await dsApi(`/projects/${encodeURIComponent(projectName)}/process/list-paging`, {
      pageNo: page,
      pageSize: PAGE_SIZE
    })
    const list = d?.data?.totalList || []
    for (const p of list) {
      out.push({ id: p.id, name: p.name, releaseState: p.releaseState })
    }
    if (!list.length || list.length < PAGE_SIZE) break
    page++
    if (page > 50) break // 安全上限
  }
  return out
}

// 全量采集锁(防止并发重复采集打垮海豚)
let collecting = false

async function collect() {
  if (collecting) return
  collecting = true
  console.log('[ds-deps] 开始采集工作流依赖...')
  const start = Date.now()
  try {
    // 1. 项目列表
    const projRes = await dsApi('/projects/query-project-list')
  const projects = projRes?.data || []
  console.log(`[ds-deps] 项目数: ${projects.length}`)
  // 2. 每项目的工作流列表(收集 processId + 名称)
  const allWorkflows = [] // {projectId, projectName, id, name}
  for (const p of projects) {
    try {
      const flows = await fetchAllProcessIds(p.name)
      for (const f of flows) {
        // 只缓存已上线(ONLINE)的工作流:下线=旧版停用,不纳入依赖树/级联重跑
        if (String(f.releaseState).toUpperCase() !== 'ONLINE') continue
        allWorkflows.push({ projectId: p.id, projectName: p.name, processId: f.id, processName: f.name })
      }
    } catch (e) {
      console.warn(`[ds-deps] 项目 ${p.name} 工作流列表失败: ${e.message}`)
    }
  }
  console.log(`[ds-deps] 工作流总数: ${allWorkflows.length}`)
  // 3. 并发逐个拉定义解析
  const nodes = new Map()
  let cursor = 0
  const worker = async () => {
    while (cursor < allWorkflows.length) {
      const wf = allWorkflows[cursor++]
      try {
        const d = await dsApi(`/projects/${encodeURIComponent(wf.projectName)}/process/select-by-id`, {
          processId: wf.processId
        })
        if (d?.code === 0 && d.data) {
          const parsed = parseProcessDefinition(d.data)
          nodes.set(String(wf.processId), {
            projectId: wf.projectId,
            projectName: wf.projectName,
            processId: wf.processId,
            processName: wf.processName,
            ...parsed
          })
        }
      } catch (e) {
        // 单个失败跳过
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  cache = { updatedAt: new Date().toISOString(), nodes }
  persist()
  console.log(`[ds-deps] 采集完成: ${nodes.size} 个工作流, 耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } finally {
    collecting = false
  }
}

// ── 缓存持久化 ────────────────────────────────────────────────
function persist() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      updatedAt: cache.updatedAt,
      nodes: Array.from(cache.nodes.values())
    }))
  } catch (e) {
    console.warn(`[ds-deps] 缓存写入失败: ${e.message}`)
  }
}

function load() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
      cache.nodes = new Map((raw.nodes || []).map((n) => [String(n.processId), n]))
      cache.updatedAt = raw.updatedAt || null
      console.log(`[ds-deps] 从文件加载缓存: ${cache.nodes.size} 个工作流`)
    }
  } catch (e) {
    console.warn(`[ds-deps] 缓存加载失败: ${e.message}`)
  }
}

// ── 依赖图查询 ────────────────────────────────────────────────
function findNode(processId) {
  return cache.nodes.get(String(processId))
}

/** 上游链(递归):当前工作流 → 它依赖的上游 → ... 直到最上游 */
function buildUpstreamChain(processId, visited = new Set()) {
  const node = findNode(processId)
  if (!node || visited.has(String(processId))) return []
  visited.add(String(processId))
  const ups = []
  for (const up of node.upstream || []) {
    const upNode = findNode(up.processId)
    ups.push({
      processId: up.processId,
      processName: upNode?.processName || `工作流#${up.processId}`,
      projectName: upNode?.projectName || `项目#${up.projectId}`,
      depTask: up.taskName
    })
  }
  // 递归上游的上游
  for (const up of ups) {
    const chain = buildUpstreamChain(up.processId, visited)
    up.upstream = chain.length ? chain : undefined
  }
  return ups
}

/** 下游链(递归):谁依赖当前工作流 → 再往下 */
function buildDownstreamChain(processId, visited = new Set()) {
  const key = String(processId)
  if (visited.has(key)) return []
  visited.add(key)
  const downs = []
  for (const [id, node] of cache.nodes) {
    const depsOnMe = (node.upstream || []).filter((u) => String(u.processId) === key)
    if (depsOnMe.length) {
      downs.push({
        processId: node.processId,
        processName: node.processName,
        projectName: node.projectName,
        depTasks: depsOnMe.map((d) => d.taskName).join(',')
      })
    }
  }
  for (const d of downs) {
    const chain = buildDownstreamChain(d.processId, visited)
    d.downstream = chain.length ? chain : undefined
  }
  return downs
}

/** 完整树:最上游 → 当前 → 最下游(跨项目) */
function buildFullTree(processId) {
  const node = findNode(processId)
  if (!node) return null
  return {
    processId: node.processId,
    processName: node.processName,
    projectName: node.projectName,
    upstream: buildUpstreamChain(processId),
    downstream: buildDownstreamChain(processId)
  }
}

/** 查某工作流最近实例(按 defId + 时间倒序),返回最新一条或 null */
async function fetchLatestInstance(projectName, processId, days = 1) {
  try {
    const now = Date.now()
    const start = new Date(now - days * 86400000).toISOString().slice(0, 19).replace('T', ' ')
    const end = new Date(now).toISOString().slice(0, 19).replace('T', ' ')
    const d = await dsApi(
      `/projects/${encodeURIComponent(projectName)}/instance/list-paging`,
      { pageNo: 1, pageSize: 1, processDefinitionId: processId, startDate: start, endDate: end }
    )
    const list = d?.data?.totalList || []
    if (!list.length) return null
    const i = list[0]
    return { instanceId: i.id, name: i.name, state: i.state }
  } catch {
    return null
  }
}

/** 工作流内任务 DAG(含依赖关系,可算上下游) */
function buildTaskGraph(processId) {
  const node = findNode(processId)
  if (!node) return null
  const taskMap = new Map((node.tasks || []).map((t) => [t.id, t]))
  // 邻接表
  const adj = new Map()
  for (const c of node.connects || []) {
    if (!adj.has(c.from)) adj.set(c.from, [])
    adj.get(c.from).push(c.to)
  }
  return {
    processId: node.processId,
    processName: node.processName,
    projectName: node.projectName,
    tasks: node.tasks || [],
    connects: node.connects || []
  }
}

/** 跨项目搜索:按工作流名/任务名/项目名匹配(基于缓存,快) */
function searchWorkflows(keyword) {
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw) return []
  const out = []
  for (const node of cache.nodes.values()) {
    // 工作流名匹配
    let matched = node.processName && node.processName.toLowerCase().includes(kw)
    let matchedTask = ''
    if (!matched) {
      // 任务名匹配
      for (const t of node.tasks || []) {
        if (t.name && t.name.toLowerCase().includes(kw)) {
          matched = true
          matchedTask = t.name
          break
        }
      }
    }
    const projectHit = node.projectName && node.projectName.toLowerCase().includes(kw)
    if (matched || projectHit) {
      out.push({
        projectId: node.projectId,
        projectName: node.projectName,
        processId: node.processId,
        processName: node.processName,
        matchedTask
      })
    }
  }
  // 按名称排序,截断防止过大
  return out.slice(0, 100)
}

// ── 初始化 ────────────────────────────────────────────────────
export function initDsDeps() {
  // 只加载缓存文件,不做自动采集/定时刷新(依赖数据仅手动刷新,
  // 避免全量扫描 4000+ 工作流对海豚产生大量请求)。
  // 手动刷新入口:/api/ds-deps/refresh(全量)或 ?processId=xxx(单工作流)
  load()
}

// ── Express 路由 ──────────────────────────────────────────────
export function dsDepsRouter() {
  const router = Router()

  // 依赖树(工作流级):最上游→当前→最下游,下游节点附最近实例状态
  // 频率控制:下游实例查询限并发 3,总超时 8s,避免打垮海豚
  router.get('/workflow-tree/:processId', async (req, res) => {
    const tree = buildFullTree(req.params.processId)
    if (!tree) return res.status(404).json({ code: 404, msg: '工作流不在依赖缓存中' })
    const CONCURRENCY = 3
    let active = 0
    const queue = [] // 待执行的下游实例查询任务
    const runQueued = () => {
      while (active < CONCURRENCY && queue.length) {
        const task = queue.shift()
        if (!task) break
        active++
        task().finally(() => {
          active--
          runQueued()
        })
      }
    }
    const annotate = async (nodes) => {
      for (const n of nodes || []) {
        queue.push(async () => {
          n.instance = await fetchLatestInstance(n.projectName, n.processId, 1)
        })
        await annotate(n.downstream)
      }
    }
    const task = (async () => {
      await annotate(tree.downstream)
      runQueued()
    })()
    try {
      await Promise.race([task, new Promise((r) => setTimeout(r, 8000))])
    } catch {
      /* 实例查询失败/超时不影响树 */
    }
    res.json({ code: 0, data: tree, updatedAt: cache.updatedAt })
  })

  // 任务级依赖图(工作流内 DAG)
  router.get('/task-graph/:processId', (req, res) => {
    const graph = buildTaskGraph(req.params.processId)
    if (!graph) return res.status(404).json({ code: 404, msg: '工作流不在依赖缓存中' })
    res.json({ code: 0, data: graph, updatedAt: cache.updatedAt })
  })

  // 手动刷新(全量;可选 ?processId= 单任务刷新该工作流)
  router.post('/refresh', async (req, res) => {
    const pid = req.query.processId
    if (pid) {
      // 单工作流刷新:查该工作流并更新缓存
      const node = findNode(pid)
      if (!node) return res.status(404).json({ code: 404, msg: '工作流不在缓存中' })
      try {
        const d = await dsApi(
          `/projects/${encodeURIComponent(node.projectName)}/process/select-by-id`,
          { processId: pid }
        )
        if (d?.code === 0 && d.data) {
          const parsed = parseProcessDefinition(d.data)
          cache.nodes.set(String(pid), { ...node, ...parsed })
          persist()
          return res.json({ code: 0, msg: '刷新成功' })
        }
        return res.status(500).json({ code: 500, msg: '刷新失败' })
      } catch (e) {
        return res.status(500).json({ code: 500, msg: e.message })
      }
    }
    // 全量刷新(异步触发,立即返回;加锁防并发重复采集)
    if (collecting) {
      return res.json({ code: 0, msg: '全量刷新进行中,请稍后' })
    }
    collect().catch((e) => console.error('[ds-deps] 手动全量刷新失败:', e.message))
    res.json({ code: 0, msg: '全量刷新已触发' })
  })

  // 缓存状态
  router.get('/status', (req, res) => {
    res.json({ code: 0, data: { updatedAt: cache.updatedAt, count: cache.nodes.size, cacheFile: CACHE_FILE } })
  })

  // 跨项目搜索工作流(按工作流名/任务名/项目名,基于缓存)
  router.get('/search-workflows', (req, res) => {
    const hits = searchWorkflows(req.query.keyword)
    res.json({ code: 0, data: hits })
  })

  // 批量重跑工作流实例(级联重跑:逐个 REPEAT_RUNNING)
  // body: { instances: [{projectName, instanceId, name}] }
  router.post('/rerun-instances', async (req, res) => {
    const { instances } = req.body || {}
    if (!Array.isArray(instances) || !instances.length) {
      return res.status(400).json({ code: 400, msg: 'instances 不能为空' })
    }
    const results = []
    for (const inst of instances) {
      try {
        const d = await dsPost(
          `/projects/${encodeURIComponent(inst.projectName)}/executors/execute`,
          { executeType: 'REPEAT_RUNNING', processInstanceId: inst.instanceId }
        )
        results.push({ name: inst.name, ok: d?.code === 0, msg: d?.msg || 'success' })
      } catch (e) {
        results.push({ name: inst.name, ok: false, msg: e.message })
      }
    }
    res.json({ code: 0, data: results })
  })

  // 级联重跑:对每个勾选的工作流节点,有实例则重跑,无实例则按今天新建
  // body: { nodes: [{projectName, processId, processName, instanceId?}] }
  router.post('/rerun-cascade', async (req, res) => {
    const { nodes } = req.body || {}
    if (!Array.isArray(nodes) || !nodes.length) {
      return res.status(400).json({ code: 400, msg: 'nodes 不能为空' })
    }
    // 海豚并发保护:实例正在执行命令时返回 'is executing the command',
    // 稍等后重试(最多 3 次,间隔 3s)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const isBusy = (msg) => typeof msg === 'string' && msg.includes('is executing the command')
    const rerunWithRetry = async (fn, label) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const d = await fn()
        if (d?.code === 0 || !isBusy(d?.msg)) {
          return d
        }
        if (attempt < 2) {
          console.warn(`[ds-deps] ${label} 实例忙(${d.msg}),${(attempt + 1) * 3}s 后重试`)
          await sleep((attempt + 1) * 3000)
        }
      }
      return await fn() // 最后再试一次(返回最终结果)
    }
    const results = []
    for (const n of nodes) {
      try {
        let instanceId = n.instanceId
        if (!instanceId) {
          // 无实例 → 查最近实例(近 3 天),有则复用,无则新建
          const latest = await fetchLatestInstance(n.projectName, n.processId, 3)
          instanceId = latest?.instanceId
        }
        if (instanceId) {
          const d = await rerunWithRetry(
            () =>
              dsPost(
                `/projects/${encodeURIComponent(n.projectName)}/executors/execute`,
                { executeType: 'REPEAT_RUNNING', processInstanceId: instanceId }
              ),
            `${n.processName}(instance ${instanceId})`
          )
          results.push({ name: n.processName, ok: d?.code === 0, msg: d?.msg || 'success', instanceId })
          if (d?.code !== 0) console.warn(`[ds-deps] 重跑实例失败 ${n.processName}(instance ${instanceId}):`, d?.msg || JSON.stringify(d))
        } else {
          // 新建:START_PROCESS,按今天调度(完整时间格式,海豚要求)
          const now = new Date()
          const pad = (x) => String(x).padStart(2, '0')
          const scheduleTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
          const d = await rerunWithRetry(
            () =>
              dsPost(
                `/projects/${encodeURIComponent(n.projectName)}/executors/start-process-instance`,
                {
                  execType: 'START_PROCESS',
                  failureStrategy: 'CONTINUE',
                  processDefinitionId: n.processId,
                  scheduleTime,
                  warningType: 'NONE',
                  warningGroupId: '',
                  workerGroup: 'default',
                  runMode: 'RUN_MODE_SERIAL',
                  timeout: '',
                  receivers: '',
                  receiversCc: ''
                }
              ),
            `${n.processName}(新建实例)`
          )
          results.push({ name: n.processName, ok: d?.code === 0, msg: d?.msg || 'success', newInstance: true })
          if (d?.code !== 0) console.warn(`[ds-deps] 新建实例失败 ${n.processName}(def ${n.processId}):`, d?.msg || JSON.stringify(d))
        }
      } catch (e) {
        results.push({ name: n.processName, ok: false, msg: e.message })
      }
    }
    res.json({ code: 0, data: results })
  })

  // 从指定任务节点开始重跑工作流(节点级联)
  // body: { projectName, processInstanceId, startNodeId }
  router.post('/rerun-from-node', async (req, res) => {
    const { projectName, processInstanceId, startNodeId } = req.body || {}
    if (!projectName || !processInstanceId || !startNodeId) {
      return res.status(400).json({ code: 400, msg: '缺少参数' })
    }
    try {
      const d = await dsPost(
        `/projects/${encodeURIComponent(projectName)}/executors/start-process-instance`,
        {
          execType: 'START_FAILURE_TASK_PROCESS', // 从失败任务开始
          processInstanceId,
          startNodeList: startNodeId
        }
      )
      res.json({ code: d?.code === 0 ? 0 : 500, msg: d?.msg || 'success', data: d?.data })
    } catch (e) {
      res.status(500).json({ code: 500, msg: e.message })
    }
  })

  return router
}
