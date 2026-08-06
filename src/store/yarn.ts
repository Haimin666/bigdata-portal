import { defineStore } from 'pinia'
import { fetchApps, fetchResourceManagers, fetchScheduler, requestKill } from '@/api/yarn'
import { HEADERS } from '@/config/yarn'
import type { ColumnHeader, AppFilters, YarnApp } from '@/types/yarn'

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

export const useYarnStore = defineStore('yarn', {
  state: () => ({
    rms: [] as string[],
    rm: '',
    apps: [] as YarnApp[],
    availableUsers: [] as string[],
    availableAppTypes: [] as string[],
    queues: [] as string[],
    loading: false,
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
      this.loading = true
      this.error = ''
      try {
        const list = await fetchApps(this.rm, this.filters)
        this.availableAppTypes = this.union(
          this.availableAppTypes,
          list.map((a) => a.applicationType)
        )
        this.availableUsers = this.union(this.availableUsers, list.map((a) => a.user))
        this.apps = list
      } catch (e) {
        this.apps = []
        this.error = e instanceof Error ? e.message : String(e)
      } finally {
        this.loading = false
      }
    },
    async loadQueues() {
      if (!this.rm) return
      try {
        const node = await fetchScheduler(this.rm)
        const result: string[] = []
        const walk = (q: { queueName?: string; queues?: { queue: unknown[] } }) => {
          if (q.queues) {
            q.queues.queue.forEach((item) =>
              walk(item as { queueName?: string; queues?: { queue: unknown[] } })
            )
          } else if (q.queueName) {
            result.push(q.queueName)
          }
        }
        walk(node)
        this.queues = result.sort((a, b) => a.localeCompare(b))
      } catch {
        this.queues = []
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
