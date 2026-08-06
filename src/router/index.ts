import { createRouter, createWebHistory } from 'vue-router'
import MainLayout from '@/layouts/MainLayout.vue'
import { menus } from '@/config/menu'

// 子应用路由由菜单表驱动:kind === 'subapp' 的菜单项都进 SubAppView
const subappRoutes = menus
  .filter((m) => m.kind === 'subapp')
  .map((m) => ({
    path: m.path,
    name: m.name,
    component: () => import('@/views/subapp/SubAppView.vue')
  }))

const router = createRouter({
  history: createWebHistory(),
  routes: [
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
        ...subappRoutes
      ]
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/yarn'
    }
  ]
})

export default router
