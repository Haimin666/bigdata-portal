import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import MainLayout from '@/layouts/MainLayout.vue'
import LoginView from '@/views/LoginView.vue'
import DeniedView from '@/views/DeniedView.vue'
import { menus } from '@/config/menu'
import { useAuthStore } from '@/store/auth'

// 子应用路由由菜单表驱动:kind === 'subapp' 的菜单项都进 SubAppView。
// 实际内容由 MainLayout 的常驻 iframe 池渲染(tab 化,保留状态),此处仅占位空壳。
const subappRoutes: RouteRecordRaw[] = menus
  .filter((m) => m.kind === 'subapp')
  .map((m) => ({
    path: m.path,
    name: m.name,
    component: { render: () => null }
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
      // 无权限兜底页:白名单内无任何 native 页的用户落地于此(不拉任何数据)
      path: '/denied',
      name: 'denied',
      component: DeniedView
    },
    {
      path: '/',
      component: MainLayout,
      redirect: '/yarn',
      children: [
        {
          path: 'yarn',
          name: 'yarn',
          component: () => import('@/views/yarn/YarnView.vue')
        },
        {
          path: 'ds-task',
          name: 'dsTask',
          component: () => import('@/views/ds/DsTaskMonitor.vue')
        },
        {
          path: 'hdfs',
          name: 'hdfs',
          component: () => import('@/views/hdfs/HdfsView.vue')
        },
        {
          path: 'db-query',
          name: 'dbQuery',
          component: () => import('@/views/db/QueryView.vue')
        },
        {
          path: 'users',
          name: 'userManage',
          component: () => import('@/views/admin/UserManageView.vue'),
          meta: { adminOnly: true }
        },
        {
          path: 'dataleap',
          name: 'dataleap',
          component: () => import('@/views/dataleap/DataLeapView.vue')
        },
        {
          path: 'assistant',
          name: 'devAssistant',
          component: () => import('@/views/assistant/DevAssistantView.vue')
        },
        ...subappRoutes
      ]
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
  if (auth.authDisabled) return true // 认证关闭(兼容旧部署),全部放行
  if (!auth.initialized) {
    // 未初始化:仅允许进入 /login 创建管理员
    return to.path === '/login' ? true : '/login'
  }
  if (!auth.loggedIn) {
    return to.path === '/login' ? true : '/login'
  }
  /** 用户可访问的第一个 native 菜单页(登录落地/模块回退目标;无命中返回 '' 由守卫跳 /denied) */
  const firstAllowedPath = (): string => {
    const mods = auth.modules
    if (!Array.isArray(mods) || mods.length === 0) return '/yarn'
    const hit = menus.find((m) => m.kind === 'native' && mods.includes(m.name))
    return hit ? hit.path : ''
  }
  if (to.path === '/login') {
    // 白名单内无任何 native 页 → 不再放行 /yarn(防 subapp-only 用户越权),落 /denied 提示页
    return firstAllowedPath() || '/denied'
  }
  if (to.meta.adminOnly && !auth.isAdmin) return '/'
  // 模块白名单:菜单 name 不在用户可访问模块内 → 跳首个可访问页;无 native 可访问 → /denied
  // admin 的 modules 为 null(全部),跳过校验
  const mods = auth.modules
  const name = String(to.name || '')
  if (mods && Array.isArray(mods) && mods.length > 0 && name && !mods.includes(name)) {
    const fallback = firstAllowedPath()
    if (!fallback) {
      // 允许 subapp-only 用户直达其被授权的子应用页,其余一律拒绝页
      if (menus.some((m) => m.path === to.path && m.kind === 'subapp' && mods.includes(m.name))) return true
      return to.path === '/denied' ? true : '/denied'
    }
    if (to.path === fallback) return true // 兜底目标放行,避免循环
    return fallback
  }
  return true
})

export default router
