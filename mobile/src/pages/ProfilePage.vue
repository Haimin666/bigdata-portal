<template>
  <ion-page><ion-header class="ion-no-border"><ion-toolbar><ion-title>我的</ion-title></ion-toolbar></ion-header><ion-content :fullscreen="true"><main class="page-shell">
    <section class="identity-card"><span class="avatar">{{ auth.username.slice(0, 1).toUpperCase() || 'A' }}</span><div><h2>{{ auth.username || '免认证模式' }}</h2><p>{{ roleName }}</p></div></section>
    <section class="profile-list"><div><span>模块权限</span><strong>{{ auth.modules?.length ? `${auth.modules.length} 个模块` : '全部模块' }}</strong></div><div><span>门户环境</span><strong>{{ portalHost }}</strong></div><div><span>连接策略</span><strong>HTTPS · Cookie</strong></div></section>
    <ion-button v-if="!auth.authDisabled" class="logout-button" expand="block" fill="outline" color="danger" @click="logout">退出登录</ion-button>
  </main></ion-content></ion-page>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { IonButton, IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { useAuthStore } from '@/stores/auth'
const auth = useAuthStore(); const router = useRouter()
const roleName = computed(() => ({ admin: '管理员', dev: '开发人员', viewer: '只读用户' }[auth.role] || '门户用户'))
const portalHost = computed(() => { const value = import.meta.env.VITE_PORTAL_URL as string | undefined; try { return value ? new URL(value).host : '本地开发代理' } catch { return '门户网关' } })
async function logout() { await auth.logout(); await router.replace('/login') }
</script>
