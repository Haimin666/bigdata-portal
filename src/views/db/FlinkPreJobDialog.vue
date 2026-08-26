<script setup lang="ts">
import { ref, watch, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, VideoPause, Promotion, View, Edit, SwitchButton, VideoPlay, Setting } from '@element-plus/icons-vue'
import {
  flinkPrejobSubmit, flinkPrejobJobs, flinkPrejobLogs, flinkPrejobCancel,
  flinkPrejobEnable, flinkPrejobDisable, flinkPrejobUpdate,
  flinkJobs, flinkJobStop,
  type FlinkPreJob, type FlinkPreJobResources, type FlinkJob
} from '@/api/db'
import LogViewer from '@/components/LogViewer.vue'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const activeTab = ref<'prejob' | 'stream'>('prejob')

// ── 提交 ──────────────────────────────────────────────────
const name = ref('')
const queue = ref('')
const sqlText = ref('')
const submitting = ref(false)
const resOpen = ref(false)
const resources = reactive<FlinkPreJobResources>({
  parallelism: undefined,
  jobManagerMemory: '',
  taskManagerMemory: '',
  slotsPerTaskManager: undefined
})

function collectResources(): FlinkPreJobResources {
  const r: FlinkPreJobResources = {}
  if (resources.parallelism) r.parallelism = Number(resources.parallelism)
  if (resources.jobManagerMemory) r.jobManagerMemory = resources.jobManagerMemory
  if (resources.taskManagerMemory) r.taskManagerMemory = resources.taskManagerMemory
  if (resources.slotsPerTaskManager) r.slotsPerTaskManager = Number(resources.slotsPerTaskManager)
  return r
}

function resetResources() {
  resources.parallelism = undefined
  resources.jobManagerMemory = ''
  resources.taskManagerMemory = ''
  resources.slotsPerTaskManager = undefined
}

async function submitJob() {
  const sql = sqlText.value.trim()
  if (!sql) {
    ElMessage.warning('请输入要提交的 Flink SQL 脚本')
    return
  }
  submitting.value = true
  try {
    const job = await flinkPrejobSubmit(
      name.value.trim() || `prejob-${Date.now()}`,
      sql,
      undefined,
      queue.value.trim() || undefined,
      collectResources()
    )
    ElMessage.success(`已提交 ${job.jobId} (${job.appId || '等待 appId'})`)
    sqlText.value = ''
    name.value = ''
    resetResources()
    void loadPrejob()
  } catch (e) {
    ElMessage.error(`提交失败:${e instanceof Error ? e.message : e}`)
  } finally {
    submitting.value = false
  }
}

// ── PreJob 作业列表 ───────────────────────────────────────
const jobs = ref<FlinkPreJob[]>([])
const loading = ref(false)

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  SUBMITTING: { label: '提交中', cls: 'warning' },
  SUBMITTED: { label: '已提交', cls: 'info' },
  NEW: { label: '新建', cls: 'info' },
  ACCEPTED: { label: '已接受', cls: 'info' },
  RUNNING: { label: '运行中', cls: 'primary' },
  FINISHED: { label: '已完成', cls: 'success' },
  FAILED: { label: '失败', cls: 'danger' },
  KILLED: { label: '已停止', cls: 'info' },
  SUBMIT_FAILED: { label: '提交失败', cls: 'danger' },
}

function statusInfo(s: string) {
  return STATUS_MAP[s] || { label: s || '未知', cls: 'info' }
}

let loadSeq = 0 // 轮询请求序号:丢弃慢响应,防旧数据覆盖新响应
async function loadPrejob() {
  const seq = ++loadSeq
  loading.value = true
  try {
    const data = await flinkPrejobJobs()
    if (seq !== loadSeq) return
    jobs.value = data
  } catch (e) {
    if (seq !== loadSeq) return
    ElMessage.error(`加载 PreJob 列表失败:${e instanceof Error ? e.message : e}`)
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

async function stopJob(jobId: string) {
  try {
    const { cancelled } = await flinkPrejobCancel(jobId)
    if (cancelled) ElMessage.success('已请求停止作业')
    else ElMessage.warning('停止未生效,作业可能已结束')
    void loadPrejob()
  } catch (e) {
    ElMessage.error(`停止失败:${e instanceof Error ? e.message : e}`)
  }
}

async function disableJob(row: FlinkPreJob) {
  try {
    await ElMessageBox.confirm(`确认下线任务「${row.name}」?将停止当前运行并标记停用。`, '下线确认', { type: 'warning' })
  } catch {
    return
  }
  try {
    await flinkPrejobDisable(row.jobId)
    ElMessage.success('已下线')
    void loadPrejob()
  } catch (e) {
    ElMessage.error(`下线失败:${e instanceof Error ? e.message : e}`)
  }
}

async function enableJob(row: FlinkPreJob) {
  try {
    await ElMessageBox.confirm(`确认上线任务「${row.name}」?将按已保存定义重新提交到 YARN。`, '上线确认', { type: 'info' })
  } catch {
    return
  }
  try {
    const job = await flinkPrejobEnable(row.jobId)
    ElMessage.success(`已上线 ${job.jobId} (${job.appId || '等待 appId'})`)
    void loadPrejob()
  } catch (e) {
    ElMessage.error(`上线失败:${e instanceof Error ? e.message : e}`)
  }
}

function fmtResources(res: Record<string, string | number> | undefined): string {
  const r = res || {}
  const parts: string[] = []
  if (r.parallelism) parts.push(`并行 ${r.parallelism}`)
  if (r.jobManagerMemory) parts.push(`JM ${r.jobManagerMemory}`)
  if (r.taskManagerMemory) parts.push(`TM ${r.taskManagerMemory}`)
  if (r.slotsPerTaskManager) parts.push(`槽 ${r.slotsPerTaskManager}`)
  return parts.join(' / ') || '-'
}

// ── 流任务(交互/异步,统一列表) ───────────────────────────
const streamJobs = ref<FlinkJob[]>([])
const streamLoading = ref(false)
let streamSeq = 0

async function loadStream() {
  const seq = ++streamSeq
  streamLoading.value = true
  try {
    const data = await flinkJobs()
    if (seq !== streamSeq) return
    streamJobs.value = data
  } catch (e) {
    if (seq !== streamSeq) return
    ElMessage.error(`加载流任务失败:${e instanceof Error ? e.message : e}`)
  } finally {
    if (seq === streamSeq) streamLoading.value = false
  }
}

async function stopStreamJob(jobId: string) {
  try {
    const { stopped } = await flinkJobStop(jobId)
    if (stopped) ElMessage.success('已请求停止流任务')
    else ElMessage.warning('停止未生效')
    void loadStream()
  } catch (e) {
    ElMessage.error(`停止失败:${e instanceof Error ? e.message : e}`)
  }
}

function loadActive() {
  if (activeTab.value === 'prejob') void loadPrejob()
  else void loadStream()
}

// ── 编辑 ──────────────────────────────────────────────────
const editDialog = ref(false)
const editing = ref<FlinkPreJob | null>(null)
const editSaving = ref(false)
const editName = ref('')
const editQueue = ref('')
const editSql = ref('')
const editRes = reactive<FlinkPreJobResources>({
  parallelism: undefined,
  jobManagerMemory: '',
  taskManagerMemory: '',
  slotsPerTaskManager: undefined
})

function openEdit(row: FlinkPreJob) {
  editing.value = row
  editName.value = row.name
  editQueue.value = row.queue || ''
  editSql.value = row.sql || ''
  const r = row.resources || {}
  editRes.parallelism = Number(r.parallelism) || undefined
  editRes.jobManagerMemory = String(r.jobManagerMemory || '')
  editRes.taskManagerMemory = String(r.taskManagerMemory || '')
  editRes.slotsPerTaskManager = Number(r.slotsPerTaskManager) || undefined
  editDialog.value = true
}

async function saveEdit() {
  if (!editing.value) return
  const patch: { name?: string; sql?: string; queue?: string; resources?: FlinkPreJobResources } = {
    name: editName.value.trim(),
    sql: editSql.value.trim(),
  }
  if (editQueue.value.trim()) patch.queue = editQueue.value.trim()
  const res: FlinkPreJobResources = {}
  if (editRes.parallelism) res.parallelism = Number(editRes.parallelism)
  if (editRes.jobManagerMemory) res.jobManagerMemory = editRes.jobManagerMemory
  if (editRes.taskManagerMemory) res.taskManagerMemory = editRes.taskManagerMemory
  if (editRes.slotsPerTaskManager) res.slotsPerTaskManager = Number(editRes.slotsPerTaskManager)
  patch.resources = res
  editSaving.value = true
  try {
    await flinkPrejobUpdate(editing.value.jobId, patch)
    ElMessage.success('已保存任务定义')
    editDialog.value = false
    void loadPrejob()
  } catch (e) {
    ElMessage.error(`保存失败:${e instanceof Error ? e.message : e}`)
  } finally {
    editSaving.value = false
  }
}

// ── 日志 ──────────────────────────────────────────────────
const logDrawer = ref(false)
const logLoading = ref(false)
const logData = ref<{ appId: string; logs: string; error: string }>({ appId: '', logs: '', error: '' })
const logJobId = ref('')

async function showLogs(job: FlinkPreJob) {
  logJobId.value = job.jobId
  logDrawer.value = true
  await refreshLogs()
}

async function refreshLogs() {
  if (!logJobId.value) return
  logLoading.value = true
  try {
    logData.value = await flinkPrejobLogs(logJobId.value, 300)
  } catch (e) {
    logData.value = { appId: '', logs: '', error: e instanceof Error ? e.message : String(e) }
  } finally {
    logLoading.value = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null
watch(() => props.modelValue, (v) => {
  if (v) {
    loadActive()
    timer = setInterval(loadActive, 5000)
  } else {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
})
watch(activeTab, () => loadActive())
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="Flink 任务提交 / 管理"
    width="1060px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-tabs v-model="activeTab">
      <!-- PreJob 提交/管理 -->
      <el-tab-pane label="PreJob 提交/管理" name="prejob">
        <!-- 提交区 -->
        <div class="submit-box">
          <div class="submit-head">
            <span class="submit-tip">SQL 会包装成 pyflink 脚本以 yarn-per-job 提交为独立作业(真实占用 YARN 资源)。</span>
          </div>
          <div class="submit-row">
            <el-input v-model="name" size="small" placeholder="作业名(可选,默认 prejob-时间戳)" style="width: 240px" />
            <el-input v-model="queue" size="small" placeholder="YARN 队列(可选,默认 prejob.queue)" style="width: 200px" />
            <el-button size="small" text type="primary" :icon="Setting" @click="resOpen = !resOpen">
              {{ resOpen ? '收起资源配置' : '资源配置' }}
            </el-button>
          </div>
          <div v-if="resOpen" class="res-box">
            <el-input-number v-model="resources.parallelism as any" :min="1" :max="512" size="small" controls-position="right" placeholder="并行度" />
            <el-input v-model="resources.jobManagerMemory" size="small" placeholder="JM 内存(m,如 1024m / 1g)" style="width: 160px" />
            <el-input v-model="resources.taskManagerMemory" size="small" placeholder="TM 内存(m,如 2048m / 2g)" style="width: 160px" />
            <el-input-number v-model="resources.slotsPerTaskManager as any" :min="1" :max="128" size="small" controls-position="right" placeholder="每 TM 槽位数" />
            <span class="res-tip">缺省项走 Flink 自带默认</span>
          </div>
          <el-input
            v-model="sqlText"
            type="textarea"
            :rows="6"
            class="sql-input"
            placeholder="Flink SQL 脚本(SET / CREATE CATALOG / CREATE TABLE / INSERT INTO ...)"
          />
          <div class="submit-foot">
            <el-button type="primary" :icon="Promotion" :loading="submitting" @click="submitJob">提交作业</el-button>
          </div>
        </div>

        <!-- 列表区 -->
        <div class="jobs-head">
          <span class="jobs-tip">PreJob 作业列表(状态经 YARN REST 刷新,持久化于客户机)。每 5s 自动刷新。</span>
          <el-button size="small" :icon="Refresh" :loading="loading" @click="loadPrejob">刷新</el-button>
        </div>
        <el-table :data="jobs" size="small" border max-height="300">
          <el-table-column prop="jobId" label="Job ID" min-width="150" show-overflow-tooltip />
          <el-table-column prop="name" label="名称" min-width="110" show-overflow-tooltip>
            <template #default="{ row }">
              <span>{{ row.name }}</span>
              <el-tag v-if="!row.enabled" type="info" size="small" style="margin-left: 6px">下线</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="appId" label="App ID" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.appId">{{ row.appId }}</span>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="96" align="center">
            <template #default="{ row }">
              <el-tag :type="statusInfo(row.status).cls as any" size="small">{{ statusInfo(row.status).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="资源配置" min-width="130">
            <template #default="{ row }">{{ fmtResources(row.resources) }}</template>
          </el-table-column>
          <el-table-column prop="queue" label="队列" width="76" />
          <el-table-column prop="submittedAt" label="提交时间" width="140" />
          <el-table-column label="操作" width="200" align="center">
            <template #default="{ row }">
              <el-button size="small" text type="primary" :icon="View" @click="showLogs(row)">日志</el-button>
              <el-button size="small" text type="warning" :icon="Edit" @click="openEdit(row)">编辑</el-button>
              <el-button
                v-if="row.enabled && !['FINISHED', 'FAILED', 'KILLED', 'SUBMIT_FAILED'].includes(row.status)"
                size="small"
                text
                type="danger"
                :icon="SwitchButton"
                @click="disableJob(row)"
              >下线</el-button>
              <el-button
                v-else-if="!row.enabled"
                size="small"
                text
                type="success"
                :icon="VideoPlay"
                @click="enableJob(row)"
              >上线</el-button>
              <el-button
                v-else
                size="small"
                text
                type="danger"
                :icon="VideoPause"
                @click="stopJob(row.jobId)"
              >停止</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!loading && !jobs.length" description="暂无 PreJob 作业" :image-size="60" />
      </el-tab-pane>

      <!-- 流任务(交互/异步 + prejob 统一) -->
      <el-tab-pane label="流任务" name="stream">
        <div class="jobs-head">
          <span class="jobs-tip">统一流任务列表(交互异步 + PreJob)。每 5s 自动刷新。</span>
          <el-button size="small" :icon="Refresh" :loading="streamLoading" @click="loadStream">刷新</el-button>
        </div>
        <el-table :data="streamJobs" size="small" border max-height="340">
          <el-table-column prop="jobId" label="Job ID" min-width="170" show-overflow-tooltip />
          <el-table-column prop="sql" label="名称/SQL" min-width="200" show-overflow-tooltip />
          <el-table-column prop="mode" label="类型" width="90" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="row.mode === 'prejob' ? 'warning' : 'info'">
                {{ row.mode === 'prejob' ? 'PreJob' : '交互' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="96" align="center">
            <template #default="{ row }">
              <el-tag :type="statusInfo(row.status).cls as any" size="small">{{ statusInfo(row.status).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="submittedAt" label="提交时间" width="150" />
          <el-table-column label="操作" width="80" align="center">
            <template #default="{ row }">
              <el-button size="small" text type="danger" :icon="VideoPause" @click="stopStreamJob(row.jobId)">停止</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!streamLoading && !streamJobs.length" description="暂无流任务" :image-size="60" />
      </el-tab-pane>
    </el-tabs>

    <!-- 日志抽屉 -->
    <el-drawer v-model="logDrawer" title="PreJob 日志(yarn logs)" size="60%">
      <div class="log-head">
        <span v-if="logData.appId" class="log-appid">App: {{ logData.appId }}</span>
        <el-button size="small" :icon="Refresh" :loading="logLoading" @click="refreshLogs">刷新</el-button>
      </div>
      <el-alert v-if="logData.error" :title="logData.error" type="error" :closable="false" class="log-alert" />
      <!-- 日志体:通用 LogViewer(Monaco 只读);error 文案走 empty 兜底 -->
      <div class="log-pre">
        <LogViewer :text="logData.error ? '' : logData.logs" :empty="logData.error || '(无日志输出)'" height="100%" />
      </div>
    </el-drawer>

    <!-- 编辑弹窗 -->
    <el-dialog v-model="editDialog" title="编辑 PreJob 定义" width="720px" append-to-body>
      <div class="edit-row">
        <el-input v-model="editName" size="small" placeholder="作业名" />
      </div>
      <div class="edit-row">
        <el-input v-model="editQueue" size="small" placeholder="YARN 队列(可选)" />
      </div>
      <div class="edit-row">
        <el-input-number v-model="editRes.parallelism as any" :min="1" :max="512" size="small" controls-position="right" placeholder="并行度" />
        <el-input v-model="editRes.jobManagerMemory" size="small" placeholder="JM 内存" style="width: 150px" />
        <el-input v-model="editRes.taskManagerMemory" size="small" placeholder="TM 内存" style="width: 150px" />
        <el-input-number v-model="editRes.slotsPerTaskManager as any" :min="1" :max="128" size="small" controls-position="right" placeholder="槽位数" />
      </div>
      <div class="edit-row">
        <el-input
          v-model="editSql"
          type="textarea"
          :rows="10"
          class="sql-input"
          placeholder="Flink SQL 脚本"
        />
      </div>
      <p class="edit-tip">已运行的任务编辑后不会自动重启;需先「下线」再「上线」使新定义生效。</p>
      <template #footer>
        <el-button @click="editDialog = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
.submit-box {
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 12px;
}
.submit-head,
.jobs-head,
.log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.submit-tip,
.jobs-tip,
.res-tip,
.edit-tip {
  font-size: 12px;
  color: #909399;
}
.submit-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: center;
}
.res-box {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 0 8px;
}
.sql-input {
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
}
.submit-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
.edit-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: center;
}
.muted {
  color: #c0c4cc;
}
.log-appid {
  font-size: 12px;
  color: #909399;
}
.log-alert {
  margin-bottom: 8px;
}
.log-pre {
  /* LogViewer(Monaco)自带滚动与配色,容器只定高 */
  height: calc(100% - 40px);
  border-radius: 4px;
  overflow: hidden;
}
</style>
