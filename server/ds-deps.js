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
import config from './config.js'

// ── 配置 ──────────────────────────────────────────────────────
// 复用网关配置(ds-deps 直连海豚需带 token;仅服务器手动刷新时使用)
const DS_BASE = config.dsWebUrl
const DS_TOKEN = config.dsToken || ''
// 缓存文件路径(默认项目根 data/;docker 挂载 /app/data)
const CACHE_FILE = config.dsDepsCacheFile
// 定时刷新周期(毫秒,默认 1h)
const REFRESH_INTERVAL = config.dsDepsRefreshInterval
// 采集并发数
const CONCURRENCY = 10

// ── 数据模型 ──────────────────────────────────────────────────
// node: 一个工作流定义(仅缓存定时状态为 ONLINE 的工作流)
// {
//   projectId, projectName, processId, processName,
//   creator, modifier,                    // 创建人/修改人
//   releaseState, scheduleReleaseState,   // 发布状态/定时状态
//   lastUpdateTime,                       // 最后修改时间
//   tasks: [{id, name, type}],            // 工作流内任务节点
//   connects: [{from, to}],               // 任务 DAG 边
//   upstream: [{projectId, processId, taskName}]  // 工作流间依赖(DEPENDENT → 上游)
// }

let cache = {
  updatedAt: null,
  nodes: new Map() // processId → node
}

// ── 实例状态日级缓存 ──────────────────────────────────────────
// 成功实例缓存到当天结束,次日自动过期;减少对海豚 API 的请求。
// key: `${projectName}|${processId}`;value: {instance(可能为 null=当天无实例), date, _ts, _ttlMs}
//  - SUCCESS 实例:长 TTL(到当天结束),当天复用不再请求
//  - 确认"当天无实例"(null):短 TTL(默认 60s),既减少重复请求,又不至于一直滞后
const instanceCache = new Map()
const NO_INSTANCE_TTL = 60 * 1000 // 无实例结果缓存 60s,避免反复打海豚
function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function getCachedInstance(projectName, processId) {
  const k = `${projectName}|${processId}`
  const c = instanceCache.get(k)
  if (!c) return { found: false, instance: null }
  // 跨天失效 或 TTL 过期 → 清除
  const expired = c.date !== todayKey() || Date.now() - c._ts > c._ttlMs
  if (expired) {
    instanceCache.delete(k)
    return { found: false, instance: null }
  }
  return { found: true, instance: c.instance }
}
function setCachedInstance(projectName, processId, instance, ttlMs) {
  const k = `${projectName}|${processId}`
  instanceCache.set(k, { instance, date: todayKey(), _ts: Date.now(), _ttlMs: ttlMs })
}
// 当天剩余毫秒(到 23:59:59.999),用于成功实例的长 TTL
function msUntilEndOfDay() {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  return Math.max(end.getTime() - now.getTime(), 1000)
}

// ── HTTP 工具(直连海豚,带 token)────────────────────────────
// 响应体大小上限(防异常大响应耗尽内存)
const MAX_RESP_BYTES = 10 * 1024 * 1024

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
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > MAX_RESP_BYTES) {
            res.destroy(new Error(`DS 响应过大(>${MAX_RESP_BYTES} bytes),已中止`))
            return
          }
          data += c
        })
        res.on('error', (e) => reject(e))
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
  // 分页拉全量工作流列表,返回扩展字段含创建人/修改人/状态/定时状态/最后修改时间
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
      out.push({
        id: p.id,
        name: p.name,
        releaseState: p.releaseState,
        scheduleReleaseState: p.scheduleReleaseState,
        creator: p.createUser || p.creator || '',
        modifier: p.modifyUser || p.modifier || '',
        lastUpdateTime: p.updateTime || p.lastUpdateTime || null
      })
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
  // 2. 每项目的工作流列表(收集 processId + 名称 + 扩展字段)
  const allWorkflows = [] // {projectId, projectName, id, name, creator, modifier, lastUpdateTime}
  const crontabMap = new Map() // processDefinitionId → crontab(调度列表收集,全局合并)
  for (const p of projects) {
    try {
      const flows = await fetchAllProcessIds(p.name)
      for (const f of flows) {
        // 只缓存"定时任务已上线"的工作流(scheduleReleaseState=ONLINE):
        // 手动执行/定时未上线的工作流不会自动被拉起,不纳入依赖树/级联重跑
        // (releaseState=ONLINE 只表示工作流定义发布,不代表定时启用)
        if (String(f.scheduleReleaseState).toUpperCase() !== 'ONLINE') continue
        allWorkflows.push({
          projectId: p.id,
          projectName: p.name,
          processId: f.id,
          processName: f.name,
          creator: f.creator,
          modifier: f.modifier,
          lastUpdateTime: f.lastUpdateTime
        })
      }
      // 每项目拉一次调度列表,收集 crontab 映射(processDefinitionId → crontab)
      // 避免逐个工作流查调度(2344 次),每项目 1 次即可(156 次)
      const schedMap = new Map()
      try {
        let sp = 1
        for (;;) {
          const sd = await dsApi(`/projects/${encodeURIComponent(p.name)}/schedule/list-paging`, {
            pageNo: sp,
            pageSize: 100
          })
          const sl = sd?.data?.totalList || []
          for (const s of sl) {
            const did = s.processDefinitionCode || s.processDefinitionId
            if (did) schedMap.set(String(did), s.crontab || null)
          }
          if (!sl.length || sl.length < 100) break
          sp++
          if (sp > 20) break
        }
      } catch {
        /* 调度列表失败不影响 */
      }
      // 合并到全局 crontab 映射(不是覆盖)
      for (const [k, v] of schedMap) crontabMap.set(k, v)
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
            creator: wf.creator,
            modifier: wf.modifier,
            releaseState: 'ONLINE',
            scheduleReleaseState: 'ONLINE',
            lastUpdateTime: wf.lastUpdateTime,
            crontab: crontabMap.get(String(wf.processId)) || null,
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

/** 本地时段时间串 YYYY-MM-DD HH:mm:ss */
function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 查某工作流当天最新一次执行实例(按 processDefinitionCode 精准匹配 + 取 startTime 最新一条)。
 * 不传 dates 时默认查当天;成功实例会进入日级缓存,减少海豚 API 请求。
 */
async function fetchLatestInstance(projectName, processName, processId, dates = null) {
  // 1. 检查日级缓存(成功实例长 TTL 当天复用;"当天无实例"短 TTL 60s 复用)
  const cached = getCachedInstance(projectName, processId)
  if (cached.found) return cached.instance

  try {
    const now = new Date()
    let start, end
    if (dates && dates.start && dates.end) {
      start = dates.start
      end = dates.end
    } else {
      // 默认:当天 00:00:00 → 现在
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const p = (n) => String(n).padStart(2, '0')
      start = `${todayStart.getFullYear()}-${p(todayStart.getMonth() + 1)}-${p(todayStart.getDate())} 00:00:00`
      end = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
    }
    // 不传 searchVal,拉当天实例后用 processDefinitionId 精准匹配
    // 注意:该海豚实例接口的 processDefinitionCode=null,只有 processDefinitionId 可用;
    // 不依赖 processDefinitionCode,避免该字段一旦返回大整数 code 导致匹配失败(静默全 null)。
    // pageSize 取大(500):多天实例可能 >50,截断会导致漏匹配而误判"未执行"。
    const qs = { pageNo: 1, pageSize: 500, startDate: start, endDate: end }
    const d = await dsApi(
      `/projects/${encodeURIComponent(projectName)}/instance/list-paging`,
      qs
    )
    const list = d?.data?.totalList || []
    if (!list.length) {
      // 当天该工作流确实无实例(项目当天无任何实例)→ 短 TTL 缓存 null,减少重复请求
      setCachedInstance(projectName, processId, null, NO_INSTANCE_TTL)
      return null
    }
    // 按 processDefinitionId 精准匹配目标工作流,取 startTime 最新的一条
    const idStr = String(processId || '')
    let best = null
    let bestTime = ''
    for (const i of list) {
      // 优先 processDefinitionId(小整数,与缓存 processId 一致);防御性地兼容 processDefinitionCode
      const id = String(i.processDefinitionId || '')
      const code = String(i.processDefinitionCode || '')
      if (id !== idStr && code !== idStr) continue
      const st = i.startTime || ''
      if (!best || st > bestTime) {
        best = i
        bestTime = st
      }
    }
    if (!best) {
      // 有实例但都不属于该工作流:可能因列表截断没取到,也可能是真的没跑。
      // 不写 null 缓存——若是截断漏匹配,写入会固化错误"未执行";下次标注会再实时查。
      return null
    }
    const instance = {
      instanceId: best.id,
      name: best.name,
      state: best.state,
      startTime: best.startTime || null,
      endTime: best.endTime || null,
      duration: typeof best.duration === 'number' ? best.duration : null
    }
    // SUCCESS 实例进入日级缓存(到当天结束;次日自动过期)
    if (best.state === 'SUCCESS') {
      setCachedInstance(projectName, processId, instance, msUntilEndOfDay())
    }
    return instance
  } catch (e) {
    console.warn(`[ds-deps] fetchLatestInstance 失败 ${projectName}/${processName}(pid=${processId}): ${e.message}`)
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
  // 启动:加载缓存文件 + 定时全量刷新(默认每天一次,可配置)。
  // 依赖数据更新频率不高(工作流/依赖结构变化少),无需频繁全量扫描 4000+ 工作流。
  // 手动刷新入口:/api/ds-deps/refresh(全量)或 ?processId=xxx(单工作流,可随时触发)
  load()

  // 首次后台全量采集:保证服务启动后有最新依赖数据(等 3s 错开启动高峰)
  setTimeout(() => {
    if (!collecting) collect().catch((e) => console.error('[ds-deps] 启动采集失败:', e.message))
  }, 3000)

  // 定时全量刷新(默认每天一次;加锁防与手动刷新重入)
  setInterval(() => {
    if (collecting) return
    collect().catch((e) => console.error('[ds-deps] 定时刷新失败:', e.message))
  }, REFRESH_INTERVAL)
}

/**
 * 给依赖树上下游节点标注"当天最新一次"实例状态(成功/失败/运行中/无实例)。
 * 采用"按项目聚合"优化:一次请求拉取某项目当天全部实例,本地按 processDefinitionId
 * 批量匹配该项目的所有节点,而不是每节点一次请求(树大时请求数从几十次降到项目数)。
 */
async function annotateWorkflowTree(tree, dates = null) {
  // 1. 收集树中所有去重节点(含当前节点) → 按 projectName 分组
  const nodesById = new Map() // `${project}|${processId}` → 节点引用
  const collect = (list) => {
    for (const n of list || []) {
      const k = `${n.projectName}|${n.processId}`
      if (!nodesById.has(k)) nodesById.set(k, n)
      collect(n.upstream)
      collect(n.downstream)
    }
  }
  collect(tree.upstream)
  collect(tree.downstream)
  // 加当前节点
  const selfKey = `${tree.projectName}|${tree.processId}`
  if (!nodesById.has(selfKey)) nodesById.set(selfKey, tree)

  // 2. 按项目分组,每组只发一次"当天实例列表"请求(处理翻页)
  const byProject = new Map()
  for (const n of nodesById.values()) {
    if (!byProject.has(n.projectName)) byProject.set(n.projectName, [])
    byProject.get(n.projectName).push(n)
  }

  // 3. 并发拉取各项目当天实例列表(限并发),再本地批量匹配
  const projectList = [...byProject.entries()]
  const instancesByProject = new Map() // projectName → 当天实例数组
  const CONCURRENCY = 6
  let cursor = 0
  const worker = async () => {
    while (cursor < projectList.length) {
      const [projectName] = projectList[cursor++]
      // loadProjectInstances 内部已 try-catch + 缓存回退,不会抛错
      const list = await loadProjectInstances(projectName, dates)
      instancesByProject.set(projectName, list)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, projectList.length) }, worker))

  // 4. 本地批量匹配赋值;SUCCESS 实例写回日级缓存(到当天结束),供单节点查询/同树复用,
  //    非 SUCCESS(失败/运行中)不缓存实时查;无实例不缓存(避免截断误判固化)
  for (const n of nodesById.values()) {
    const list = instancesByProject.get(n.projectName) || []
    const inst = matchLatestInstance(list, n.processId)
    if (inst) {
      n.instance = inst
      // 仅 SUCCESS 进日级缓存(当天结束自动过期)
      if (inst.state === 'SUCCESS') {
        setCachedInstance(n.projectName, n.processId, inst, msUntilEndOfDay())
      }
    } else {
      n.instance = null
    }
    // 补 crontab(每天执行时间)
    const node = findNode(n.processId)
    n.crontab = node?.crontab || null
  }
  return tree
}

/**
 * 拉取某项目指定日期区间内全部实例(翻页合并,pageSize=500)。dates 为 null 时用当天 00:00→现在。
 * 返回:实例数组(totalList 合并)。
 * 加"项目级当天实例列表"短缓存(60s):同一棵树多个节点同项目只需拉一次;海豚偶发失败时回退缓存,
 * 避免整批节点因单次请求失败被误判"未执行"。
 */
const projectInstanceCache = new Map() // `${project}|${dateKey}` → {instances, _ts}
const PROJECT_INSTANCE_TTL = 60 * 1000
async function loadProjectInstances(projectName, dates = null) {
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  let start, end
  if (dates && dates.start && dates.end) {
    start = dates.start
    end = dates.end
  } else {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    start = `${todayStart.getFullYear()}-${p(todayStart.getMonth() + 1)}-${p(todayStart.getDate())} 00:00:00`
    end = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
  }
  const dayKey = start.slice(0, 10) // YYYY-MM-DD
  const ck = `${projectName}|${dayKey}`

  // 命中短缓存(60s 内):直接复用
  const hit = projectInstanceCache.get(ck)
  if (hit && Date.now() - hit._ts < PROJECT_INSTANCE_TTL) return hit.instances

  try {
    const out = []
    const pageSize = 500
    for (let pageNo = 1; pageNo <= 5; pageNo++) {
      const d = await dsApi(`/projects/${encodeURIComponent(projectName)}/instance/list-paging`, {
        pageNo,
        pageSize,
        startDate: start,
        endDate: end
      })
      const list = d?.data?.totalList || []
      const total = d?.data?.total || 0
      out.push(...list)
      if (out.length >= total || list.length < pageSize) break
    }
    projectInstanceCache.set(ck, { instances: out, _ts: Date.now() })
    return out
  } catch (e) {
    // 拉取失败:回退短缓存(若有),否则返回空(不阻断树)
    const fallback = projectInstanceCache.get(ck)
    console.warn(`[ds-deps] loadProjectInstances 失败 ${projectName}: ${e.message}`)
    return fallback ? fallback.instances : []
  }
}

/** 在某项目实例列表里匹配指定 processDefinitionId 的最新(按 startTime)一条,转成 instance 结构;没匹配到返回 null */
function matchLatestInstance(list, processId) {
  const idStr = String(processId || '')
  let best = null
  let bestTime = ''
  for (const i of list || []) {
    const id = String(i.processDefinitionId || '')
    const code = String(i.processDefinitionCode || '')
    if (id !== idStr && code !== idStr) continue
    const st = i.startTime || ''
    if (!best || st > bestTime) {
      best = i
      bestTime = st
    }
  }
  if (!best) return null
  return {
    instanceId: best.id,
    name: best.name,
    state: best.state,
    startTime: best.startTime || null,
    endTime: best.endTime || null,
    duration: typeof best.duration === 'number' ? best.duration : null
  }
}

/**
 * 从请求 query 解析日期区间。前端可传:
 *  - query.days=N        → 近 N 天(截止现在)
 *  - query.start & end   → 指定 start→end(YYYY-MM-DD[ HH:mm:ss])
 * 都不传 → 返回 null(默认近 90 天最近一次)
 */
function parseDates(query = {}) {
  if (query.start && query.end) {
    return { start: String(query.start).trim(), end: String(query.end).trim() }
  }
  if (query.days) {
    const now = new Date()
    const d = Number(query.days)
    const start = new Date(now.getTime() - (d > 0 ? d : 1) * 86400000)
    const p = (x) => String(x).padStart(2, '0')
    return {
      start: `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())} 00:00:00`,
      end: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
    }
  }
  return null
}

// ── Express 路由 ──────────────────────────────────────────────
export function dsDepsRouter() {
  const router = Router()

  // 依赖树(工作流级):最上游→当前→最下游,下游节点附最近实例状态
  // 支持 ?start=YYYY-MM-DD HH:mm:ss&end=... 指定日期区间(否则默认近 90 天最近一次)
  router.get('/workflow-tree/:processId', async (req, res) => {
    const tree = buildFullTree(req.params.processId)
    if (!tree) return res.status(404).json({ code: 404, msg: '工作流不在依赖缓存中' })
    const dates = parseDates(req.query)
    await annotateWorkflowTree(tree, dates)
    res.json({ code: 0, data: tree, updatedAt: cache.updatedAt })
  })

  // 任务实例 → 其所属工作流定义 id → 依赖树:按 processInstanceId 反查所属工作流,再返回其上下游依赖树(当天最新实例状态)
  router.get('/workflow-tree-by-instance/:projectName/:processInstanceId', async (req, res) => {
    const { projectName, processInstanceId } = req.params
    let processId = null
    try {
      const detail = await dsApi(
        `/projects/${encodeURIComponent(projectName)}/instance/query-by-id`,
        { processInstanceId }
      )
      const d = detail?.data || {}
      processId = d.processDefinitionCode || d.processDefinitionId || null
    } catch {
      /* 反查失败按无处理 */
    }
    if (!processId) return res.status(404).json({ code: 404, msg: '无法定位该实例所属工作流' })
    const tree = buildFullTree(processId)
    if (!tree) return res.status(404).json({ code: 404, msg: '工作流不在依赖缓存中' })
    const dates = parseDates(req.query)
    await annotateWorkflowTree(tree, dates)
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
          return res.json({ code: 0, data: { msg: '刷新成功' } })
        }
        return res.status(500).json({ code: 500, msg: '刷新失败' })
      } catch (e) {
        return res.status(500).json({ code: 500, msg: e.message })
      }
    }
    // 全量刷新(异步触发,立即返回;加锁防并发重复采集)
    if (collecting) {
      return res.json({ code: 0, data: { msg: '全量刷新进行中,请稍后' } })
    }
    collect().catch((e) => console.error('[ds-deps] 手动全量刷新失败:', e.message))
    res.json({ code: 0, data: { msg: '全量刷新已触发' } })
  })

  // 缓存状态(不暴露服务器绝对路径)
  router.get('/status', (req, res) => {
    res.json({
      code: 0,
      data: {
        updatedAt: cache.updatedAt,
        count: cache.nodes.size,
        instanceCacheCount: instanceCache.size,
        collecting
      }
    })
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
          // 无实例 → 查近 90 天最近实例,有则复用,无则按今天新建
          const now = new Date()
          const p = (n) => String(n).padStart(2, '0')
          const start90 = new Date(now.getTime() - 90 * 86400000)
          const dates90 = {
            start: `${start90.getFullYear()}-${p(start90.getMonth() + 1)}-${p(start90.getDate())} 00:00:00`,
            end: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
          }
          const latest = await fetchLatestInstance(n.projectName, n.processName, n.processId, dates90)
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
