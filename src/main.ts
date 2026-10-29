import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
// Element Plus 深色组件主题(与 html.dark 配套)
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import router from './router'
import './styles/index.scss'
import { initTheme } from './utils/theme'

// 先初始化主题(html.dark class),再挂载应用,避免深色用户闪白
initTheme()

const app = createApp(App)
app.use(createPinia())
app.use(router)
// 中文语言包:分页(共/条/页/前往)、表格空态等默认文案不再显示英文
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')
