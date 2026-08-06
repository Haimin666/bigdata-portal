import { defineStore } from 'pinia'
import { menus, type MenuItem } from '@/config/menu'

export const useAppStore = defineStore('app', {
  state: () => ({
    menus: menus as MenuItem[]
  }),
  getters: {
    currentMenu: (state): MenuItem | undefined =>
      state.menus.find((m) => m.path === window.location.pathname)
  }
})

export const useUserStore = defineStore('user', {
  state: () => ({
    token: '',
    username: ''
  }),
  actions: {
    setToken(token: string) {
      this.token = token
    },
    setUsername(username: string) {
      this.username = username
    }
  }
})
