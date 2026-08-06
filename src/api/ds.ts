/** 海豚调度(DolphinScheduler)API 封装,经网关 /dolphinscheduler 代理。
 *  认证由网关层完成:配置了 DS_TOKEN 时网关自动注入 token header(见 server/index.js),
 *  前端无需携带凭证;项目列表即该 token 用户可见的项目。 */

export interface DsProject {
  id: number
  name: string
  description?: string
  createTime?: string
  updateTime?: string
}

export interface DsTaskInstance {
  id: number
  name: string
  taskType: string
  state: string
  host: string
  workerGroup: string
  startTime: string
  endTime: string
  duration: number
  appLink: string
  executorName: string
  processInstanceName: string
  processInstanceId: number
  logPath: string
  retryTimes?: number
  maxRetryTimes?: number
  taskInstancePriority?: string
}

export interface DsTaskPage {
  totalList: DsTaskInstance[]
  total: number
  currentPage: number
  totalPage: number
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { code?: number; msg?: string; data?: T }
  if (data.code !== 0) throw new Error(data.msg || '查询失败')
  return data.data as T
}

/** 项目列表(当前 token 用户有权限的)。
 *  用 /projects/list-paging:该接口按认证用户过滤权限;
 *  /projects/query-project-list 返回全部项目(含无权限项目,选中后才报 30002)。 */
export async function listProjects(): Promise<DsProject[]> {
  const result: DsProject[] = []
  const pageSize = 100
  for (let pageNo = 1; pageNo <= 10; pageNo++) {
    const data = await request<DsPage<DsProject>>(
      `/dolphinscheduler/projects/list-paging?pageNo=${pageNo}&pageSize=${pageSize}`
    )
    const list = data.totalList ?? []
    result.push(...list)
    if (!list.length || result.length >= (data.total ?? 0)) break
  }
  return result
}

export interface TaskQuery {
  pageNo: number
  pageSize: number
  taskName?: string
  stateType?: string
  startDate?: string
  endDate?: string
}

/** 任务实例分页列表 */
export async function listTaskInstances(projectName: string, q: TaskQuery): Promise<DsTaskPage> {
  const params = new URLSearchParams({ pageNo: String(q.pageNo), pageSize: String(q.pageSize) })
  if (q.taskName) params.set('taskName', q.taskName)
  if (q.stateType) params.set('stateType', q.stateType)
  if (q.startDate) params.set('startDate', q.startDate)
  if (q.endDate) params.set('endDate', q.endDate)
  const url = `/dolphinscheduler/projects/${encodeURIComponent(projectName)}/task-instance/list-paging?${params}`
  return request<DsTaskPage>(url)
}

/** 工作流(流程)实例 */
export interface DsProcessInstance {
  id: number
  name: string
  state: string
  startTime: string
  endTime: string
  duration: number
  executorName: string
  host: string
  processDefinition?: { name?: string }
}

export interface DsPage<T> {
  totalList: T[]
  total: number
  currentPage: number
  totalPage: number
}

export interface ProcessQuery {
  pageNo: number
  pageSize: number
  searchVal?: string
  stateType?: string
  startDate?: string
  endDate?: string
}

/** 工作流实例分页列表 */
export async function listProcessInstances(projectName: string, q: ProcessQuery): Promise<DsPage<DsProcessInstance>> {
  const params = new URLSearchParams({ pageNo: String(q.pageNo), pageSize: String(q.pageSize) })
  if (q.searchVal) params.set('searchVal', q.searchVal)
  if (q.stateType) params.set('stateType', q.stateType)
  if (q.startDate) params.set('startDate', q.startDate)
  if (q.endDate) params.set('endDate', q.endDate)
  const url = `/dolphinscheduler/projects/${encodeURIComponent(projectName)}/instance/list-paging?${params}`
  return request<DsPage<DsProcessInstance>>(url)
}

/** 按工作流实例 ID 查其任务实例列表(data.taskList) */
export async function listTasksByProcess(projectName: string, processInstanceId: number): Promise<DsTaskInstance[]> {
  const url = `/dolphinscheduler/projects/${encodeURIComponent(projectName)}/instance/task-list-by-process-id?processInstanceId=${processInstanceId}`
  const data = await request<{ processInstanceState?: string; taskList?: DsTaskInstance[] }>(url)
  return data?.taskList ?? []
}

/** 执行工作流实例操作(REPEAT_RUNNING 重跑 / PAUSE 暂停 / STOP 停止 / RECOVER_SUSPENDED 恢复) */
export async function executeProcess(projectName: string, processInstanceId: number, executeType: string): Promise<void> {
  const url = `/dolphinscheduler/projects/${encodeURIComponent(projectName)}/executors/execute?processInstanceId=${processInstanceId}&executeType=${executeType}`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { code?: number; msg?: string }
  if (data.code !== 0) throw new Error(data.msg || '执行失败')
}

/** 任务实例日志 */
export async function getTaskLog(taskInstanceId: number, skipLineNum = 0, limit = 500): Promise<string> {
  const url = `/dolphinscheduler/log/detail?taskInstanceId=${taskInstanceId}&skipLineNum=${skipLineNum}&limit=${limit}`
  return request<string>(url)
}
