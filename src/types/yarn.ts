export interface YarnApp {
  id: string
  name: string
  state: string
  finalStatus: string
  user: string
  queue: string
  applicationType: string
  applicationTags: string
  startedTime: number
  finishedTime: number
  elapsedTime: number
  amHostHttpAddress: string
  amRPCAddress: string
  allocatedVCores: number
  allocatedMB: number
  runningContainers: number
  queueUsagePercentage: number
  memorySeconds: number
  vcoreSeconds: number
  clusterUsagePercentage: number
  preemptedResourceMB: number
  preemptedResourceVCores: number
  numNonAMContainerPreempted: number
  numAMContainerPreempted: number
  logAggregationStatus: string
  progress: number
  diagnostics: string
  clusterId: string
  priority: number
  unmanagedApplication: boolean
  appNodeLabelExpression: string
  amNodeLabelExpression: string
  trackingUrl?: string
  trackingUI?: string
  amContainerLogs?: string
}

export interface QueueNode {
  queueName?: string
  queues?: { queue: QueueNode[] }
}

export interface AppFilters {
  states: string[]
  appTypes: string[]
  user: string
  queue: string
}

export interface ColumnHeader {
  text: string
  sortable: boolean
  value: keyof YarnApp | 'progress'
  visible: boolean
  /** 固定列宽(可拖拽调整);不设则用 min-width */
  width?: number
}

export type StatusColor = 'success' | 'failure' | 'running' | 'paused' | 'stopped' | 'neutral'