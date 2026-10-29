import { defineStore } from 'pinia'
import { fetchApps, fetchMetrics, fetchResourceManagers, fetchScheduler, requestKill } from '@/api/yarn'
import { HEADERS } from '@/config/yarn'
import type { ClusterMetrics, ColumnHeader, AppFilters, QueueNode, QueueResources, YarnApp } from '@/types/yarn'

function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

const appRequests = new WeakMap<object, AbortController>()

export const useYarnStore = defineStore('yarn', {
  state: () => ({
    rms: [] as string[],
    rm: '',
    apps: [] as YarnApp[],
    availableUsers: [] as string[],
    availableAppTypes: [] as string[],
    queues: [] as string[],
    /** 集群指标(total/allocated 内存与 vCores 等) */
    metrics: {} as ClusterMetrics,
    /** 队列资源树(总览展示) */
    queueTree: [] as QueueResources[],
    loading: false,
    // 请求序号:loadApps 防竞态
    appsSeq: 0,
    metricsSeq: 0,
    queuesSeq: 0,
    error: '',
    filters: {
      states: ['RUNNING'],
      appTypes: [] as string[],
      user: '',
      queue: ''
    } as AppFilters,
    searchByAppName: '',
    humanize: loadPref<boolean>('humanize', true),
    autoRefresh: loadPref<boolean>('autoRefresh', false),
    refreshInterval: loadPref<number>('refreshInterval', 30),
    viewStyle: loadPref<'table' | 'card'>('viewStyle', 'table'),
    headers: [...HEADERS] as ColumnHeader[]
  }),
  actions: {
    union(a: string[], b: string[]): string[] {
      return Array.from(new Set([...a, ...b])).sort()
    },
    async init() {
      try {
        this.rms = await fetchResourceManagers()
      } catch {
        this.rms = []
      }
      if (!this.rm && this.rms.length) this.rm = this.rms[0]
    },
    setPref(
      key: 'humanize' | 'autoRefresh' | 'refreshInterval' | 'viewStyle',
      value: boolean | number | 'table' | 'card'
    ) {
      ;(this as unknown as Record<string, unknown>)[key] = value
      savePref(key, value)
    },
    async loadApps() {
      if (!this.rm) return
      appRequests.get(this)?.abort()
      const controller = new AbortController()
      appRequests.set(this, controller)
      const seq = ++this.appsSeq
      const rm = this.rm
      this.loading = true
      this.error = ''
      try {
        const list = await fetchApps(rm, this.filters, controller.signal)
        if (seq !== this.appsSeq || rm !== this.rm) return // 已有更新的请求,丢弃本次结果
        this.availableAppTypes = this.union(
          this.availableAppTypes,
          list.map((a) => a.applicationType)
        )
        this.availableUsers = this.union(this.availableUsers, list.map((a) => a.user))
        this.apps = list
      } catch (e) {
        if (seq !== this.appsSeq || rm !== this.rm) return
        if (controller.signal.aborted) return
        this.error = e instanceof Error ? e.message : String(e)
      } finally {
        if (seq === this.appsSeq) {
          this.loading = false
          appRequests.delete(this)
        }
      }
    },
    cancelApps() {
      appRequests.get(this)?.abort()
      appRequests.delete(this)
      this.appsSeq++
      this.loading = false
    },
    async loadMetrics() {
      if (!this.rm) return
      const rm = this.rm
      const seq = ++this.metricsSeq
      try {
        const metrics = await fetchMetrics(rm)
        if (seq !== this.metricsSeq || rm !== this.rm) return
        this.metrics = metrics
      } catch {
        if (seq === this.metricsSeq && rm === this.rm) this.metrics = {}
      }
    },
    async loadQueues() {
      if (!this.rm) return
      const rm = this.rm
      const seq = ++this.queuesSeq
      try {
        const node = await fetchScheduler(rm)
        if (seq !== this.queuesSeq || rm !== this.rm) return
        // 调度器类型:FairScheduler 的根队列在 schedulerInfo.rootQueue,CapacityScheduler 直接是 schedulerInfo
        const isFair = (node.type ?? '').toLowerCase().includes('fair')
        const root: QueueNode = isFair && node.rootQueue ? node.rootQueue : node
        const scheduler: QueueResources['scheduler'] = isFair
          ? 'fair'
          : (node.type ?? '').toLowerCase().includes('capacity')
            ? 'capacity'
            : 'unknown'
        // 队列资源树(schedulerInfo/rootQueue 本身就是根队列节点)
        const toResources = (q: QueueNode): QueueResources => {
          const used = q.usedResources ?? q.resourcesUsed ?? {}
          const maxRes = q.maxResources ?? {}
          const fairRes = q.fairResources ?? q.fairShare ?? {}
          return {
            queueName: q.queueName ?? '',
            scheduler,
            capacity: q.capacity ?? 0,
            usedCapacity: q.usedCapacity ?? 0,
            absoluteCapacity: q.absoluteCapacity ?? 0,
            weight: q.weight ?? 0,
            memory: used.memory ?? 0,
            vCores: used.vCores ?? 0,
            quotaMemory: maxRes.memory ?? 0,
            quotaVCores: maxRes.vCores ?? 0,
            fairMemory: fairRes.memory,
            fairVCores: fairRes.vCores,
            numActiveApps: q.numActiveApps ?? q.numActiveApplications,
            numPendingApps: q.numPendingApps ?? q.numPendingApplications,
            children: (q.childQueues?.queue ?? q.queues?.queue ?? []).map(toResources)
          }
        }
        this.queueTree = root.queueName ? [toResources(root)] : []
        // 叶子队列名列表(筛选用)
        const result: string[] = []
        const walk = (q: QueueNode) => {
          const kids = q.childQueues?.queue ?? q.queues?.queue ?? []
          if (kids.length) {
            kids.forEach(walk)
          } else if (q.queueName) {
            result.push(q.queueName)
          }
        }
        walk(root)
        this.queues = result.sort((a, b) => a.localeCompare(b))
      } catch {
        if (seq !== this.queuesSeq || rm !== this.rm) return
        this.queues = []
        this.queueTree = []
      }
    },
    toggleHeader(value: string) {
      const h = this.headers.find((c) => c.value === value)
      if (h) h.visible = !h.visible
    },
    async kill(appId: string): Promise<void> {
      await requestKill(this.rm, appId)
    }
  }
})
