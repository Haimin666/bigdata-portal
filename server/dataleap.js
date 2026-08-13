// DataLeap 实验模块:文件化数据开发平台(一个文件=一个节点,文件依赖=血缘)
// 独立于现有功能:独立存储 data/dleap/(docker 挂载 ./data:/app/data 持久化),
// 独立路由 /api/dataleap/*(由 index.js 挂载),不影响 /api/scripts 等现有模块。
// 发布管道为预览/序列化(mock),不触发任何真实 DS 操作。
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { exec } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import config from './config.js'

const DLEAP_DIR = path.join(path.dirname(import.meta.dirname), 'data', 'dleap')
const NODES_FILE = path.join(DLEAP_DIR, 'nodes.json')
const RUNS_FILE = path.join(DLEAP_DIR, 'runs.json')
const RUN_DIR = path.join(DLEAP_DIR, 'run')

const NODE_TYPES = ['sql', 'shell', 'spark']

function ensureStore() {
  fs.mkdirSync(DLEAP_DIR, { recursive: true })
  if (!fs.existsSync(NODES_FILE)) {
    fs.writeFileSync(NODES_FILE, JSON.stringify({ nodes: [] }, null, 2), 'utf-8')
  }
}

function loadNodes() {
  ensureStore()
  try {
    return JSON.parse(fs.readFileSync(NODES_FILE, 'utf-8')).nodes || []
  } catch {
    return []
  }
}

function saveNodes(nodes) {
  ensureStore()
  const tmp = NODES_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ nodes }, null, 2), 'utf-8')
  fs.renameSync(tmp, NODES_FILE)
}

/** 返回列表视图(不含 content,减体积) */
function loadRuns() {
  ensureStore()
  try {
    return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf-8')).runs || []
  } catch {
    return []
  }
}

function saveRuns(runs) {
  ensureStore()
  const tmp = RUNS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ runs }, null, 2), 'utf-8')
  fs.renameSync(tmp, RUNS_FILE)
}

function listView(nodes) {
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    project: n.project || '',
    deps: n.deps || [],
    cron: n.cron || '',
    db: n.db || '',
    dir: n.dir || '',
    updatedAt: n.updatedAt
  }))
}

function findNode(nodes, id) {
  return nodes.find((n) => n.id === id)
}

/** 环检测:从 start 出发沿 deps(依赖)是否回到 start。edges = 上游→下游 */
function wouldCreateCycle(nodes, startId, newDeps) {
  const graph = new Map()
  for (const n of nodes) graph.set(n.id, n.deps || [])
  graph.set(startId, newDeps)
  const visiting = new Set()
  const dfs = (id) => {
    if (visiting.has(id)) return true
    visiting.add(id)
    for (const d of graph.get(id) || []) {
      if (dfs(d)) return true
    }
    visiting.delete(id)
    return false
  }
  return dfs(startId)
}

/** 拓扑排序(DFS 后序):依赖在前,被依赖在后 */
function topoSort(nodes) {
  const order = []
  const state = new Map() // 0=未访问 1=访问中 2=完成
  const graph = new Map()
  for (const n of nodes) graph.set(n.id, n.deps || [])
  const cycles = []
  const dfs = (id, path) => {
    const s = state.get(id)
    if (s === 2) return
    if (s === 1) {
      const i = path.indexOf(id)
      if (i >= 0) cycles.push(path.slice(i).concat(id))
      return
    }
    state.set(id, 1)
    for (const d of graph.get(id) || []) dfs(d, path.concat(id))
    state.set(id, 2)
    order.push(id)
  }
  for (const n of nodes) dfs(n.id, [])
  return { order, cycles }
}


// ── 模块级执行辅助(router 与 cron 调度器共用)───────────────
function execShellN(script) {
  return new Promise((resolve) => {
    fs.mkdirSync(RUN_DIR, { recursive: true })
    const t0 = Date.now()
    exec(String(script || ''), {
      timeout: 30000,
      maxBuffer: 64 * 1024,
      shell: '/bin/sh',
      cwd: RUN_DIR,
      env: { ...process.env, PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }
    }, (err, stdout, stderr) => {
      resolve({
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        exitCode: typeof err?.code === 'number' ? err.code : 0,
        timedOut: !!err && (err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL'),
        costMs: Date.now() - t0
      })
    })
  })
}

async function proxyDbQueryN(db, sql) {
  if (!config.dbProxyUrl) throw new Error('db-proxy 未配置(DB_PROXY_URL empty)')
  const r = await fetch(config.dbProxyUrl + '/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DB-Token': config.dbProxyToken || '' },
    body: JSON.stringify({ db, sql, timeoutMs: 60000 }),
    signal: AbortSignal.timeout(65000)
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.detail || body.msg || `db-proxy HTTP ${r.status}`)
  return body.data || {}
}

async function proxySparkN(sql) {
  if (!config.dbProxyUrl) throw new Error('db-proxy 未配置(DB_PROXY_URL empty)')
  const r = await fetch(config.dbProxyUrl + '/spark/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DB-Token': config.dbProxyToken || '' },
    body: JSON.stringify({ kind: 'sql', sql, writeUnlocked: false, timeoutMs: 60000 }),
    signal: AbortSignal.timeout(65000)
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.detail || body.msg || `db-proxy HTTP ${r.status}`)
  return body.data || {}
}

/** 执行单个节点,返回 {ok, stdout, stderr, rows, error, costMs} */
async function runNode(n) {
  const t0 = Date.now()
  try {
    if (n.type === 'shell') {
      const r = await execShellN(n.content)
      return { ok: r.exitCode === 0 && !r.timedOut, stdout: r.stdout, stderr: r.stderr, costMs: r.costMs }
    }
    if (n.type === 'sql') {
      if (!n.db) throw new Error('未配置数据源')
      const r = await proxyDbQueryN(n.db, n.content)
      return { ok: true, rows: (r.rows || []).length, costMs: r.costMs }
    }
    if (n.type === 'spark') {
      const r = await proxySparkN(n.content)
      return { ok: true, rows: (r.rows || []).length, costMs: r.costMs }
    }
    return { ok: false, error: '未知类型' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), costMs: Date.now() - t0 }
  }
}

/** 记录执行历史(保留最近 200 条) */
function recordRun({ trigger, nodeName, nodeType, summary, ok, results }) {
  const runs = loadRuns()
  runs.unshift({ id: randomUUID(), ts: new Date().toISOString(), trigger, nodeName, nodeType, summary, ok, results })
  saveRuns(runs.slice(0, 200))
}

/** cron 5 字段匹配(分 时 日 月 周),支持 * 、,、-、/ */
function cronMatch(cron, date) {
  const parts = String(cron).trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [min, hour, dom, mon, dow] = parts
  const v = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()]
  return parts.every((expr, i) => fieldMatch(expr, v[i]))
}
function fieldMatch(expr, val) {
  for (const part of String(expr).split(',')) {
    const p = part.trim()
    if (p === '*') return true
    if (p.includes('/')) {
      const [base, step] = p.split('/')
      const b = base === '*' ? 0 : parseInt(base, 10)
      const s = parseInt(step, 10)
      if (s > 0 && val % s === b % s) return true
      continue
    }
    const range = p.match(/^(\d+)-(\d+)$/)
    if (range) {
      if (val >= parseInt(range[1], 10) && val <= parseInt(range[2], 10)) return true
      continue
    }
    if (parseInt(p, 10) === val) return true
  }
  return false
}

// ── cron 调度器(分钟级,完全本地,不接 DS)──────────────────
let schedulerTimer = null
let lastMinuteKey = ''
/** 每分钟检查一次节点 cron,匹配则按拓扑执行该节点(及其被依赖影响由 run/all 覆盖) */
async function schedulerTick() {
  const now = new Date()
  const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`
  if (key === lastMinuteKey) return
  lastMinuteKey = key
  const nodes = loadNodes()
  const targets = nodes.filter((n) => n.cron && cronMatch(n.cron, now))
  for (const n of targets) {
    try {
      const r = await runNode(n)
      recordRun({
        trigger: 'cron',
        nodeName: n.name,
        nodeType: n.type,
        summary: `${r.ok ? '成功' : '失败'} ${r.costMs != null ? r.costMs + 'ms' : ''}`,
        ok: r.ok,
        results: [{ id: n.id, name: n.name, type: n.type, ok: r.ok, ...r }]
      })
      console.log(`[dataleap] cron 执行 ${n.name}: ${r.ok ? '成功' : '失败'}`)
    } catch (e) {
      recordRun({ trigger: 'cron', nodeName: n.name, nodeType: n.type, summary: '调度执行异常', ok: false, results: [{ id: n.id, name: n.name, type: n.type, ok: false, error: String(e) }] })
    }
  }
}


// ── DS 工作流序列化(发布管道核心,纯函数可单测)─────────────
/** DS 工作流/任务名清洗:保留中文/字母/数字/下划线/中划线/点 */
function sanitizeDsName(n) {
  return String(n || '').replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 60) || 'task'
}

/** DataLeap 节点 → DS 工作流定义(processDefinitionJson + connects + locations)
 *  一个节点 = 一个 SHELL 任务;SQL 节点包装 spark-sql;依赖 = preTasks + connects */
export function buildDsWorkflow(nodes, name) {
  const { cycles } = topoSort(nodes)
  if (cycles.length) throw new Error(`存在依赖环,无法发布: ${cycles.map((c) => c.join(' → ')).join('; ')}`)
  const idMap = new Map()
  // DS 校验任务 id 必须为 tasks-{纯数字}(对照真实工作流 tasks-49317)
  nodes.forEach((n, i) => idMap.set(n.id, `tasks-${100000 + i}`))
  const taskDefs = nodes.map((n, i) => {
    const tid = idMap.get(n.id)
    const preTasks = (n.deps || []).map((d) => idMap.get(d)).filter(Boolean)
    let params
    if (n.type === 'sql') {
      const db = n.db ? `--database ${n.db} ` : ''
      const sql = String(n.content || '').replace(/"/g, '\\"').trim()
      params = { resourceList: [], localParams: [], rawScript: sql ? `spark-sql ${db}-e "${sql}"` : 'echo "empty sql"' }
    } else {
      params = { resourceList: [], localParams: [], rawScript: String(n.content || '') }
    }
    return {
      type: 'SHELL',
      id: tid,
      name: sanitizeDsName(n.name),
      params,
      description: '',
      timeout: { strategy: '', interval: null, enable: false },
      runFlag: 'NORMAL',
      conditionResult: { successNode: [''], failedNode: [''] },
      dependence: {},
      maxRetryTimes: '0',
      retryInterval: '1',
      taskInstancePriority: 'MEDIUM',
      workerGroup: 'default',
      preTasks
    }
  })
  const connects = nodes.flatMap((n) => (n.deps || []).map((d) => ({ endPointSourceId: idMap.get(d), endPointTargetId: idMap.get(n.id) })))
  const locations = {}
  nodes.forEach((n, i) => {
    const tid = idMap.get(n.id)
    locations[tid] = { name: sanitizeDsName(n.name), targetarr: '', nodenumber: '0', x: 120 + (i % 4) * 240, y: 120 + Math.floor(i / 4) * 180 }
  })
  return {
    name,
    processDefinitionJson: JSON.stringify({ globalParams: [], tasks: taskDefs, tenantId: 1, timeout: 0 }),
    connects: JSON.stringify(connects),
    locations: JSON.stringify(locations)
  }
}

/** 调 DS API(带 token) */
function dsRequest(method, pathname, queryParams = {}) {
  return new Promise((resolve, reject) => {
    const base = config.dsWebUrl || ''
    const qs = new URLSearchParams(queryParams).toString()
    const url = `${base}${pathname}${qs ? '?' + qs : ''}`
    const mod = url.startsWith('https://') ? https : http
    const req = mod.request(
      url,
      { method, headers: { token: config.dsToken || '' } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve({ code: -1, msg: `parse error: ${data.slice(0, 100)}` })
          }
        })
      }
    )
    req.on('error', (e) => reject(e))
    req.setTimeout(15000, () => req.destroy(new Error('DS 请求超时')))
    req.end()
  })
}

export function initDataleap() {
  if (schedulerTimer) return
  schedulerTimer = setInterval(() => void schedulerTick(), 30 * 1000).unref()
  console.log('[dataleap] cron 调度器已启动(30s 检查,分钟级触发)')
}

export function dataleapRouter() {
  const router = Router()

  // 节点列表(不含 content)
  router.get('/nodes', (_req, res) => {
    res.json({ code: 0, data: { nodes: listView(loadNodes()) } })
  })

  // 新建节点
  router.post('/nodes', (req, res) => {
    const { name, type = 'sql', project = '实验项目', content = '', cron = '', db = '', dir = '' } = req.body || {}
    const n = String(name || '').trim()
    if (!n) return res.status(400).json({ code: 400, msg: 'name 不能为空' })
    if (!NODE_TYPES.includes(type)) return res.status(400).json({ code: 400, msg: `type 必须为 ${NODE_TYPES.join('/')}` })
    const nodes = loadNodes()
    const node = {
      id: randomUUID(),
      name: n,
      type,
      project: String(project || '实验项目'),
      content: String(content || ''),
      deps: [],
      cron: String(cron || ''),
      db: String(db || ''),
      dir: String(dir || '').replace(/^\/+|\/+$/g, ''),
      updatedAt: new Date().toISOString()
    }
    nodes.push(node)
    saveNodes(nodes)
    res.json({ code: 0, data: { node: listView([node])[0] } })
  })

  // 节点详情(含 content)
  router.get('/nodes/:id', (req, res) => {
    const n = findNode(loadNodes(), req.params.id)
    if (!n) return res.status(404).json({ code: 404, msg: '节点不存在' })
    res.json({ code: 0, data: { node: { ...listView([n])[0], content: n.content } } })
  })

  // 更新节点(名称/类型/项目/内容/cron)
  router.put('/nodes/:id', (req, res) => {
    const nodes = loadNodes()
    const n = findNode(nodes, req.params.id)
    if (!n) return res.status(404).json({ code: 404, msg: '节点不存在' })
    const { name, type, project, content, cron, db, dir } = req.body || {}
    if (name !== undefined) n.name = String(name).trim() || n.name
    if (type !== undefined) {
      if (!NODE_TYPES.includes(type)) return res.status(400).json({ code: 400, msg: `type 必须为 ${NODE_TYPES.join('/')}` })
      n.type = type
    }
    if (project !== undefined) n.project = String(project)
    if (content !== undefined) n.content = String(content)
    if (cron !== undefined) n.cron = String(cron)
    if (db !== undefined) n.db = String(db)
    if (dir !== undefined) n.dir = String(dir).replace(/^\/+|\/+$/g, '')
    n.updatedAt = new Date().toISOString()
    saveNodes(nodes)
    res.json({ code: 0, data: { node: listView([n])[0] } })
  })

  // 删除节点(级联移除其他节点的依赖引用)
  router.delete('/nodes/:id', (req, res) => {
    const nodes = loadNodes()
    if (!findNode(nodes, req.params.id)) return res.status(404).json({ code: 404, msg: '节点不存在' })
    const next = nodes.filter((n) => n.id !== req.params.id).map((n) => ({
      ...n,
      deps: (n.deps || []).filter((d) => d !== req.params.id)
    }))
    saveNodes(next)
    res.json({ code: 0, data: { deleted: req.params.id } })
  })

  // 设置上游依赖(血缘边:dep → 本节点)。校验存在性 + 不成环
  router.put('/nodes/:id/deps', (req, res) => {
    const nodes = loadNodes()
    const n = findNode(nodes, req.params.id)
    if (!n) return res.status(404).json({ code: 404, msg: '节点不存在' })
    const deps = Array.isArray(req.body?.deps) ? [...new Set(req.body.deps.map(String))] : []
    for (const d of deps) {
      if (d === n.id) return res.status(400).json({ code: 400, msg: '不能依赖自身' })
      if (!findNode(nodes, d)) return res.status(400).json({ code: 400, msg: `上游节点不存在: ${d}` })
    }
    if (wouldCreateCycle(nodes, n.id, deps)) {
      return res.status(400).json({ code: 400, msg: '依赖关系会形成环,请检查' })
    }
    n.deps = deps
    n.updatedAt = new Date().toISOString()
    saveNodes(nodes)
    res.json({ code: 0, data: { node: listView([n])[0] } })
  })

  // 血缘图(节点 + 边 + 拓扑序 + 环检测)
  router.get('/graph', (_req, res) => {
    const nodes = loadNodes()
    const edges = []
    for (const n of nodes) {
      for (const d of n.deps || []) edges.push({ source: d, target: n.id })
    }
    const { order, cycles } = topoSort(nodes)
    res.json({
      code: 0,
      data: {
        nodes: listView(nodes),
        edges,
        topoOrder: order,
        cycles: cycles.map((c) => c.map((id) => findNode(nodes, id)?.name || id))
      }
    })
  })

  // Shell 节点执行(试水):在门户服务器上运行脚本内容
  // 安全约束:需登录(/api/dataleap 已在保护前缀);30s 超时自动 kill;输出截断 64KB
  router.post('/run/shell', async (req, res) => {
    const n = findNode(loadNodes(), req.body?.id)
    if (!n) return res.status(404).json({ code: 404, msg: '节点不存在' })
    if (n.type !== 'shell') return res.status(400).json({ code: 400, msg: '仅 Shell 节点可执行' })
    const script = String(n.content || '').trim()
    if (!script) return res.status(400).json({ code: 400, msg: '脚本内容为空' })
    const r = await execShellN(script)
    recordRun({
      trigger: 'single',
      nodeName: n.name,
      nodeType: n.type,
      summary: `exit=${r.exitCode}${r.timedOut ? ' 超时' : ''} ${r.costMs}ms`,
      ok: r.exitCode === 0 && !r.timedOut,
      results: [{ id: n.id, name: n.name, type: n.type, ok: r.exitCode === 0 && !r.timedOut, stdout: r.stdout, stderr: r.stderr, costMs: r.costMs }]
    })
    res.json({ code: 0, data: r })
  })

  // ── 依赖调度:按拓扑执行全部节点(本地串行,不接 DS)────────────
  // 按拓扑执行全部节点(串行;SQL/Spark 只读,Shell 本地执行;失败记录不中断后续)
  router.post('/run/all', async (req, res) => {
    const nodes = loadNodes()
    if (!nodes.length) return res.json({ code: 0, data: { results: [], message: '无节点' } })
    const { order, cycles } = topoSort(nodes)
    if (cycles.length) {
      return res.status(400).json({ code: 400, msg: `存在依赖环,无法执行: ${cycles.map((c) => c.join(' → ')).join('; ')}` })
    }
    const results = []
    for (const id of order) {
      const n = findNode(nodes, id)
      if (!n) continue
      const r = await runNode(n)
      results.push({ id, name: n.name, type: n.type, ...r })
    }
    const okCount = results.filter((r) => r.ok).length
    // 写入执行历史
    const runs = loadRuns()
    runs.unshift({
      id: randomUUID(),
      ts: new Date().toISOString(),
      trigger: 'topo',
      nodeName: '全部节点(按拓扑)',
      nodeType: 'topo',
      summary: `${okCount}/${results.length} 成功`,
      ok: okCount === results.length,
      results
    })
    saveRuns(runs.slice(0, 200))
    res.json({ code: 0, data: { results, message: `${okCount}/${results.length} 个节点执行成功` } })
  })

  // 执行历史(实例运维):筛选 trigger/status/节点名,含结果明细
  router.get('/runs', (req, res) => {
    let runs = loadRuns()
    const { trigger, status, keyword } = req.query
    if (trigger) runs = runs.filter((r) => r.trigger === trigger)
    if (status === 'ok') runs = runs.filter((r) => r.ok)
    if (status === 'fail') runs = runs.filter((r) => !r.ok)
    if (keyword) {
      const kw = String(keyword).toLowerCase()
      runs = runs.filter((r) => r.nodeName.toLowerCase().includes(kw) || (r.results || []).some((x) => String(x.name).toLowerCase().includes(kw)))
    }
    const limit = Math.min(Number(req.query.limit) || 100, 300)
    res.json({ code: 0, data: { runs: runs.slice(0, limit) } })
  })

  // 重跑某实例:按其结果明细重跑失败的节点(生成新实例,trigger='rerun')
  router.post('/runs/:id/rerun', async (req, res) => {
    const runs = loadRuns()
    const idx = runs.findIndex((r) => r.id === req.params.id)
    if (idx === -1) return res.status(404).json({ code: 404, msg: '实例不存在' })
    const src = runs[idx]
    const failed = (src.results || []).filter((x) => !x.ok)
    if (!failed.length) return res.status(400).json({ code: 400, msg: '该实例没有失败节点可重跑' })
    const nodes = loadNodes()
    const results = []
    for (const f of failed) {
      const n = findNode(nodes, f.id)
      if (!n) {
        results.push({ id: f.id, name: f.name, type: f.type, ok: false, error: '节点已删除,无法重跑' })
        continue
      }
      const r = await runNode(n)
      results.push({ id: n.id, name: n.name, type: n.type, ...r })
    }
    const okCount = results.filter((r) => r.ok).length
    recordRun({
      trigger: 'rerun',
      nodeName: `${src.nodeName}(失败重跑)`,
      nodeType: src.nodeType,
      summary: `${okCount}/${results.length} 成功`,
      ok: okCount === results.length,
      results
    })
    res.json({ code: 0, data: { results, message: `${okCount}/${results.length} 个失败节点重跑完成` } })
  })

  // 发布到 DS:统一创建到固定测试项目(默认 whm-test),不污染原始项目
  // 真实操作:创建 whm-test 下的工作流定义(不触发实例执行)
  router.post('/publish/ds', async (req, res) => {
    const nodes = loadNodes()
    if (!nodes.length) return res.json({ code: 0, data: { message: '无节点可发布' } })
    const project = config.dataleapPublishProject || 'whm-test'
    const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
    const wfName = `dleap_${ts}`
    let wf
    try {
      wf = buildDsWorkflow(nodes, wfName)
    } catch (e) {
      return res.status(400).json({ code: 400, msg: e.message })
    }
    try {
      console.log(`[dataleap] 发布到 DS: project=${project} name=${wf.name} nodes=${nodes.length}`)
      const d = await dsRequest('POST', `/projects/${encodeURIComponent(project)}/process/save`, {
        name: wf.name,
        connects: wf.connects,
        locations: wf.locations,
        processDefinitionJson: wf.processDefinitionJson,
        description: `DataLeap 发布 ${nodes.length} 个节点`
      })
      console.log(`[dataleap] DS 发布响应: code=${d?.code} msg=${d?.msg || ''}`)
      if (d?.code !== 0) {
        return res.status(500).json({ code: 500, msg: `DS 返回: ${d?.msg || JSON.stringify(d).slice(0, 200)}` })
      }
      res.json({
        code: 0,
        data: {
          message: `已发布到 DS 项目「${project}」,工作流: ${wf.name}(${nodes.length} 个任务)`,
          project,
          workflowName: wf.name,
          dsData: d?.data
        }
      })
    } catch (e) {
      res.status(502).json({ code: 502, msg: `DS 发布失败: ${e instanceof Error ? e.message : e}` })
    }
  })

  // 发布预览:按依赖拓扑生成 DS 工作流序列化(mock,不触发真实操作)
  // 一个文件 = 一个 DS 任务节点;依赖 = DS 任务连线;返回可预览的 JSON/文本
  router.post('/publish/preview', (req, res) => {
    const nodes = loadNodes()
    if (!nodes.length) return res.json({ code: 0, data: { message: '无节点可发布', workflow: null } })
    const { order, cycles } = topoSort(nodes)
    if (cycles.length) {
      return res.status(400).json({ code: 400, msg: `存在依赖环,无法发布: ${cycles.map((c) => c.join(' → ')).join('; ')}` })
    }
    // 序列化为 DS 风格工作流:任务 = 节点,连线 = deps(上游→本节点)
    const tasks = nodes.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type.toUpperCase() === 'SQL' ? 'SQL' : n.type.toUpperCase() === 'SPARK' ? 'SPARK' : 'SHELL',
      rawScript: n.content,
      deps: n.deps || []
    }))
    // 执行顺序 = 拓扑序(先上游)
    const execOrder = order.map((id) => findNode(nodes, id)?.name || id)
    res.json({
      code: 0,
      data: {
        message: `共 ${tasks.length} 个任务,按依赖拓扑执行: ${execOrder.join(' → ')}`,
        workflow: {
          name: `dleap_${Date.now()}`,
          tasks,
          edges: nodes.flatMap((n) => (n.deps || []).map((d) => ({ source: d, target: n.id })))
        }
      }
    })
  })

  return router
}
