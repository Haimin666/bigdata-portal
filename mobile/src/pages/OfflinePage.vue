<template>
  <ion-page>
    <ion-header class="ion-no-border"><ion-toolbar><ion-title>离线开发</ion-title><ion-buttons slot="end"><ion-button @click="webOpen = true"><ion-icon :icon="openOutline" /></ion-button></ion-buttons></ion-toolbar></ion-header>
    <ion-content :fullscreen="true">
      <main class="page-shell">
        <button class="full-dev-banner" @click="webOpen = true"><span><small>FULL CONSOLE</small><strong>打开完整开发平台</strong><em>工作流 DAG 与节点配置建议横屏操作</em></span><ion-icon :icon="expandOutline" /></button>
        <section class="control-strip">
          <ion-select v-model="project" label="项目" interface="action-sheet" @ion-change="loadInstances"><ion-select-option v-for="item in projects" :key="item.id" :value="item.name">{{ item.name }}</ion-select-option></ion-select>
          <ion-searchbar v-model="keyword" placeholder="搜索工作流实例" :debounce="250" @ion-input="loadInstances" />
          <div class="chip-row"><button v-for="item in states" :key="item.value" class="filter-chip" :class="{ active: state === item.value }" @click="state = item.value; loadInstances()">{{ item.label }}</button></div>
        </section>
        <div class="result-meta"><span>今日实例 · {{ total }} 条</span><span v-if="loading">同步中…</span></div>
        <section class="card-stack">
          <article v-for="item in instances" :key="item.id" class="ops-card">
            <div class="card-top"><StatusPill :status="item.state" /><span class="mono-id">#{{ item.id }}</span></div>
            <h3>{{ item.name }}</h3><p class="subline">{{ project }} · {{ item.executorName || '—' }}</p>
            <div class="detail-grid two"><span><small>开始时间</small>{{ compactTime(item.startTime) }}</span><span><small>耗时</small>{{ item.duration || 0 }}s</span></div>
            <div class="card-actions"><ion-button fill="clear" size="small" @click="openInstanceLog(item)">查看日志</ion-button><template v-if="canOperate"><ion-button v-if="canPause(item)" fill="clear" size="small" @click="confirmAction(item, 'PAUSE', '暂停')">暂停</ion-button><ion-button v-if="canStop(item)" color="danger" fill="clear" size="small" @click="confirmAction(item, 'STOP', '停止')">停止</ion-button><ion-button color="warning" fill="clear" size="small" @click="confirmAction(item, 'REPEAT_RUNNING', '重跑')">重跑</ion-button></template></div>
          </article>
          <div v-if="!loading && !instances.length" class="empty-state"><ion-icon :icon="fileTrayOutline" /><strong>暂无实例</strong><span>请选择项目或调整筛选条件</span></div>
        </section>
        <p v-if="error" class="inline-error">{{ error }}</p>
      </main>
    </ion-content>
    <ion-modal :is-open="webOpen" class="web-modal" @did-dismiss="webOpen = false"><ion-header><ion-toolbar><ion-buttons slot="start"><ion-button @click="webOpen = false">关闭</ion-button></ion-buttons><ion-title>完整离线开发</ion-title></ion-toolbar></ion-header><ion-content><iframe class="ds-frame" :src="dsUrl" title="DolphinScheduler" /></ion-content></ion-modal>
    <ion-modal :is-open="logOpen" class="log-modal" @did-dismiss="closeLog">
      <ion-header class="ion-no-border"><ion-toolbar><ion-buttons slot="start"><ion-button @click="logOpen = false">关闭</ion-button></ion-buttons><ion-title>实例日志</ion-title><ion-buttons slot="end"><ion-button :disabled="logLoading || !activeTaskId" @click="refreshLog"><ion-icon :icon="refreshOutline" /></ion-button></ion-buttons></ion-toolbar></ion-header>
      <ion-content :fullscreen="true">
        <div class="log-shell">
          <div class="log-instance"><small>WORKFLOW INSTANCE</small><strong>{{ logInstance?.name }}</strong><span>#{{ logInstance?.id }} · {{ project }}</span></div>
          <ion-select v-if="logTasks.length" v-model="activeTaskId" class="log-task-select" label="任务节点" label-placement="stacked" interface="action-sheet" @ion-change="refreshLog"><ion-select-option v-for="task in logTasks" :key="task.id" :value="task.id">{{ task.name }} · {{ task.state }}</ion-select-option></ion-select>
          <div v-if="tasksLoading" class="log-loading"><ion-spinner name="crescent" />正在加载任务节点…</div>
          <div v-else-if="!logTasks.length" class="empty-state"><ion-icon :icon="fileTrayOutline" /><strong>该实例没有任务节点</strong></div>
          <template v-else>
            <div class="log-toolbar"><span>{{ activeTask?.taskType || 'TASK' }} · #{{ activeTaskId }}</span><ion-button fill="clear" size="small" :disabled="!logContent" @click="copyLog">复制全文</ion-button></div>
            <pre class="mobile-log"><span v-if="logLoading && !logContent" class="log-loading"><ion-spinner name="crescent" />日志加载中…</span><template v-else>{{ logContent || '暂无日志' }}</template></pre>
            <ion-button expand="block" fill="outline" :disabled="logLoading || !logHasMore" @click="loadLog(true)"><ion-spinner v-if="logLoading" name="crescent" /><span v-else>{{ logHasMore ? '加载更多' : '已加载全部' }}</span></ion-button>
          </template>
          <p v-if="logError" class="inline-error">{{ logError }}</p>
        </div>
      </ion-content>
    </ion-modal>
  </ion-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { alertController, toastController, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonModal, IonPage, IonSearchbar, IonSelect, IonSelectOption, IonSpinner, IonTitle, IonToolbar } from '@ionic/vue'
import { expandOutline, fileTrayOutline, openOutline, refreshOutline } from 'ionicons/icons'
import StatusPill from '@/components/StatusPill.vue'
import { executeProcess, getTaskLog, listProcessInstances, listProjects, listTasksByProcess } from '@/api/ds'
import type { DsExecuteType, DsProcessInstance, DsProject, DsTaskInstance } from '@/types/ds'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const projects = ref<DsProject[]>([]); const project = ref(''); const instances = ref<DsProcessInstance[]>([])
const state = ref(''); const keyword = ref(''); const total = ref(0); const loading = ref(false); const error = ref(''); const webOpen = ref(false)
const logOpen = ref(false); const logInstance = ref<DsProcessInstance | null>(null); const logTasks = ref<DsTaskInstance[]>([]); const activeTaskId = ref<number | null>(null)
const tasksLoading = ref(false); const logLoading = ref(false); const logContent = ref(''); const logSkip = ref(0); const logHasMore = ref(true); const logError = ref('')
const LOG_LIMIT = 500
const states = [{ label: '全部', value: '' }, { label: '运行中', value: 'RUNNING_EXECUTION' }, { label: '失败', value: 'FAILURE' }, { label: '成功', value: 'SUCCESS' }]
const portal = (import.meta.env.VITE_PORTAL_URL as string | undefined)?.replace(/\/$/, '') || ''
const dsUrl = `${portal}/apps/dsweb/ui/#/home`
const canOperate = computed(() => auth.role !== 'viewer' && auth.canAccess('dsTask'))
const activeTask = computed(() => logTasks.value.find((task) => task.id === activeTaskId.value))
function todayRange() { const now = new Date(); const start = new Date(now); start.setHours(0, 0, 0, 0); const f = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; return { startDate: f(start), endDate: f(now) } }
function compactTime(value: string) { return value?.slice(5, 16) || '—' }
function canPause(item: DsProcessInstance) { return ['RUNNING_EXECUTION', 'SUBMITTED_SUCCESS'].includes(item.state) }
function canStop(item: DsProcessInstance) { return ['RUNNING_EXECUTION', 'SUBMITTED_SUCCESS', 'READY_PAUSE'].includes(item.state) }
async function boot() { try { projects.value = await listProjects(); project.value = projects.value[0]?.name || ''; await loadInstances() } catch (cause) { error.value = cause instanceof Error ? cause.message : '加载项目失败' } }
async function loadInstances() { if (!project.value) return; loading.value = true; error.value = ''; try { const page = await listProcessInstances(project.value, { pageNo: 1, pageSize: 50, searchVal: keyword.value || undefined, stateType: state.value || undefined, ...todayRange() }); instances.value = page.totalList; total.value = page.total } catch (cause) { error.value = cause instanceof Error ? cause.message : '加载实例失败' } finally { loading.value = false } }
async function confirmAction(item: DsProcessInstance, type: DsExecuteType, label: string) { const alert = await alertController.create({ header: `${label}工作流实例？`, message: `${item.name}\n实例 #${item.id}。请确认目标无误。`, buttons: [{ text: '取消', role: 'cancel' }, { text: `确认${label}`, role: type === 'STOP' ? 'destructive' : undefined, handler: () => runAction(item, type) }] }); await alert.present() }
async function runAction(item: DsProcessInstance, type: DsExecuteType) { try { await executeProcess(project.value, item.id, type); await loadInstances() } catch (cause) { error.value = cause instanceof Error ? cause.message : '操作失败' } }
async function openInstanceLog(item: DsProcessInstance) {
  logOpen.value = true; logInstance.value = item; tasksLoading.value = true; logError.value = ''; logTasks.value = []; activeTaskId.value = null; logContent.value = ''
  try {
    logTasks.value = await listTasksByProcess(project.value, item.id)
    const failed = logTasks.value.find((task) => ['FAILURE', 'FAILED', 'ERROR'].includes(task.state))
    activeTaskId.value = (failed || logTasks.value.at(-1))?.id ?? null
    if (activeTaskId.value) await refreshLog()
  } catch (cause) { logError.value = cause instanceof Error ? cause.message : '任务节点加载失败' } finally { tasksLoading.value = false }
}
async function refreshLog() { logSkip.value = 0; logContent.value = ''; logHasMore.value = true; await loadLog(false) }
async function loadLog(append = false) {
  if (!activeTaskId.value || logLoading.value) return
  logLoading.value = true; logError.value = ''
  try {
    const text = await getTaskLog(activeTaskId.value, append ? logSkip.value : 0, LOG_LIMIT)
    logContent.value = append && logContent.value ? `${logContent.value}\n${text}` : text
    if (text) logSkip.value = (append ? logSkip.value : 0) + LOG_LIMIT
    logHasMore.value = Boolean(text)
  } catch (cause) { logError.value = cause instanceof Error ? cause.message : '日志加载失败' } finally { logLoading.value = false }
}
async function copyLog() { await navigator.clipboard.writeText(logContent.value); (await toastController.create({ message: '日志已复制', duration: 1200, position: 'bottom' })).present() }
function closeLog() { logOpen.value = false; logInstance.value = null; logTasks.value = []; activeTaskId.value = null; logContent.value = ''; logError.value = '' }
onMounted(boot)
</script>
