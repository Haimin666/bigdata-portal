// 认证状态(pinia):当前用户 / 登录态 / 可访问模块
import { defineStore } from 'pinia'
import { authApi, type MeInfo, type LoginInfo } from '@/api/auth'
import { getEnabledModules } from '@/api/db'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    me: null as MeInfo | null,
    loaded: false,
    /** 认证关闭时使用的服务端模块白名单;空数组表示全量 */
    enabledModules: null as string[] | null
  }),
  getters: {
    loggedIn: (s) => !!s.me?.username,
    isAdmin: (s) => s.me?.role === 'admin',
    /** 可访问模块(菜单 name 白名单);null = 全部 */
    modules: (s) => s.me?.modules ?? null,
    /** 认证被配置关闭(兼容旧部署,全部放行) */
    authDisabled: (s) => !!s.me?.authDisabled,
    /** 统一的模块权限判断:null/空数组表示继承后的全部模块 */
    hasModule: (s) => (name: string) => {
      if (s.me?.authDisabled) {
        return !s.enabledModules || s.enabledModules.length === 0 || s.enabledModules.includes(name)
      }
      if (s.me?.role === 'admin' || !s.me?.modules || s.me.modules.length === 0) return true
      return s.me.modules.includes(name)
    },
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
      this.enabledModules = this.me?.authDisabled ? await getEnabledModules() : null
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
      this.enabledModules = null
    },
    clear() {
      this.me = null
      this.enabledModules = null
    }
  }
})
