import type { AppFilters, ClusterMetrics, QueueNode, YarnApp } from '@/types/yarn'

async function request<T>(path: string, rm: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
    'X-Resource-Manager': rm
  }
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export function filtersToParams(filters: AppFilters): Record<string, string> {
  const params: Record<string, string> = {}
  if (filters.states.length) params.states = filters.states.join(',')
  if (filters.user) params.user = filters.user
  if (filters.appTypes.length) params.applicationTypes = filters.appTypes.join(',')
  if (filters.queue) params.queue = filters.queue
  return params
}

/** 从网关 /api/config 拉取可用 ResourceManager 列表(替代原硬编码) */
export async function fetchResourceManagers(): Promise<string[]> {
  try {
    const res = await fetch('/api/config')
    const data = (await res.json()) as { resourceManagers?: string[] }
    return data?.resourceManagers ?? []
  } catch {
    return []
  }
}

export async function fetchApps(rm: string, filters: AppFilters): Promise<YarnApp[]> {
  const qs = new URLSearchParams(filtersToParams(filters)).toString()
  const data = await request<{ apps?: { app: YarnApp[] } }>(
    `/hadoopapi/ws/v1/cluster/apps?${qs}`,
    rm
  )
  return data?.apps?.app ?? []
}

export async function fetchScheduler(rm: string): Promise<QueueNode> {
  const data = await request<{ scheduler?: { schedulerInfo: QueueNode } }>(
    '/hadoopapi/ws/v1/cluster/scheduler',
    rm
  )
  return data?.scheduler?.schedulerInfo ?? {}
}

export async function fetchMetrics(rm: string): Promise<ClusterMetrics> {
  const data = await request<{ clusterMetrics?: ClusterMetrics }>(
    '/hadoopapi/ws/v1/cluster/metrics',
    rm
  )
  return data?.clusterMetrics ?? {}
}

export async function requestKill(rm: string, appId: string): Promise<void> {
  await fetch(`/hadoopapi/ws/v1/cluster/apps/${appId}/state`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Resource-Manager': rm
    },
    body: JSON.stringify({ state: 'KILLED' })
  })
}
