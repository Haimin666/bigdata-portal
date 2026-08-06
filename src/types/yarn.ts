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
  type?: string
  rootQueue?: QueueNode
  queues?: { queue: QueueNode[] }
  /** FairScheduler(新版 API)子队列 */
  childQueues?: { queue: QueueNode[] }
  /** CapacityScheduler 队列字段(相对/绝对容量与资源用量) */
  capacity?: number
  usedCapacity?: number
  maxCapacity?: number
  absoluteCapacity?: number
  absoluteUsedCapacity?: number
  absoluteMaxCapacity?: number
  resourcesUsed?: { memory?: number; vCores?: number }
  /** FairScheduler 资源字段 */
  usedResources?: { memory?: number; vCores?: number }
  maxResources?: { memory?: number; vCores?: number }
  minResources?: { memory?: number; vCores?: number }
  fairResources?: { memory?: number; vCores?: number }
  steadyFairResources?: { memory?: number; vCores?: number }
  fairShare?: { memory?: number; vCores?: number }
  demandResources?: { memory?: number; vCores?: number }
  clusterResources?: { memory?: number; vCores?: number }
  weight?: number
  numPendingApplications?: number
  numActiveApplications?: number
  numRunningApps?: number
  numPendingApps?: number
  numActiveApps?: number
  numContainers?: number
  allocatedContainers?: number
}

/** /ws/v1/cluster/metrics → clusterMetrics */
export interface ClusterMetrics {
  appsSubmitted?: number
  appsCompleted?: number
  appsPending?: number
  appsRunning?: number
  appsFailed?: number
  appsKilled?: number
  reservedMB?: number
  availableMB?: number
  allocatedMB?: number
  totalMB?: number
  reservedVirtualCores?: number
  availableVirtualCores?: number
  allocatedVirtualCores?: number
  totalVirtualCores?: number
  containersAllocated?: number
  containersPending?: number
  containersReserved?: number
  totalNodes?: number
  activeNodes?: number
  lostNodes?: number
  unhealthyNodes?: number
  decommissioningNodes?: number
  decommissionedNodes?: number
  rebootedNodes?: number
  shuffledNodes?: number
  totalNodeLabels?: number
}

/** 展平后的队列资源节点(供总览展示) */
export interface QueueResources {
  queueName: string
  /** 调度器类型:'capacity' | 'fair' | 'unknown' */
  scheduler: 'capacity' | 'fair' | 'unknown'
  /** CapacityScheduler:配置容量(相对父队列,%) */
  capacity: number
  /** CapacityScheduler:当前使用(相对配置容量,%) */
  usedCapacity: number
  /** CapacityScheduler:绝对配置容量(相对集群,%) */
  absoluteCapacity: number
  /** FairScheduler:权重(老版本有,新版可能为 0) */
  weight: number
  /** 已用内存 MB */
  memory: number
  /** 已用 vCores */
  vCores: number
  /** 配额上限(内存 MB):fair 调度为 maxResources */
  quotaMemory: number
  /** 配额上限(vCores) */
  quotaVCores: number
  /** 公平份额(FairScheduler,内存 MB) */
  fairMemory?: number
  fairVCores?: number
  numActiveApps?: number
  numPendingApps?: number
  /** 子队列(树形表格用) */
  children: QueueResources[]
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