// 工作流依赖采集与级联重跑 API(/api/ds-deps)

export interface DepNode {
  processId: number
  processName: string
  projectName: string
  creator?: string
  modifier?: string
  releaseState?: string
  scheduleReleaseState?: string
  lastUpdateTime?: string | null
  depTask?: string
  depTasks?: string
  upstream?: DepNode[]
  downstream?: DepNode[]
  /** 下游节点最近实例(有则显示状态/可重跑) */
  instance?: { instanceId: number; name: string; state: string; startTime?: string | null; endTime?: string | null; duration?: number | null } | null
  /** 定时调度 crontab(每天执行时间,如 '0 3 * * *') */
  crontab?: string | null
}

export interface WorkflowTree {
  processId: number
  processName: string
  projectName: string
  upstream: DepNode[]
  downstream: DepNode[]
}

export interface TaskGraphTask {
  id: string
  name: string
  type?: string
}

export interface TaskGraphConnect {
  from: string
  to: string
}

export interface TaskGraph {
  processId: number
  processName: string
  projectName: string
  tasks: TaskGraphTask[]
  connects: TaskGraphConnect[]
}

interface ApiResp<T> {
  code: number
  msg?: string
  data?: T
  updatedAt?: string
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/ds-deps${path}`)
  const body = (await res.json()) as ApiResp<T>
  if (body.code !== 0) throw new Error(body.msg || `HTTP ${res.status}`)
  return body.data as T
}

async function post<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`/api/ds-deps${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const body = (await res.json()) as ApiResp<T>
  if (body.code !== 0) throw new Error(body.msg || `HTTP ${res.status}`)
  return body.data as T
}

/** 工作流级依赖树(最上游→当前→最下游),可指定日期区间(默认近 90 天最近一次) */
export function fetchWorkflowTree(processId: number, dates?: { start?: string; end?: string; days?: number }): Promise<WorkflowTree> {
  const q = dates ? buildDateQuery(dates) : ''
  return get(`/workflow-tree/${processId}${q}`)
}

/** 任务实例 → 其所属工作流的依赖树(按 processInstanceId 反查),可指定日期区间 */
export function fetchWorkflowTreeByInstance(projectName: string, processInstanceId: number, dates?: { start?: string; end?: string; days?: number }): Promise<WorkflowTree> {
  const q = dates ? buildDateQuery(dates) : ''
  return get(`/workflow-tree-by-instance/${encodeURIComponent(projectName)}/${processInstanceId}${q}`)
}

/** 把日期区间拼成 query 串(days / start+end) */
function buildDateQuery(dates: { start?: string; end?: string; days?: number }): string {
  const p = new URLSearchParams()
  if (dates.days) p.set('days', String(dates.days))
  if (dates.start) p.set('start', dates.start)
  if (dates.end) p.set('end', dates.end)
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** 工作流内任务 DAG */
export function fetchTaskGraph(processId: number): Promise<TaskGraph> {
  return get(`/task-graph/${processId}`)
}

/** 手动刷新依赖(全量或单工作流) */
export function refreshDeps(processId?: number): Promise<{ msg: string }> {
  return post(processId ? `/refresh?processId=${processId}` : '/refresh', {})
}

/** 缓存状态 */
export interface DepsStatus {
  updatedAt: string | null
  count: number
  instanceCacheCount: number
  collecting: boolean
}
export function fetchDepsStatus(): Promise<DepsStatus> {
  return get('/status')
}

/** 批量重跑工作流实例 */
export interface RerunItem {
  projectName: string
  instanceId: number
  name: string
}
export interface RerunResult {
  name: string
  ok: boolean
  msg: string
  instanceId?: number
  newInstance?: boolean
  /** 级联接口后端回带,用于结果表展示 */
  projectName?: string
  processName?: string
}
export function rerunInstances(instances: RerunItem[]): Promise<RerunResult[]> {
  return post('/rerun-instances', { instances })
}

/** 级联重跑:节点有实例重跑,无实例按今天新建 */
export interface CascadeNode {
  projectName: string
  processId: number
  processName: string
  instanceId?: number
}
export function rerunCascade(nodes: CascadeNode[]): Promise<RerunResult[]> {
  return post('/rerun-cascade', { nodes })
}

/** 跨项目搜索工作流(按工作流名/任务名/项目名) */
export interface WorkflowHit {
  projectId: number
  projectName: string
  processId: number
  processName: string
  matchedTask: string
}
export function searchWorkflows(keyword: string): Promise<WorkflowHit[]> {
  return get(`/search-workflows?keyword=${encodeURIComponent(keyword)}`)
}

/** 从指定节点重跑 */
export function rerunFromNode(payload: {
  projectName: string
  processInstanceId: number
  startNodeId: string
}): Promise<unknown> {
  return post('/rerun-from-node', payload)
}
