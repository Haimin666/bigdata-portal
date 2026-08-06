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
