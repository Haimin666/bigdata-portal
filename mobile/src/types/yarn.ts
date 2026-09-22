export interface YarnApp {
  id: string
  name: string
  state: string
  finalStatus: string
  user: string
  queue: string
  applicationType: string
  startedTime: number
  finishedTime: number
  elapsedTime: number
  progress: number
  allocatedVCores: number
  allocatedMB: number
  runningContainers: number
  diagnostics: string
  trackingUrl?: string
  trackingUI?: string
  amContainerLogs?: string
}

export interface YarnAppFilters {
  states?: string[]
  applicationTypes?: string[]
  user?: string
  queue?: string
}

export interface ClusterMetrics {
  appsSubmitted?: number
  appsCompleted?: number
  appsPending?: number
  appsRunning?: number
  appsFailed?: number
  appsKilled?: number
  availableMB?: number
  allocatedMB?: number
  totalMB?: number
  availableVirtualCores?: number
  allocatedVirtualCores?: number
  totalVirtualCores?: number
  containersAllocated?: number
  containersPending?: number
  totalNodes?: number
  activeNodes?: number
  lostNodes?: number
  unhealthyNodes?: number
}

export interface QueueNode {
  queueName?: string
  type?: string
  rootQueue?: QueueNode
  queues?: { queue: QueueNode[] }
  childQueues?: { queue: QueueNode[] }
  capacity?: number
  usedCapacity?: number
  maxCapacity?: number
  absoluteCapacity?: number
  absoluteUsedCapacity?: number
  absoluteMaxCapacity?: number
  resourcesUsed?: YarnResource
  usedResources?: YarnResource
  maxResources?: YarnResource
  numPendingApplications?: number
  numActiveApplications?: number
  numRunningApps?: number
}

export interface YarnResource {
  memory?: number
  vCores?: number
}
