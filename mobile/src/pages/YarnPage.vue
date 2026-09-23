<template>
  <ion-page>
    <ion-header class="ion-no-border"><ion-toolbar><ion-title>YARN 应用</ion-title><ion-buttons slot="end"><ion-button class="page-refresh" :disabled="loading" aria-label="刷新 YARN 应用" @click="load"><ion-spinner v-if="loading" name="crescent" /><ion-icon v-else :icon="refreshOutline" /></ion-button></ion-buttons></ion-toolbar></ion-header>
    <ion-content :fullscreen="true">
      <main class="page-shell">
        <div class="yarn-sticky-controls">
          <section class="control-strip">
            <ion-select v-model="selectedRm" label="资源管理器" interface="action-sheet" @ion-change="load"><ion-select-option v-for="rm in resourceManagers" :key="rm" :value="rm">{{ shortHost(rm) }}</ion-select-option></ion-select>
            <ion-searchbar v-model="keyword" placeholder="应用名、用户或 ID" :debounce="150" />
            <div class="chip-row">
              <button v-for="item in states" :key="item.value" class="filter-chip" :class="{ active: state === item.value }" @click="state = item.value; load()">{{ item.label }}</button>
            </div>
          </section>
        </div>
        <div class="result-meta"><span>{{ filteredApps.length }} 个应用</span><span v-if="loading">同步中…</span><button v-else-if="keyword" class="clear-filter" type="button" @click="keyword = ''">清除筛选</button></div>
        <section class="card-stack">
          <article v-for="app in filteredApps" :key="app.id" class="ops-card">
            <div class="card-top"><StatusPill :status="app.state" /><span class="mono-id">{{ app.id }}</span></div>
            <h3>{{ app.name }}</h3>
            <p class="subline">{{ app.user }} · {{ app.queue }} · {{ app.applicationType }}</p>
            <div class="app-progress"><i :style="{ width: `${Math.max(2, app.progress || 0)}%` }" /></div>
            <div class="detail-grid"><span><small>内存</small>{{ memory(app.allocatedMB) }}</span><span><small>vCores</small>{{ app.allocatedVCores || 0 }}</span><span><small>容器</small>{{ app.runningContainers || 0 }}</span><span><small>耗时</small>{{ duration(app.elapsedTime) }}</span></div>
            <div class="card-actions"><ion-button fill="clear" size="small" @click="copy(app.id)">复制 ID</ion-button><ion-button v-if="canKill(app)" color="danger" fill="clear" size="small" :disabled="killLoadingId === app.id" @click="confirmKill(app)"><ion-spinner v-if="killLoadingId === app.id" name="crescent" /><span v-else>终止应用</span></ion-button></div>
          </article>
          <div v-if="!loading && !filteredApps.length" class="empty-state"><ion-icon :icon="checkmarkCircleOutline" /><strong>{{ hasFilter ? '没有匹配应用' : '暂无应用' }}</strong><span>{{ hasFilter ? '清除搜索或切换状态后重试' : '当前资源管理器没有返回应用' }}</span></div>
        </section>
        <p v-if="error" class="inline-error">{{ error }}</p>
      </main>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { alertController, toastController, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonPage, IonSearchbar, IonSelect, IonSelectOption, IonSpinner, IonTitle, IonToolbar } from '@ionic/vue'
import { checkmarkCircleOutline, refreshOutline } from 'ionicons/icons'
import StatusPill from '@/components/StatusPill.vue'
import { fetchApps, getPortalConfig, killApp } from '@/api/yarn'
import type { YarnApp } from '@/types/yarn'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const apps = ref<YarnApp[]>([])
const resourceManagers = ref<string[]>([])
const selectedRm = ref('')
const state = ref('RUNNING,ACCEPTED')
const keyword = ref('')
const loading = ref(false)
const error = ref('')
const killLoadingId = ref('')
const states = [{ label: '活跃', value: 'RUNNING,ACCEPTED' }, { label: '运行中', value: 'RUNNING' }, { label: '等待中', value: 'ACCEPTED' }, { label: '失败', value: 'FAILED' }, { label: '全部', value: '' }]
const hasFilter = computed(() => Boolean(keyword.value.trim() || state.value !== 'RUNNING,ACCEPTED'))
const filteredApps = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  return q ? apps.value.filter((app) => [app.id, app.name, app.user].some((value) => value?.toLowerCase().includes(q))) : apps.value
})
function shortHost(value: string) { try { return new URL(value).hostname.split('.')[0] } catch { return value } }
function memory(value: number) { return value >= 1024 ? `${(value / 1024).toFixed(1)}G` : `${value || 0}M` }
function duration(ms: number) { const min = Math.floor((ms || 0) / 60000); return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m` }
function canKill(app: YarnApp) { return ['RUNNING', 'ACCEPTED', 'SUBMITTED'].includes(app.state) && auth.role !== 'viewer' && auth.canAccess('yarn') }
async function load() {
  loading.value = true; error.value = ''
  try {
    if (!resourceManagers.value.length) {
      resourceManagers.value = (await getPortalConfig()).resourceManagers
      selectedRm.value ||= resourceManagers.value[0] || ''
    }
    apps.value = selectedRm.value ? await fetchApps(selectedRm.value, { states: state.value ? state.value.split(',') : [] }) : []
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '加载失败' } finally { loading.value = false }
}
async function copy(value: string) { await navigator.clipboard.writeText(value); (await toastController.create({ message: 'Application ID 已复制', duration: 1200, position: 'bottom' })).present() }
async function confirmKill(app: YarnApp) {
  const alert = await alertController.create({ header: '终止应用？', message: `${app.name}\n${app.id}\n终止后无法恢复。`, buttons: [{ text: '取消', role: 'cancel' }, { text: '确认终止', role: 'destructive', handler: () => doKill(app) }] })
  await alert.present()
}
async function doKill(app: YarnApp) { killLoadingId.value = app.id; error.value = ''; try { await killApp(selectedRm.value, app.id); (await toastController.create({ message: '应用已提交终止', duration: 1400, position: 'bottom' })).present(); await load() } catch (cause) { error.value = cause instanceof Error ? cause.message : '终止失败' } finally { killLoadingId.value = '' } }
onMounted(load)
</script>
