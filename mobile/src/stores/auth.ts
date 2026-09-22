import { defineStore } from 'pinia'
import { authApi } from '../api/auth'
import { ApiError } from '../api/request'
import type { AuthConfig, AuthUser, MeInfo } from '../types/auth'

interface AuthState {
  config: AuthConfig | null
  me: MeInfo | null
  loading: boolean
  loaded: boolean
}

function toMe(user: AuthUser): MeInfo {
  return { initialized: true, username: user.username, role: user.role, modules: user.modules }
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    config: null,
    me: null,
    loading: false,
    loaded: false
  }),
  getters: {
    authenticated: (state): boolean => Boolean(state.me?.username) || state.me?.authDisabled === true,
    loggedIn: (state): boolean => Boolean(state.me?.username),
    authDisabled: (state): boolean => state.me?.authDisabled === true || state.config?.enabled === false,
    username: (state): string => state.me?.username ?? '',
    role: (state): string => state.me?.role ?? '',
    modules: (state): string[] | null => state.me?.modules ?? null
  },
  actions: {
    async bootstrap(): Promise<void> {
      this.loading = true
      try {
        this.config = await authApi.config()
        if (!this.config.enabled) {
          this.me = await authApi.me()
        } else if (this.config.initialized) {
          try {
            this.me = await authApi.me()
          } catch (error) {
            if (error instanceof ApiError && error.status === 401) this.me = null
            else throw error
          }
        }
      } finally {
        this.loading = false
        this.loaded = true
      }
    },
    async loadSession(): Promise<void> {
      await this.bootstrap()
    },
    async login(username: string, password: string): Promise<void> {
      this.me = toMe(await authApi.login(username, password))
    },
    async initialize(username: string, password: string): Promise<void> {
      this.me = toMe(await authApi.init(username, password))
      this.config = { enabled: true, initialized: true }
    },
    async logout(): Promise<void> {
      try {
        await authApi.logout()
      } finally {
        this.me = null
      }
    },
    clearSession(): void {
      this.me = null
    },
    canAccess(moduleName: string): boolean {
      if (this.me?.role === 'admin' || this.me?.modules === null) return true
      return this.me?.modules.includes(moduleName) ?? false
    }
  }
})
