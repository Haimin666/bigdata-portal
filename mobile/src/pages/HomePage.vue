<template>
  <ion-page>
    <ion-header class="ion-no-border"><ion-toolbar><ion-title>运行态势</ion-title><ion-buttons slot="end"><ion-button @click="load"><ion-icon :icon="refreshOutline" /></ion-button></ion-buttons></ion-toolbar></ion-header>
    <ion-content :fullscreen="true">
      <main class="page-shell">
        <section class="hero-panel">
          <div><p class="eyebrow">{{ greeting }}</p><h2>{{ auth.username || '运维同学' }}</h2><p>集群关键状态集中在这里。</p></div>
          <div class="live-indicator"><i />实时</div>
        </section>
        <section class="section-block">
          <div class="section-title"><div><p class="eyebrow">YARN / CLUSTER</p><h3>资源与应用</h3></div><router-link to="/app/yarn">查看全部</router-link></div>
          <div class="metric-grid">
            <MetricTile label="运行中" :value="metrics?.appsRunning ?? '—'" />
            <MetricTile label="等待中" :value="metrics?.appsPending ?? '—'" tone="amber" />
            <MetricTile label="可用内存" :value="formatMemory(metrics?.availableMB)" note="当前集群" tone="mint" />
            <MetricTile label="活跃节点" :value="metrics?.activeNodes ?? '—'" tone="slate" />
          </div>
        </section>
        <section class="section-block">
          <div class="section-title"><div><p class="eyebrow">DOLPHINSCHEDULER</p><h3>离线开发</h3></div></div>
          <button class="route-card" @click="router.push('/app/offline')">
            <span class="route-index">01</span><span><strong>查看今日实例</strong><small>筛选状态、检查失败、执行实例操作</small></span><ion-icon :icon="arrowForwardOutline" />
          </button>
        </section>
        <p v-if="error" class="inline-error">{{ error }}</p>
      </main>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { arrowForwardOutline, refreshOutline } from 'ionicons/icons'
import MetricTile from '@/components/MetricTile.vue'
import { fetchMetrics, getPortalConfig } from '@/api/yarn'
import type { ClusterMetrics } from '@/types/yarn'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const metrics = ref<ClusterMetrics | null>(null)
const error = ref('')
const greeting = computed(() => new Date().getHours() < 12 ? '早上好' : new Date().getHours() < 18 ? '下午好' : '晚上好')
function formatMemory(value?: number) { return value == null ? '—' : value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value} MB` }
async function load() {
  error.value = ''
  try {
    const config = await getPortalConfig()
    const rm = config.resourceManagers?.[0]
    if (rm) metrics.value = await fetchMetrics(rm)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '加载失败' }
}
onMounted(load)
</script>
