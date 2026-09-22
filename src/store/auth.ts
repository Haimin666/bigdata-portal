// 认证状态(pinia):当前用户 / 登录态 / 可访问模块
import { defineStore } from 'pinia'
import { authApi, type MeInfo, type LoginInfo } from '@/api/auth'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    me: null as MeInfo | null,
    loaded: false
  }),
  getters: {
    loggedIn: (s) => !!s.me?.username,
    isAdmin: (s) => s.me?.role === 'admin',
    /** 可访问模块(菜单 name 白名单);null = 全部 */
    modules: (s) => s.me?.modules ?? null,
    /** 认证被配置关闭(兼容旧部署,全部放行) */
    authDisabled: (s) => !!s.me?.authDisabled,
    /** 是否已完成初始化(已创建首个管理员) */
    initialized: (s) => s.me?.initialized !== false,
    username: (s) => s.me?.username ?? ''
  },
  actions: {
    async fetchMe() {
      try {
        this.me = await authApi.me()
      } catch {
        this.me = null
      }
      this.loaded = true
      return this.me
    },
    async login(username: string, password: string): Promise<LoginInfo> {
      const info = await authApi.login(username, password)
      await this.fetchMe()
      return info
    },
    async logout() {
      try {
        await authApi.logout()
      } catch {
        /* 忽略 */
      }
      this.me = null
    },
    clear() {
      this.me = null
    }
  }
})
