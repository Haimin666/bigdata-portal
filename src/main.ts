import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
// Element Plus 深色组件主题(与 html.dark 配套)
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import router from './router'
import './styles/index.scss'
import { initTheme, loadThemeOverrides } from './utils/theme'

// 先初始化主题(html.dark class),再挂载应用,避免深色用户闪白
initTheme()
// 异步拉取管理端主题覆盖(字体/颜色),有则注入全局 CSS 变量
loadThemeOverrides()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(ElementPlus)
app.mount('#app')
