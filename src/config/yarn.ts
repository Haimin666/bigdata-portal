import type { ColumnHeader } from '@/types/yarn'

export const AVAILABLE_STATES = ['ACCEPTED', 'RUNNING', 'FINISHED', 'FAILED', 'KILLED']

export const REFRESH_INTERVALS = [10, 15, 30, 60, 120]

export const ROWS_PER_PAGE_OPTIONS = [16, 32, 64, 1000] // 1000 近似"全部"

export const HEADERS: ColumnHeader[] = [
  { text: '应用名称', sortable: true, value: 'name', visible: true, width: 220 },
  { text: '状态', sortable: true, value: 'state', visible: true, width: 90 },
  { text: '用户名', sortable: true, value: 'user', visible: true, width: 110 },
  { text: '应用ID', sortable: true, value: 'id', visible: true, width: 190 },
  { text: '队列', sortable: true, value: 'queue', visible: true, width: 120 },
  { text: '最终状态', sortable: true, value: 'finalStatus', visible: false, width: 100 },
  { text: '开始时间', sortable: true, value: 'startedTime', visible: true, width: 170 },
  { text: '结束时间', sortable: true, value: 'finishedTime', visible: true, width: 170 },
  { text: '运行时长', sortable: true, value: 'elapsedTime', visible: true, width: 100 },
  { text: 'AM主机地址', sortable: true, value: 'amHostHttpAddress', visible: true, width: 170 },
  { text: 'AM RPC地址', sortable: true, value: 'amRPCAddress', visible: false, width: 150 },
  { text: '已分配VCores', sortable: true, value: 'allocatedVCores', visible: true, width: 120 },
  { text: '已分配内存(MB)', sortable: true, value: 'allocatedMB', visible: true, width: 130 },
  { text: '运行容器数', sortable: true, value: 'runningContainers', visible: true, width: 110 },
  { text: '队列使用率(%)', sortable: true, value: 'queueUsagePercentage', visible: true, width: 110 },
  { text: '内存秒数', sortable: true, value: 'memorySeconds', visible: false, width: 110 },
  { text: 'Vcore秒数', sortable: true, value: 'vcoreSeconds', visible: false, width: 110 },
  { text: '集群使用率(%)', sortable: true, value: 'clusterUsagePercentage', visible: false, width: 120 },
  { text: '抢占内存(MB)', sortable: true, value: 'preemptedResourceMB', visible: false, width: 120 },
  { text: '抢占VCores', sortable: true, value: 'preemptedResourceVCores', visible: false, width: 120 },
  { text: '抢占非AM容器', sortable: true, value: 'numNonAMContainerPreempted', visible: false, width: 140 },
  { text: '抢占AM容器', sortable: true, value: 'numAMContainerPreempted', visible: false, width: 130 },
  { text: '日志聚合状态', sortable: true, value: 'logAggregationStatus', visible: true, width: 120 },
  { text: '进度', sortable: true, value: 'progress', visible: false, width: 80 },
  { text: '诊断信息', sortable: true, value: 'diagnostics', visible: false, width: 220 },
  { text: '集群ID', sortable: true, value: 'clusterId', visible: false, width: 100 },
  { text: '应用类型', sortable: true, value: 'applicationType', visible: true, width: 100 },
  { text: '应用标签', sortable: true, value: 'applicationTags', visible: false, width: 150 },
  { text: '优先级', sortable: true, value: 'priority', visible: false, width: 90 },
  { text: '非托管应用', sortable: true, value: 'unmanagedApplication', visible: false, width: 120 },
  { text: '应用节点标签', sortable: true, value: 'appNodeLabelExpression', visible: false, width: 140 },
  { text: 'AM节点标签', sortable: true, value: 'amNodeLabelExpression', visible: false, width: 140 }
]
