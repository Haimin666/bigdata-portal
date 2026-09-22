import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { IonicVue } from '@ionic/vue'
import '@ionic/vue/css/core.css'
import '@ionic/vue/css/normalize.css'
import '@ionic/vue/css/structure.css'
import '@ionic/vue/css/typography.css'
import '@ionic/vue/css/padding.css'
import '@ionic/vue/css/display.css'
import App from './App.vue'
import router from './router'
import './theme/mobile.css'

const app = createApp(App).use(IonicVue).use(createPinia()).use(router)
router.isReady().then(() => app.mount('#app'))
