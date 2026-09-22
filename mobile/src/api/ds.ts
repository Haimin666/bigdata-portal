import { requestJson } from './request'
import type {
  DsExecuteType,
  DsPage,
  DsProcessInstance,
  DsProcessQuery,
  DsProject,
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

export function listTaskInstances(projectName: string, query: DsTaskQuery): Promise<DsPage<DsTaskInstance>> {
  const params = instanceParams(query)
  if (query.taskName) params.set('taskName', query.taskName)
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
