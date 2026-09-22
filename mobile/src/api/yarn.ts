import { requestJson } from './request'
import type { ClusterMetrics, QueueNode, YarnApp, YarnAppFilters } from '../types/yarn'

function rmHeaders(resourceManager: string, headers?: HeadersInit): Headers {
  const result = new Headers(headers)
  result.set('X-Resource-Manager', resourceManager)
  return result
}

function queryOf(filters: YarnAppFilters): string {
  const params = new URLSearchParams()
  if (filters.states?.length) params.set('states', filters.states.join(','))
  if (filters.applicationTypes?.length) params.set('applicationTypes', filters.applicationTypes.join(','))
  if (filters.user) params.set('user', filters.user)
  if (filters.queue) params.set('queue', filters.queue)
  return params.toString()
}

export interface PortalConfig {
  resourceManagers: string[]
}

export async function getPortalConfig(): Promise<PortalConfig> {
  const data = await requestJson<{ resourceManagers?: string[] }>('/api/config')
  return { resourceManagers: data.resourceManagers ?? [] }
}

export async function fetchApps(resourceManager: string, filters: YarnAppFilters = {}): Promise<YarnApp[]> {
  const query = queryOf(filters)
  const data = await requestJson<{ apps?: { app?: YarnApp[] } }>(
    `/hadoopapi/ws/v1/cluster/apps${query ? `?${query}` : ''}`,
    { headers: rmHeaders(resourceManager) }
  )
  return data.apps?.app ?? []
}

export async function fetchMetrics(resourceManager: string): Promise<ClusterMetrics> {
  const data = await requestJson<{ clusterMetrics?: ClusterMetrics }>('/hadoopapi/ws/v1/cluster/metrics', {
    headers: rmHeaders(resourceManager)
  })
  return data.clusterMetrics ?? {}
}

export async function fetchScheduler(resourceManager: string): Promise<QueueNode> {
  const data = await requestJson<{ scheduler?: { schedulerInfo?: QueueNode } }>('/hadoopapi/ws/v1/cluster/scheduler', {
    headers: rmHeaders(resourceManager)
  })
  return data.scheduler?.schedulerInfo ?? {}
}

export async function killApp(resourceManager: string, appId: string): Promise<void> {
  await requestJson(`/hadoopapi/ws/v1/cluster/apps/${encodeURIComponent(appId)}/state`, {
    method: 'PUT',
    headers: rmHeaders(resourceManager, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ state: 'KILLED' })
  })
}
