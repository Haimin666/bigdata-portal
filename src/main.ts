import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from './plugins/element-plus'
import App from './App.vue'
import router from './router'
import './styles/index.scss'
import { initTheme } from './utils/theme'
import { useAuthStore } from './store/auth'

// 先初始化主题(html.dark class),再挂载应用,避免深色用户闪白
initTheme()

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
app.use(ElementPlus)
window.addEventListener('portal-auth-expired', () => {
  useAuthStore(pinia).clear()
  if (router.currentRoute.value.path !== '/login') void router.replace('/login')
})
app.mount('#app')
