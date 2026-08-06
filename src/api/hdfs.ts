import type { HdfsDiskOverview, HdfsFileStatus } from '@/types/hdfs'

/**
 * WebHDFS 路径编码:按段 encodeURIComponent,避免中文/空格被破坏,
 * 同时保留分隔符 '/'。
 */
function encodeHdfsPath(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

/** 从 WebHDFS 错误响应(JSON RemoteException 或 HTML)中提取可读信息 */
async function extractError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const json = JSON.parse(text) as {
      RemoteException?: { exception?: string; message?: string }
    }
    if (json?.RemoteException?.message) {
      const ex = json.RemoteException.exception
      return ex && ex !== 'RemoteException' ? `${ex}: ${json.RemoteException.message}` : json.RemoteException.message
    }
  } catch {
    // 非 JSON,继续走 HTML 解析
  }
  const m = /<pre>([\s\S]*?)<\/pre>/i.exec(text)
  return m ? m[1].trim() : `HTTP ${res.status} ${res.statusText}`
}

/** 列目录:GET /webhdfs/v1/<path>?op=LISTSTATUS */
export async function listStatus(path: string): Promise<HdfsFileStatus[]> {
  const res = await fetch(`/webhdfs/v1${encodeHdfsPath(path)}?op=LISTSTATUS`)
  if (!res.ok) throw new Error(await extractError(res))
  const data = (await res.json()) as {
    FileStatuses?: { FileStatus?: HdfsFileStatus[] }
  }
  return data?.FileStatuses?.FileStatus ?? []
}

/** 从 NameNode JMX 拉取磁盘总览:FSNamesystem(集群容量)+ NameNodeInfo(单节点明细)。
 *  经网关 /static 代理访问(与 HDFS 静态资源同源)。 */
export async function fetchHdfsDiskOverview(): Promise<HdfsDiskOverview> {
  const [fs, info] = await Promise.all([
    fetch('/static/jmx?qry=Hadoop:service=NameNode,name=FSNamesystem').then((r) => r.json()),
    fetch('/static/jmx?qry=Hadoop:service=NameNode,name=NameNodeInfo').then((r) => r.json())
  ])
  const fsBean = fs.beans?.find((b: { name?: string }) => (b.name ?? '').endsWith('FSNamesystem'))
  const infoBean = info.beans?.find((b: { name?: string }) => (b.name ?? '').endsWith('NameNodeInfo'))
  const cluster = fsBean ?? {}
  // 节点明细:NameNodeInfo.LiveNodes 是 JSON 字符串 {host: {capacity,usedSpace,remaining,...}}
  const liveNodes = (() => {
    try {
      const raw = infoBean?.LiveNodes
      return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, Record<string, unknown>>) : (raw ?? {})
    } catch {
      return {}
    }
  })()
  const nodes = Object.entries(liveNodes)
    .map(([host, v]) => {
      const n = v as Record<string, unknown>
      return {
        host,
        capacity: Number(n.capacity ?? 0),
        usedSpace: Number(n.usedSpace ?? 0),
        remaining: Number(n.remaining ?? 0),
        nonDfsUsedSpace: Number(n.nonDfsUsedSpace ?? 0),
        numBlocks: Number(n.numBlocks ?? 0),
        lastContact: Number(n.lastContact ?? 0),
        adminState: n.adminState as string | undefined
      }
    })
    .filter((n) => n.capacity > 0)
    .sort((a, b) => b.usedSpace - a.usedSpace)
  return { cluster, nodes }
}
