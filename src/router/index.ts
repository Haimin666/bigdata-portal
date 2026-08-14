import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import MainLayout from '@/layouts/MainLayout.vue'
import LoginView from '@/views/LoginView.vue'
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
  if (to.path === '/login') return '/'
  if (to.meta.adminOnly && !auth.isAdmin) return '/'
  // 模块白名单:菜单 name 不在用户可访问模块内 → 回首页(后端有执行门禁兜底,前端配合隐藏)
  // admin 的 modules 为 null(全部),跳过校验
  const mods = auth.modules
  const name = String(to.name || '')
  if (mods && Array.isArray(mods) && mods.length > 0 && name && !mods.includes(name)) {
    return '/'
  }
  return true
})

export default router
