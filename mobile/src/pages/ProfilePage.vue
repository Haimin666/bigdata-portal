<template>
  <ion-page><ion-header class="ion-no-border"><ion-toolbar><ion-title>我的</ion-title></ion-toolbar></ion-header><ion-content :fullscreen="true"><main class="page-shell">
    <section class="identity-card"><span class="avatar">{{ auth.username.slice(0, 1).toUpperCase() || 'A' }}</span><div><h2>{{ auth.username || '免认证模式' }}</h2><p>{{ roleName }}</p></div></section>
    <section class="theme-panel"><p class="eyebrow">APPEARANCE</p><h3>显示主题</h3><div class="theme-options"><button v-for="option in themeOptions" :key="option.value" :class="{ active: preference === option.value }" @click="setTheme(option.value)"><ion-icon :icon="option.icon" /><span><strong>{{ option.label }}</strong><small>{{ option.note }}</small></span></button></div></section>
    <section class="profile-list"><div><span>模块权限</span><strong>{{ auth.modules?.length ? `${auth.modules.length} 个模块` : '全部模块' }}</strong></div><div><span>门户环境</span><strong>{{ portalHost }}</strong></div><div><span>连接策略</span><strong>HTTPS · Cookie</strong></div></section>
    <ion-button v-if="!auth.authDisabled" class="logout-button" expand="block" fill="outline" color="danger" @click="logout">退出登录</ion-button>
  </main></ion-content></ion-page>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { IonButton, IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { contrastOutline, moonOutline, sunnyOutline } from 'ionicons/icons'
import { useAuthStore } from '@/stores/auth'
import { useTheme, type ThemePreference } from '@/theme/preference'
const auth = useAuthStore(); const router = useRouter()
const { preference, setTheme } = useTheme()
const themeOptions: Array<{ value: ThemePreference; label: string; note: string; icon: string }> = [
  { value: 'light', label: '浅色', note: '明亮办公环境', icon: sunnyOutline },
  { value: 'dark', label: '深色', note: '夜间与机房', icon: moonOutline },
  { value: 'system', label: '跟随系统', note: '自动切换', icon: contrastOutline }
]
const roleName = computed(() => ({ admin: '管理员', dev: '开发人员', viewer: '只读用户' }[auth.role] || '门户用户'))
const portalHost = computed(() => { const value = import.meta.env.VITE_PORTAL_URL as string | undefined; try { return value ? new URL(value).host : '本地开发代理' } catch { return '门户网关' } })
async function logout() { await auth.logout(); await router.replace('/login') }
</script>
