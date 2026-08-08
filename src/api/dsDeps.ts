// 工作流依赖采集与级联重跑 API(/api/ds-deps)

export interface DepNode {
  processId: number
  processName: string
  projectName: string
  depTask?: string
  depTasks?: string
  upstream?: DepNode[]
  downstream?: DepNode[]
  /** 下游节点最近实例(有则显示状态/可重跑) */
  instance?: { instanceId: number; name: string; state: string } | null
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

/** 工作流级依赖树(最上游→当前→最下游) */
export function fetchWorkflowTree(processId: number): Promise<WorkflowTree> {
  return get(`/workflow-tree/${processId}`)
}

/** 工作流内任务 DAG */
export function fetchTaskGraph(processId: number): Promise<TaskGraph> {
  return get(`/task-graph/${processId}`)
}

/** 手动刷新依赖(全量或单工作流) */
export function refreshDeps(processId?: number): Promise<{ msg: string }> {
  return post(processId ? `/refresh?processId=${processId}` : '/refresh', {})
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
