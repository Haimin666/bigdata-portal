/** WebHDFS FileStatus(与 NameNode LISTSTATUS/GETFILESTATUS 返回结构对应) */
export interface HdfsFileStatus {
  accessTime: number
  blockSize: number
  childrenNum?: number
  fileId?: number
  group: string
  length: number
  modificationTime: number
  owner: string
  pathSuffix: string
  permission: string
  replication: number
  storagePolicy?: number
  type: 'FILE' | 'DIRECTORY' | 'SYMLINK'
}

/** NameNode JMX FSNamesystem 集群容量指标 */
export interface HdfsFsNamesystem {
  CapacityTotal: number
  CapacityUsed: number
  CapacityRemaining: number
  CapacityUsedNonDFS: number
  CapacityTotalGB?: number
  CapacityUsedGB?: number
  CapacityRemainingGB?: number
  PercentUsed?: number
  PercentRemaining?: number
  BlocksTotal: number
  TotalLoad?: number
  NumLiveDataNodes: number
  NumDeadDataNodes: number
  NumDecommissioningDataNodes?: number
  NumDecommissionedDataNodes?: number
  NumStaleDataNodes?: number
}

/** NameNodeInfo 中单个 DataNode 的信息 */
export interface HdfsDataNodeInfo {
  host: string
  capacity: number
  usedSpace: number
  remaining: number
  nonDfsUsedSpace: number
  numBlocks?: number
  lastContact: number
  adminState?: string
}

/** HDFS 磁盘总览(集群 + 节点) */
export interface HdfsDiskOverview {
  cluster: HdfsFsNamesystem
  nodes: HdfsDataNodeInfo[]
}
