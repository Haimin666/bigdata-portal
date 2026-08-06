import type { HdfsFileStatus } from '@/types/hdfs'

/**
 * WebHDFS 路径编码:按段 encodeURIComponent,避免中文/空格被破坏,
 * 同时保留分隔符 '/'。
 */
export function encodeHdfsPath(path: string): string {
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
