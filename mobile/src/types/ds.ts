export interface DsProject {
  id: number
  name: string
  description?: string
  createTime?: string
  updateTime?: string
}

export interface DsProcessDefinition {
  id: number
  name: string
  description?: string
  releaseState: string
  scheduleReleaseState?: string
  createUser?: string
  modifyUser?: string
  createTime?: string
  updateTime?: string
  processDefinitionJson?: string | { tasks?: Array<{ id?: string; name?: string; type?: string; taskType?: string }> }
  connects?: string | Array<{ endPointSourceId?: string; endPointTargetId?: string }>
  _projectName?: string
}

export interface DsSchedule {
  id: number
  processDefinitionId?: number
  processDefinitionName?: string
  releaseState: string
  crontab?: string
  startTime?: string
  endTime?: string
  workerGroup?: string
}

export interface DsPage<T> {
  totalList: T[]
  total: number
  currentPage: number
  totalPage: number
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
  _projectName?: string
}

export interface DsProcessInstance {
  id: number
  name: string
  state: string
  startTime: string
  endTime: string
  duration: number
  executorName: string
  host: string
  processDefinitionId?: number
  processDefinition?: { name?: string }
  _projectName?: string
}

export interface DsInstanceQuery {
  pageNo: number
  pageSize: number
  stateType?: string
  startDate?: string
  endDate?: string
}

export interface DsTaskQuery extends DsInstanceQuery {
  taskName?: string
}

export interface DsProcessQuery extends DsInstanceQuery {
  searchVal?: string
}

export type DsExecuteType = 'REPEAT_RUNNING' | 'PAUSE' | 'STOP' | 'RECOVER_SUSPENDED'
