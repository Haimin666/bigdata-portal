<template>
  <ion-page>
    <ion-header class="ion-no-border"><ion-toolbar><ion-title>离线开发</ion-title><ion-buttons slot="end"><ion-button @click="webOpen = true"><ion-icon :icon="openOutline" /></ion-button></ion-buttons></ion-toolbar></ion-header>
    <ion-content :fullscreen="true"><main class="page-shell offline-shell">
      <button class="full-dev-banner" @click="webOpen = true"><span><small>FULL CONSOLE</small><strong>打开完整开发平台</strong><em>编辑 DAG 与节点配置建议横屏操作</em></span><ion-icon :icon="expandOutline" /></button>
      <ion-segment v-model="view" class="offline-tabs two-tabs" mode="ios"><ion-segment-button value="projects"><ion-label>项目</ion-label></ion-segment-button><ion-segment-button value="workflows"><ion-label>工作流</ion-label></ion-segment-button></ion-segment>

      <section v-if="view !== 'projects'" class="control-strip compact-controls">
        <ion-select v-model="project" label="当前项目" interface="action-sheet" @ion-change="onProjectChange"><ion-select-option v-for="item in projects" :key="item.id" :value="item.name">{{ item.name }}</ion-select-option></ion-select>
        <ion-searchbar v-model="keyword" :placeholder="searchPlaceholder" :debounce="250" />
      </section>

      <template v-if="view === 'projects'">
        <ion-searchbar v-model="keyword" class="standalone-search" placeholder="搜索项目" :debounce="150" />
        <div class="result-meta"><span>可访问项目 · {{ filteredProjects.length }} 个</span><span v-if="loading">同步中…</span></div>
        <section class="card-stack"><button v-for="item in filteredProjects" :key="item.id" class="project-card" @click="selectProject(item)"><span class="project-mark">{{ item.name.slice(0, 1).toUpperCase() }}</span><span><strong>{{ item.name }}</strong><small>{{ item.description || '暂无项目描述' }}</small></span><ion-icon :icon="chevronForwardOutline" /></button></section>
      </template>

      <template v-else-if="view === 'workflows'">
        <div class="result-meta"><span>工作流 · {{ filteredWorkflows.length }} 条</span><span v-if="loading">同步中…</span></div>
        <section class="card-stack">
          <article v-for="item in filteredWorkflows" :key="item.id" class="ops-card workflow-card" :class="{ expanded: isWorkflowExpanded(item) }">
            <div class="card-top"><StatusPill :status="item.releaseState" /><span class="mono-id">#{{ item.id }}</span></div>
            <div class="workflow-main">
              <span>
                <strong>{{ item.name }}</strong>
                <small>{{ item.createUser || '—' }} · 更新 {{ compactTime(item.updateTime || '') }}</small>
              </span>
            </div>
            <button class="workflow-task-toggle" type="button" @click="toggleWorkflow(item)">
              <span>
                <strong>{{ isWorkflowExpanded(item) ? '收起近 2 天任务' : '查看近 2 天任务' }}</strong>
                <small>{{ workflowTaskSummary(item) }}</small>
              </span>
              <ion-icon :icon="isWorkflowExpanded(item) ? chevronUpOutline : chevronDownOutline" />
            </button>
            <div class="workflow-actions">
              <button type="button" @click="openWorkflow(item)"><small>查看</small><strong>详情</strong></button>
              <button v-if="canOperate" type="button" :disabled="busy" @click="confirmWorkflowRelease(item)"><small>工作流</small><strong>{{ isOnline(item.releaseState) ? '下线' : '上线' }}</strong></button>
              <button v-if="canOperate" type="button" :disabled="busy || !isOnline(item.releaseState)" @click="confirmStart(item)"><small>手动</small><strong>启动一次</strong></button>
              <button v-if="canOperate" type="button" :disabled="busy || workflowScheduleState(item).loading" @click="openScheduleActions(item)"><small>定时</small><strong>{{ workflowScheduleLabel(item) }}</strong></button>
            </div>
            <div v-if="isWorkflowExpanded(item)" class="workflow-expanded">
              <div class="expanded-title">
                <span>近 2 天任务实例</span>
                <button type="button" :disabled="workflowTaskState(item).loading" @click="loadWorkflowTasks(item, true)">刷新</button>
              </div>
              <div v-if="workflowTaskState(item).loading" class="inline-loading"><ion-spinner name="crescent" />加载任务实例…</div>
              <p v-else-if="workflowTaskState(item).error" class="inline-error">{{ workflowTaskState(item).error }}</p>
              <div v-else-if="workflowTaskState(item).instances.length || workflowTaskState(item).tasks.length" class="workflow-run-stack">
                <article v-for="instance in workflowTaskState(item).instances" :key="instance.id" class="workflow-instance">
                  <div class="instance-head"><StatusPill :status="instance.state" /><span>#{{ instance.id }}</span></div>
                  <strong>{{ instance.name }}</strong>
                  <small>{{ compactTime(instance.startTime) }} · {{ instance.duration || 0 }}s · {{ instance.executorName || '—' }}</small>
                  <div class="instance-actions">
                    <button type="button" @click="openInstanceLog(instance)">任务日志</button>
                    <template v-if="canOperate">
                      <button v-if="canStop(instance)" type="button" :disabled="busy" @click="confirmWorkflowInstance(item, instance, 'STOP', '停止')">停止</button>
                      <button type="button" :disabled="busy" @click="confirmWorkflowInstance(item, instance, 'REPEAT_RUNNING', '重跑')">重跑</button>
                    </template>
                  </div>
                </article>
                <div class="expanded-title sub-title"><span>任务实例日志</span></div>
                <div class="inline-task-list">
                <button v-for="task in workflowTaskState(item).tasks" :key="`${task.processInstanceId}-${task.id}`" type="button" class="inline-task" @click="openTaskLog(task)">
                  <StatusPill :status="task.state" />
                  <span>
                    <strong>{{ task.name }}</strong>
                    <small>{{ task._instanceName || task.processInstanceName || '工作流实例' }} · {{ compactTime(task.startTime) }}</small>
                  </span>
                </button>
                </div>
              </div>
              <div v-else class="compact-empty">近 2 天暂无实例或任务</div>
            </div>
          </article>
        </section>
      </template>
      <div v-if="!loading && !activeCount" class="empty-state"><ion-icon :icon="fileTrayOutline" /><strong>暂无数据</strong><span>请选择项目或调整筛选条件</span></div><p v-if="error" class="inline-error">{{ error }}</p>
    </main></ion-content>

    <ion-modal :is-open="workflowOpen" class="detail-modal" @did-dismiss="closeWorkflow"><ion-header class="ion-no-border"><ion-toolbar><ion-buttons slot="start"><ion-button @click="workflowOpen = false">关闭</ion-button></ion-buttons><ion-title>工作流详情</ion-title></ion-toolbar></ion-header><ion-content :fullscreen="true"><div v-if="workflowDetail" class="detail-shell"><div class="workflow-heading"><StatusPill :status="workflowDetail.releaseState" /><h2>{{ workflowDetail.name }}</h2><p>{{ workflowDetail.description || '暂无描述' }}</p></div><div class="profile-list"><div><span>工作流 ID</span><strong>{{ workflowDetail.id }}</strong></div><div><span>创建人</span><strong>{{ workflowDetail.createUser || '—' }}</strong></div><div><span>修改人</span><strong>{{ workflowDetail.modifyUser || '—' }}</strong></div><div><span>更新时间</span><strong>{{ workflowDetail.updateTime || '—' }}</strong></div><div><span>任务节点</span><strong>{{ workflowTasks.length }} 个</strong></div></div><section class="section-block"><div class="section-title"><h3>任务节点</h3></div><div class="node-cloud"><span v-for="node in workflowTasks" :key="node.id || node.name">{{ node.name }} · {{ node.type || node.taskType }}</span><span v-if="!workflowTasks.length">暂无节点信息</span></div></section><section class="section-block"><div class="section-title"><h3>定时调度</h3><span>{{ schedules.length }} 条</span></div><div class="card-stack"><article v-for="schedule in schedules" :key="schedule.id" class="schedule-card"><div><StatusPill :status="schedule.releaseState" /><strong>{{ schedule.crontab || '未配置 CRON' }}</strong><small>#{{ schedule.id }} · {{ schedule.workerGroup || 'default' }}</small></div><ion-button v-if="canOperate" fill="outline" size="small" :disabled="busy" @click="confirmSchedule(schedule)">{{ isOnline(schedule.releaseState) ? '下线' : '上线' }}</ion-button></article><div v-if="!schedules.length" class="empty-state compact-empty">暂无定时</div></div></section></div><div v-else class="log-loading"><ion-spinner name="crescent" />详情加载中…</div></ion-content></ion-modal>
    <ion-modal :is-open="webOpen" class="web-modal" @did-dismiss="webOpen = false"><ion-header><ion-toolbar><ion-buttons slot="start"><ion-button @click="webOpen = false">关闭</ion-button></ion-buttons><ion-title>完整离线开发</ion-title></ion-toolbar></ion-header><ion-content><iframe class="ds-frame" :src="dsUrl" title="DolphinScheduler" /></ion-content></ion-modal>
    <ion-modal :is-open="logOpen" class="log-modal" @did-dismiss="closeLog"><ion-header class="ion-no-border"><ion-toolbar><ion-buttons slot="start"><ion-button @click="logOpen = false">关闭</ion-button></ion-buttons><ion-title>任务日志</ion-title><ion-buttons slot="end"><ion-button :disabled="logLoading || !activeTaskId" @click="refreshLog"><ion-icon :icon="refreshOutline" /></ion-button></ion-buttons></ion-toolbar></ion-header><ion-content :fullscreen="true"><div class="log-shell"><div class="log-instance"><small>TASK LOG</small><strong>{{ logTitle }}</strong><span>#{{ activeTaskId }} · {{ logProject }}</span></div><ion-select v-if="logTasks.length > 1" v-model="activeTaskId" class="log-task-select" label="任务节点" label-placement="stacked" interface="action-sheet" @ion-change="refreshLog"><ion-select-option v-for="task in logTasks" :key="task.id" :value="task.id">{{ task.name }} · {{ task.state }}</ion-select-option></ion-select><div v-if="tasksLoading" class="log-loading"><ion-spinner name="crescent" />正在加载任务节点…</div><template v-else-if="activeTaskId"><div class="log-toolbar"><span>{{ activeTask?.taskType || 'TASK' }} · #{{ activeTaskId }}</span><ion-button fill="clear" size="small" :disabled="!logContent" @click="copyLog">复制全文</ion-button></div><pre class="mobile-log"><span v-if="logLoading && !logContent" class="log-loading"><ion-spinner name="crescent" />日志加载中…</span><template v-else>{{ logContent || '暂无日志' }}</template></pre><ion-button expand="block" fill="outline" :disabled="logLoading || !logHasMore" @click="loadLog(true)"><ion-spinner v-if="logLoading" name="crescent" /><span v-else>{{ logHasMore ? '加载更多' : '已加载全部' }}</span></ion-button></template><div v-else class="empty-state"><ion-icon :icon="fileTrayOutline" /><strong>没有可查看的任务日志</strong></div><p v-if="logError" class="inline-error">{{ logError }}</p></div></ion-content></ion-modal>
  </ion-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { actionSheetController, alertController, toastController, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonLabel, IonModal, IonPage, IonSearchbar, IonSegment, IonSegmentButton, IonSelect, IonSelectOption, IonSpinner, IonTitle, IonToolbar } from '@ionic/vue'
import { chevronDownOutline, chevronForwardOutline, chevronUpOutline, expandOutline, fileTrayOutline, openOutline, refreshOutline } from 'ionicons/icons'
import StatusPill from '@/components/StatusPill.vue'
import { executeProcess, getTaskLog, getWorkflowDetail, listProcessInstances, listProjects, listSchedules, listTasksByProcess, listWorkflows, releaseWorkflow, setScheduleState, startWorkflow } from '@/api/ds'
import type { DsExecuteType, DsProcessDefinition, DsProcessInstance, DsProject, DsSchedule, DsTaskInstance } from '@/types/ds'
import { useAuthStore } from '@/stores/auth'

type OfflineView = 'projects' | 'workflows'
type WorkflowScheduleState = { loading: boolean; items: DsSchedule[]; error?: string }
type WorkflowTaskPreview = DsTaskInstance & { _instanceName?: string; _instanceState?: string }
type WorkflowTaskState = { loading: boolean; instances: DsProcessInstance[]; tasks: WorkflowTaskPreview[]; error?: string }
const auth = useAuthStore(); const view = ref<OfflineView>('projects'); const projects = ref<DsProject[]>([]); const project = ref(''); const workflows = ref<DsProcessDefinition[]>([])
const keyword = ref(''); const total = ref(0); const loading = ref(false); const busy = ref(false); const error = ref('')
const webOpen = ref(false); const workflowOpen = ref(false); const workflowDetail = ref<DsProcessDefinition | null>(null); const schedules = ref<DsSchedule[]>([])
const logOpen = ref(false); const logTasks = ref<DsTaskInstance[]>([]); const activeTaskId = ref<number | null>(null); const logTitle = ref(''); const logProject = ref(''); const tasksLoading = ref(false); const logLoading = ref(false); const logContent = ref(''); const logSkip = ref(0); const logHasMore = ref(true); const logError = ref(''); const LOG_LIMIT = 500
const workflowSchedules = ref<Record<string, WorkflowScheduleState>>({}); const expandedWorkflowId = ref<number | null>(null); const workflowTaskPreviews = ref<Record<string, WorkflowTaskState>>({})
const portal = (import.meta.env.VITE_PORTAL_URL as string | undefined)?.replace(/\/$/, '') || ''; const dsUrl = `${portal}/apps/dsweb/ui/#/home`
const canOperate = computed(() => auth.role !== 'viewer' && auth.canAccess('dsTask'))
const filteredProjects = computed(() => projects.value.filter((item) => `${item.name} ${item.description || ''}`.toLowerCase().includes(keyword.value.toLowerCase())))
const filteredWorkflows = computed(() => workflows.value.filter((item) => item.name.toLowerCase().includes(keyword.value.toLowerCase())))
const activeCount = computed(() => ({ projects: filteredProjects.value.length, workflows: filteredWorkflows.value.length }[view.value]))
const searchPlaceholder = computed(() => view.value === 'workflows' ? '搜索工作流' : '搜索项目')
const activeTask = computed(() => logTasks.value.find((task) => task.id === activeTaskId.value))
const workflowTasks = computed<Array<{ id?: string; name?: string; type?: string; taskType?: string }>>(() => { const value = workflowDetail.value?.processDefinitionJson; if (!value) return []; try { return (typeof value === 'string' ? JSON.parse(value) : value)?.tasks || [] } catch { return [] } })
let loadSeq = 0
let detailProject = ''
let skipNextViewReload = false
const LAST_PROJECT_KEY = 'bd-mobile-offline-project'

function twoDayRange() { const now = new Date(); const start = new Date(now.getTime() - 48 * 60 * 60 * 1000); const f = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; return { startDate: f(start), endDate: f(now) } }
function compactTime(value: string) { return value?.slice(5, 16) || '—' }
function isOnline(value?: string) { return String(value).toUpperCase() === 'ONLINE' || String(value) === '1' }
function canStop(item: DsProcessInstance) { return ['RUNNING_EXECUTION', 'RUNNING_EXEUTION', 'SUBMITTED_SUCCESS', 'READY_PAUSE'].includes(item.state) }
function setError(cause: unknown, fallback: string) { error.value = cause instanceof Error ? cause.message : fallback }
function savedProjectName() { return localStorage.getItem(LAST_PROJECT_KEY) || '' }
function rememberProject(name: string) { if (name) localStorage.setItem(LAST_PROJECT_KEY, name) }
function workflowKey(item: DsProcessDefinition) { return `${item._projectName || project.value}:${item.id}` }
function workflowScheduleState(item: DsProcessDefinition): WorkflowScheduleState { return workflowSchedules.value[workflowKey(item)] || { loading: false, items: [] } }
function workflowTaskState(item: DsProcessDefinition): WorkflowTaskState { return workflowTaskPreviews.value[workflowKey(item)] || { loading: false, instances: [], tasks: [] } }
function isWorkflowExpanded(item: DsProcessDefinition) { return expandedWorkflowId.value === item.id }
function workflowScheduleLabel(item: DsProcessDefinition) { const current = workflowScheduleState(item); if (current.loading) return '定时…'; if (current.error) return '定时异常'; if (!current.items.length) return '定时'; const online = current.items.filter((schedule) => isOnline(schedule.releaseState)).length; return `定时 ${online}/${current.items.length}` }
function workflowTaskSummary(item: DsProcessDefinition) { const current = workflowTaskState(item); if (current.loading) return '正在同步实例和任务'; if (current.error) return '加载失败，点此重试'; if (current.instances.length || current.tasks.length) return `${current.instances.length} 个实例 · ${current.tasks.length} 个任务，可继续操作`; return '展开后处理实例停止、重跑和任务日志' }
async function boot() { loading.value = true; try { projects.value = await listProjects(); project.value = projects.value.find((item) => item.name === savedProjectName())?.name || projects.value[0]?.name || ''; if (project.value) { skipNextViewReload = true; view.value = 'workflows'; rememberProject(project.value); await reload() } } catch (cause) { setError(cause, '加载项目失败') } finally { loading.value = false } }
function selectProject(item: DsProject) { project.value = item.name; rememberProject(item.name); keyword.value = ''; view.value = 'workflows' }
async function onProjectChange() { rememberProject(project.value); keyword.value = ''; await reload() }
async function reload() { if (!project.value || view.value === 'projects') return; const seq = ++loadSeq; const sourceProject = project.value; loading.value = true; error.value = ''; try { const data = await listWorkflows(sourceProject); if (seq !== loadSeq) return; workflows.value = data.map((item) => ({ ...item, _projectName: sourceProject })); workflowSchedules.value = {}; workflowTaskPreviews.value = {}; expandedWorkflowId.value = null; total.value = workflows.value.length; void warmWorkflowSchedules(workflows.value.slice(0, 20)) } catch (cause) { if (seq === loadSeq) setError(cause, '数据加载失败') } finally { if (seq === loadSeq) loading.value = false } }
async function warmWorkflowSchedules(items: DsProcessDefinition[]) { for (const item of items) void ensureWorkflowSchedules(item) }
async function ensureWorkflowSchedules(item: DsProcessDefinition, force = false) { const key = workflowKey(item); const current = workflowSchedules.value[key]; if (!force && current && (current.loading || current.items.length || current.error)) return current.items; workflowSchedules.value = { ...workflowSchedules.value, [key]: { loading: true, items: current?.items || [] } }; try { const page = await listSchedules(item._projectName || project.value, item.id); workflowSchedules.value = { ...workflowSchedules.value, [key]: { loading: false, items: page.totalList } }; return page.totalList } catch (cause) { workflowSchedules.value = { ...workflowSchedules.value, [key]: { loading: false, items: [], error: cause instanceof Error ? cause.message : '定时加载失败' } }; return [] } }
async function refreshWorkflowSchedules(item: DsProcessDefinition) { await ensureWorkflowSchedules(item, true); if (workflowDetail.value?.id === item.id) schedules.value = workflowScheduleState(item).items }
async function openScheduleActions(item: DsProcessDefinition) { const items = await ensureWorkflowSchedules(item); if (!items.length) { (await toastController.create({ message: workflowScheduleState(item).error || '该工作流暂无定时', duration: 1400, position: 'bottom' })).present(); return } const sheet = await actionSheetController.create({ header: `${item.name} · 定时上下线`, buttons: [...items.map((schedule) => ({ text: `${isOnline(schedule.releaseState) ? '下线' : '上线'} · ${schedule.crontab || `#${schedule.id}`}`, role: isOnline(schedule.releaseState) ? 'destructive' : undefined, handler: () => confirmScheduleInline(item, schedule) })), { text: '取消', role: 'cancel' }] }); await sheet.present() }
function confirmScheduleInline(workflow: DsProcessDefinition, schedule: DsSchedule) { const sourceProject = workflow._projectName || project.value; const online = !isOnline(schedule.releaseState); return confirmWrite(`${online ? '上线' : '下线'}定时？`, `${workflow.name} / ${schedule.crontab || `定时 #${schedule.id}`}`, !online, () => setScheduleState(sourceProject, schedule.id, online), () => refreshWorkflowSchedules(workflow)) }
async function toggleWorkflow(item: DsProcessDefinition) { if (isWorkflowExpanded(item)) { expandedWorkflowId.value = null; return } expandedWorkflowId.value = item.id; await loadWorkflowTasks(item) }
async function loadWorkflowTasks(item: DsProcessDefinition, force = false) { const key = workflowKey(item); const current = workflowTaskPreviews.value[key]; if (!force && current && (current.loading || current.instances.length || current.tasks.length || current.error)) return; workflowTaskPreviews.value = { ...workflowTaskPreviews.value, [key]: { loading: true, instances: current?.instances || [], tasks: current?.tasks || [] } }; try { const sourceProject = item._projectName || project.value; const page = await listProcessInstances(sourceProject, { pageNo: 1, pageSize: 8, searchVal: item.name, ...twoDayRange() }); const exact = page.totalList.filter((instance) => instance.name === item.name || instance.processDefinition?.name === item.name); const related = (exact.length ? exact : page.totalList).slice(0, 6).map((instance) => ({ ...instance, _projectName: sourceProject })); const groups = await Promise.all(related.map(async (instance) => { const rows = await listTasksByProcess(sourceProject, instance.id); return rows.map((task) => ({ ...task, _projectName: sourceProject, _instanceName: instance.name, _instanceState: instance.state })) })); workflowTaskPreviews.value = { ...workflowTaskPreviews.value, [key]: { loading: false, instances: related, tasks: groups.flat().slice(0, 24) } } } catch (cause) { workflowTaskPreviews.value = { ...workflowTaskPreviews.value, [key]: { loading: false, instances: [], tasks: [], error: cause instanceof Error ? cause.message : '任务实例加载失败' } } } }
async function openWorkflow(item: DsProcessDefinition) { const sourceProject = item._projectName || project.value; workflowOpen.value = true; workflowDetail.value = null; schedules.value = []; try { const [detail, page] = await Promise.all([getWorkflowDetail(sourceProject, item.id), listSchedules(sourceProject, item.id)]); detailProject = sourceProject; workflowDetail.value = { ...detail, _projectName: sourceProject }; schedules.value = page.totalList } catch (cause) { setError(cause, '工作流详情加载失败'); workflowOpen.value = false } }
function closeWorkflow() { workflowOpen.value = false; workflowDetail.value = null; schedules.value = []; detailProject = '' }
async function confirmWrite(header: string, message: string, destructive: boolean, action: () => Promise<unknown>, refresh: () => Promise<unknown>) { const alert = await alertController.create({ header, message, buttons: [{ text: '取消', role: 'cancel' }, { text: '确认执行', role: destructive ? 'destructive' : undefined, handler: () => runWrite(action, refresh) }] }); await alert.present() }
async function runWrite(action: () => Promise<unknown>, refresh: () => Promise<unknown>) { if (busy.value) return; busy.value = true; error.value = ''; try { await action(); (await toastController.create({ message: '操作成功', duration: 1400, position: 'bottom' })).present(); await refresh() } catch (cause) { setError(cause, '操作失败') } finally { busy.value = false } }
function confirmWorkflowRelease(item: DsProcessDefinition) { const sourceProject = item._projectName || project.value; const online = !isOnline(item.releaseState); return confirmWrite(`${online ? '上线' : '下线'}工作流？`, `${sourceProject} / ${item.name}（#${item.id}）`, !online, () => releaseWorkflow(sourceProject, item.id, online), reload) }
function confirmStart(item: DsProcessDefinition) { const sourceProject = item._projectName || project.value; return confirmWrite('启动工作流？', `${sourceProject} / ${item.name}（#${item.id}），失败策略 CONTINUE。`, false, () => startWorkflow(sourceProject, item.id), reload) }
function confirmSchedule(item: DsSchedule) { const sourceProject = detailProject; const online = !isOnline(item.releaseState); return confirmWrite(`${online ? '上线' : '下线'}定时？`, `${workflowDetail.value?.name || '工作流'} / ${item.crontab || `定时 #${item.id}`}`, !online, () => setScheduleState(sourceProject, item.id, online), async () => { if (workflowDetail.value) { await openWorkflow(workflowDetail.value); await refreshWorkflowSchedules(workflowDetail.value) } }) }
function confirmWorkflowInstance(workflow: DsProcessDefinition, item: DsProcessInstance, type: DsExecuteType, label: string) { const sourceProject = item._projectName || workflow._projectName || project.value; return confirmWrite(`${label}工作流实例？`, `${item.name} / 实例 #${item.id}，请确认目标无误。`, type === 'STOP', () => executeProcess(sourceProject, item.id, type), () => loadWorkflowTasks(workflow, true)) }
async function openInstanceLog(item: DsProcessInstance) { const sourceProject = item._projectName || project.value; logOpen.value = true; logProject.value = sourceProject; logTitle.value = item.name; tasksLoading.value = true; logError.value = ''; logTasks.value = []; activeTaskId.value = null; logContent.value = ''; try { logTasks.value = await listTasksByProcess(sourceProject, item.id); const failed = logTasks.value.find((task) => ['FAILURE', 'FAILED', 'ERROR'].includes(task.state)); activeTaskId.value = (failed || logTasks.value.at(-1))?.id ?? null; if (activeTaskId.value) await refreshLog() } catch (cause) { logError.value = cause instanceof Error ? cause.message : '任务节点加载失败' } finally { tasksLoading.value = false } }
async function openTaskLog(item: DsTaskInstance) { logOpen.value = true; logProject.value = item._projectName || project.value; logTitle.value = item.name; logTasks.value = [item]; activeTaskId.value = item.id; logContent.value = ''; logError.value = ''; await refreshLog() }
async function refreshLog() { logSkip.value = 0; logContent.value = ''; logHasMore.value = true; await loadLog(false) }
async function loadLog(append = false) { if (!activeTaskId.value || logLoading.value) return; logLoading.value = true; logError.value = ''; try { const text = await getTaskLog(activeTaskId.value, append ? logSkip.value : 0, LOG_LIMIT); logContent.value = append && logContent.value ? `${logContent.value}\n${text}` : text; if (text) logSkip.value = (append ? logSkip.value : 0) + LOG_LIMIT; logHasMore.value = Boolean(text) } catch (cause) { logError.value = cause instanceof Error ? cause.message : '日志加载失败' } finally { logLoading.value = false } }
async function copyLog() { await navigator.clipboard.writeText(logContent.value); (await toastController.create({ message: '日志已复制', duration: 1200, position: 'bottom' })).present() }
function closeLog() { logOpen.value = false; logProject.value = ''; logTasks.value = []; activeTaskId.value = null; logContent.value = ''; logError.value = '' }
watch(view, async () => { keyword.value = ''; if (skipNextViewReload) { skipNextViewReload = false; return } await reload() })
onMounted(boot)
</script>
