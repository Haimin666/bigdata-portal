export interface DsProject {
  id: number
  name: string
  description?: string
  createTime?: string
  updateTime?: string
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
