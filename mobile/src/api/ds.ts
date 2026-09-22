import { requestJson } from './request'
import type {
  DsExecuteType,
  DsPage,
  DsProcessInstance,
  DsProcessDefinition,
  DsProcessQuery,
  DsProject,
  DsSchedule,
  DsTaskInstance,
  DsTaskQuery
} from '../types/ds'

function instanceParams(query: DsTaskQuery | DsProcessQuery): URLSearchParams {
  const params = new URLSearchParams({ pageNo: String(query.pageNo), pageSize: String(query.pageSize) })
  if (query.stateType) params.set('stateType', query.stateType)
  if (query.startDate) params.set('startDate', query.startDate)
  if (query.endDate) params.set('endDate', query.endDate)
  return params
}

export async function listProjects(): Promise<DsProject[]> {
  const projects: DsProject[] = []
  const pageSize = 100
  for (let pageNo = 1; pageNo <= 10; pageNo += 1) {
    const page = await requestJson<DsPage<DsProject>>(
      `/dolphinscheduler/projects/list-paging?pageNo=${pageNo}&pageSize=${pageSize}`
    )
    projects.push(...page.totalList)
    if (page.totalList.length === 0 || projects.length >= page.total) break
  }
  return projects
}

export async function listWorkflows(projectName: string): Promise<DsProcessDefinition[]> {
  const workflows: DsProcessDefinition[] = []
  const pageSize = 100
  for (let pageNo = 1; pageNo <= 20; pageNo += 1) {
    const page = await requestJson<DsPage<DsProcessDefinition>>(
      `/dolphinscheduler/projects/${encodeURIComponent(projectName)}/process/list-paging?pageNo=${pageNo}&pageSize=${pageSize}&searchVal=`
    )
    workflows.push(...page.totalList)
    if (!page.totalList.length || workflows.length >= page.total) break
  }
  return workflows
}

export function getWorkflowDetail(projectName: string, processId: number): Promise<DsProcessDefinition> {
  return requestJson(
    `/dolphinscheduler/projects/${encodeURIComponent(projectName)}/process/select-by-id?processId=${processId}`
  )
}

export function listSchedules(projectName: string, processDefinitionId: number): Promise<DsPage<DsSchedule>> {
  const params = new URLSearchParams({ processDefinitionId: String(processDefinitionId), pageNo: '1', pageSize: '100', searchVal: '' })
  return requestJson(`/dolphinscheduler/projects/${encodeURIComponent(projectName)}/schedule/list-paging?${params}`)
}

function postForm<T>(path: string, values: Record<string, string | number>): Promise<T> {
  return requestJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)]))
  })
}

export function releaseWorkflow(projectName: string, processId: number, online: boolean): Promise<unknown> {
  return postForm(`/dolphinscheduler/projects/${encodeURIComponent(projectName)}/process/release`, {
    processId,
    releaseState: online ? 1 : 0
  })
}

export function startWorkflow(projectName: string, processId: number): Promise<unknown> {
  return postForm(`/dolphinscheduler/projects/${encodeURIComponent(projectName)}/executors/start-process-instance`, {
    processDefinitionId: processId,
    scheduleTime: '',
    failureStrategy: 'CONTINUE',
    warningType: 'NONE',
    warningGroupId: 0,
    execType: '',
    startNodeList: '',
    taskDependType: 'TASK_POST',
    runMode: 'RUN_MODE_SERIAL',
    processInstancePriority: 'MEDIUM',
    receivers: '',
    receiversCc: '',
    workerGroup: 'default'
  })
}

export function setScheduleState(projectName: string, scheduleId: number, online: boolean): Promise<unknown> {
  const action = online ? 'online' : 'offline'
  return postForm(`/dolphinscheduler/projects/${encodeURIComponent(projectName)}/schedule/${action}`, { id: scheduleId })
}

export function listTaskInstances(projectName: string, query: DsTaskQuery): Promise<DsPage<DsTaskInstance>> {
  const params = instanceParams(query)
  if (query.taskName) {
    params.set('taskName', query.taskName)
    params.set('searchVal', query.taskName)
  }
  return requestJson(`/dolphinscheduler/projects/${encodeURIComponent(projectName)}/task-instance/list-paging?${params}`)
}

export function listProcessInstances(
  projectName: string,
  query: DsProcessQuery
): Promise<DsPage<DsProcessInstance>> {
  const params = instanceParams(query)
  if (query.searchVal) params.set('searchVal', query.searchVal)
  return requestJson(`/dolphinscheduler/projects/${encodeURIComponent(projectName)}/instance/list-paging?${params}`)
}

export async function listTasksByProcess(projectName: string, processInstanceId: number): Promise<DsTaskInstance[]> {
  const data = await requestJson<{ taskList?: DsTaskInstance[] }>(
    `/dolphinscheduler/projects/${encodeURIComponent(projectName)}/instance/task-list-by-process-id?processInstanceId=${processInstanceId}`
  )
  return data.taskList ?? []
}

export function getTaskLog(taskInstanceId: number, skipLineNum = 0, limit = 500): Promise<string> {
  return requestJson(
    `/dolphinscheduler/log/detail?taskInstanceId=${taskInstanceId}&skipLineNum=${skipLineNum}&limit=${limit}`
  )
}

export async function executeProcess(
  projectName: string,
  processInstanceId: number,
  executeType: DsExecuteType
): Promise<void> {
  const params = new URLSearchParams({
    processInstanceId: String(processInstanceId),
    executeType
  })
  await requestJson(
    `/dolphinscheduler/projects/${encodeURIComponent(projectName)}/executors/execute?${params}`,
    { method: 'POST' }
  )
}
