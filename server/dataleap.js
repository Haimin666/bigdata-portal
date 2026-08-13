// DataLeap 实验模块:文件化数据开发平台(一个文件=一个节点,文件依赖=血缘)
// 独立于现有功能:独立存储 data/dleap/(docker 挂载 ./data:/app/data 持久化),
// 独立路由 /api/dataleap/*(由 index.js 挂载),不影响 /api/scripts 等现有模块。
// 发布管道为预览/序列化(mock),不触发任何真实 DS 操作。
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { exec } from 'node:child_process'
import config from './config.js'

const DLEAP_DIR = path.join(path.dirname(import.meta.dirname), 'data', 'dleap')
const NODES_FILE = path.join(DLEAP_DIR, 'nodes.json')
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
function listView(nodes) {
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    project: n.project || '',
    deps: n.deps || [],
    cron: n.cron || '',
    db: n.db || '',
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

export function dataleapRouter() {
  const router = Router()

  // 节点列表(不含 content)
  router.get('/nodes', (_req, res) => {
    res.json({ code: 0, data: { nodes: listView(loadNodes()) } })
  })

  // 新建节点
  router.post('/nodes', (req, res) => {
    const { name, type = 'sql', project = '实验项目', content = '', cron = '', db = '' } = req.body || {}
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
    const { name, type, project, content, cron, db } = req.body || {}
    if (name !== undefined) n.name = String(name).trim() || n.name
    if (type !== undefined) {
      if (!NODE_TYPES.includes(type)) return res.status(400).json({ code: 400, msg: `type 必须为 ${NODE_TYPES.join('/')}` })
      n.type = type
    }
    if (project !== undefined) n.project = String(project)
    if (content !== undefined) n.content = String(content)
    if (cron !== undefined) n.cron = String(cron)
    if (db !== undefined) n.db = String(db)
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
  router.post('/run/shell', (req, res) => {
    const n = findNode(loadNodes(), req.body?.id)
    if (!n) return res.status(404).json({ code: 404, msg: '节点不存在' })
    if (n.type !== 'shell') return res.status(400).json({ code: 400, msg: '仅 Shell 节点可执行' })
    const script = String(n.content || '').trim()
    if (!script) return res.status(400).json({ code: 400, msg: '脚本内容为空' })
    fs.mkdirSync(RUN_DIR, { recursive: true })
    const t0 = Date.now()
    exec(script, {
      timeout: 30000,
      maxBuffer: 64 * 1024,
      shell: '/bin/sh',
      cwd: RUN_DIR,
      env: { ...process.env, PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }
    }, (err, stdout, stderr) => {
      const killed = !!err && (err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL')
      res.json({
        code: 0,
        data: {
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          exitCode: typeof err?.code === 'number' ? err.code : 0,
          timedOut: killed,
          costMs: Date.now() - t0
        }
      })
    })
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
