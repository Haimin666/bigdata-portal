import { createRouter, createWebHashHistory } from '@ionic/vue-router'
import type { RouteLocationNormalized, RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/app/home' },
  { path: '/login', component: () => import('@/pages/LoginPage.vue'), meta: { public: true } },
  {
    path: '/app',
    component: () => import('@/pages/TabsPage.vue'),
    children: [
      { path: '', redirect: '/app/home' },
      { path: 'home', component: () => import('@/pages/HomePage.vue') },
      { path: 'yarn', component: () => import('@/pages/YarnPage.vue') },
      { path: 'offline', component: () => import('@/pages/OfflinePage.vue') },
      { path: 'assistant', component: () => import('@/pages/AssistantPage.vue') },
      { path: 'profile', component: () => import('@/pages/ProfilePage.vue') }
    ]
  }
]

const router = createRouter({ history: createWebHashHistory(import.meta.env.BASE_URL), routes })

router.beforeEach(async (to: RouteLocationNormalized) => {
  const auth = useAuthStore()
  if (!auth.loaded) {
    try {
      await auth.loadSession()
    } catch {
      if (!to.meta.public) return '/login'
    }
  }
  if (to.meta.public) return auth.loggedIn || auth.authDisabled ? '/app/home' : true
  if (to.path === '/app/assistant' && !auth.canAccess('devAssistant')) return '/app/home'
  return auth.loggedIn || auth.authDisabled ? true : '/login'
})

export default router
