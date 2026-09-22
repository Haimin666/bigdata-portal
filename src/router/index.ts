import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import MainLayout from '@/layouts/MainLayout.vue'
import LoginView from '@/views/LoginView.vue'
import ForbiddenView from '@/views/ForbiddenView.vue'
import { menus } from '@/config/menu'
import { useAuthStore } from '@/store/auth'

// 所有模块路由均由统一注册表生成。子应用实际内容由 TabStage 的 iframe 池渲染。
const moduleRoutes: RouteRecordRaw[] = menus.map((m) => ({
  path: m.path.slice(1),
  name: m.name,
  component: m.kind === 'native' && m.component ? m.component : { render: () => null },
  meta: m.adminOnly ? { adminOnly: true } : undefined
}))

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { public: true }
    },
    {
      path: '/forbidden',
      name: 'forbidden',
      component: ForbiddenView
    },
    {
      path: '/',
      component: MainLayout,
      redirect: '/yarn',
      children: moduleRoutes
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/yarn'
    }
  ]
})

// 认证守卫:未登录跳 /login;未初始化引导创建管理员;admin 页面校验角色。
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.loaded) await auth.fetchMe()
  if (!auth.authDisabled) {
    if (!auth.initialized) {
      // 未初始化:仅允许进入 /login 创建管理员
      return to.path === '/login' ? true : '/login'
    }
    if (!auth.loggedIn) {
      return to.path === '/login' ? true : '/login'
    }
  }
  /** 用户可访问的第一个模块页;无权限进入专用无权限页 */
  const firstAllowedPath = (): string => {
    const mods = auth.modules
    if (!auth.authDisabled && (!Array.isArray(mods) || mods.length === 0)) return '/yarn'
    const hit = menus.find((m) => auth.hasModule(m.name) && (!m.adminOnly || auth.isAdmin))
    return hit ? hit.path : '/forbidden'
  }
  if (to.path === '/login') return firstAllowedPath()
  if (to.path === '/forbidden') return true
  if (to.meta.adminOnly && !auth.isAdmin) return firstAllowedPath()
  // 模块白名单:菜单 name 不在用户可访问模块内 → 跳用户首个可访问页(避免回 '/' 造成无限重定向)
  // admin 的 modules 为 null(全部),跳过校验
  const name = String(to.name || '')
  if (name && !auth.hasModule(name)) {
    const fallback = firstAllowedPath()
    if (to.path === fallback) return true // 兜底目标放行,避免循环
    return fallback
  }
  return true
})

export default router
