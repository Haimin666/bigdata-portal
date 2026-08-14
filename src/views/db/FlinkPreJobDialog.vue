<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, VideoPause, Promotion, View, Lock } from '@element-plus/icons-vue'
import { sparkAuth, flinkPrejobSubmit, flinkPrejobJobs, flinkPrejobLogs, flinkPrejobCancel, type FlinkPreJob } from '@/api/db'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

// ── 解锁(与 Spark 共用同一密码与 token,同一个 sessionStorage key)──
const SPARK_TOKEN_KEY = 'bigdata-portal.spark-token'
const writeToken = ref(sessionStorage.getItem(SPARK_TOKEN_KEY) || '')
const showAuth = ref(false)
const pwd = ref('')
const authLoading = ref(false)

async function ensureUnlock(): Promise<string | null> {
  if (writeToken.value) return writeToken.value
  const tk = await new Promise<string | null>((resolve) => {
    const done = (v: string | null) => {
      showAuth.value = false
      pwd.value = ''
      authLoading.value = false
      resolve(v)
    }
    authResolve = done
    showAuth.value = true
  })
  return tk
}
let authResolve: ((v: string | null) => void) | null = null

async function submitAuth() {
  if (!pwd.value) {
    ElMessage.warning('请输入密码')
    return
  }
  authLoading.value = true
  try {
    const { token } = await sparkAuth(pwd.value)
    writeToken.value = token
    sessionStorage.setItem(SPARK_TOKEN_KEY, token)
    ElMessage.success('已解锁(12 小时内有效)')
    authResolve?.(token)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
    authResolve?.(null)
  }
}

function cancelAuth() {
  authResolve?.(null)
}

/** 弹窗完全关闭(含 ESC):resolve 挂起的 promise,避免 ensureUnlock 永久挂起 */
function onAuthClosed() {
  authResolve?.(null)
}

// ── 提交表单 ──────────────────────────────────────────────
const name = ref('')
const queue = ref('')
const sqlText = ref('')
const submitting = ref(false)

async function submitJob() {
  const sql = sqlText.value.trim()
  if (!sql) {
    ElMessage.warning('请输入要提交的 Flink SQL 脚本')
    return
  }
  const tk = await ensureUnlock()
  if (!tk) {
    ElMessage.warning('已取消:PreJob 提交需先解锁')
    return
  }
  submitting.value = true
  try {
    const job = await flinkPrejobSubmit(name.value.trim() || `prejob-${Date.now()}`, sql, tk, queue.value.trim() || undefined)
    ElMessage.success(`已提交 ${job.jobId} (${job.appId || '等待 appId'})`)
    sqlText.value = ''
    name.value = ''
    void load()
  } catch (e) {
    ElMessage.error(`提交失败:${e instanceof Error ? e.message : e}`)
  } finally {
    submitting.value = false
  }
}

// ── 作业列表 ──────────────────────────────────────────────
const jobs = ref<FlinkPreJob[]>([])
const loading = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

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
async function load() {
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
    void load()
  } catch (e) {
    ElMessage.error(`停止失败:${e instanceof Error ? e.message : e}`)
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

watch(() => props.modelValue, (v) => {
  if (v) {
    void load()
    timer = setInterval(() => void load(), 5000)
  } else {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
})
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="Flink PreJob(yarn-per-job 独立作业)"
    width="960px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- 提交区 -->
    <div class="submit-box">
      <div class="submit-head">
        <span class="submit-tip">SQL 会包装成 pyflink 脚本以 yarn-per-job 提交为独立作业(真实占用 YARN 资源,需解锁,与 Spark 同一密码)。</span>
        <el-button
          size="small"
          :icon="writeToken ? Lock : Promotion"
          :type="writeToken ? 'success' : 'warning'"
          text
          @click="ensureUnlock"
        >{{ writeToken ? '已解锁' : '点击解锁' }}</el-button>
      </div>
      <div class="submit-row">
        <el-input v-model="name" size="small" placeholder="作业名(可选,默认 prejob-时间戳)" style="width: 220px" />
        <el-input v-model="queue" size="small" placeholder="YARN 队列(可选,默认 prejob.queue)" style="width: 220px" />
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
      <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>
    <el-table :data="jobs" size="small" border max-height="300">
      <el-table-column prop="jobId" label="Job ID" min-width="190" show-overflow-tooltip />
      <el-table-column prop="name" label="名称" min-width="120" show-overflow-tooltip />
      <el-table-column prop="appId" label="App ID" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.appId">{{ row.appId }}</span>
          <span v-else class="muted">-</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag :type="statusInfo(row.status).cls as any" size="small">{{ statusInfo(row.status).label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="queue" label="队列" width="90" />
      <el-table-column prop="submittedAt" label="提交时间" width="150" />
      <el-table-column label="操作" width="130" align="center">
        <template #default="{ row }">
          <el-button size="small" text type="primary" :icon="View" @click="showLogs(row)">日志</el-button>
          <el-button
            v-if="!['FINISHED', 'FAILED', 'KILLED', 'SUBMIT_FAILED'].includes(row.status)"
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

    <!-- 日志抽屉 -->
    <el-drawer v-model="logDrawer" title="PreJob 日志(yarn logs)" size="60%">
      <div class="log-head">
        <span v-if="logData.appId" class="log-appid">App: {{ logData.appId }}</span>
        <el-button size="small" :icon="Refresh" :loading="logLoading" @click="refreshLogs">刷新</el-button>
      </div>
      <el-alert v-if="logData.error" :title="logData.error" type="error" :closable="false" class="log-alert" />
      <pre class="log-pre">{{ logData.logs || '(无日志输出)' }}</pre>
    </el-drawer>

    <!-- 解锁弹窗(与 Spark 共用同一密码) -->
    <el-dialog v-model="showAuth" title="解锁 Flink 写权限" width="360px" append-to-body
      :close-on-click-modal="false" :close-on-press-escape="false" @closed="onAuthClosed">
      <el-input
        v-model="pwd"
        type="password"
        placeholder="输入密码(与 Spark 写权限同一密码)"
        show-password
        @keyup.enter="submitAuth"
      />
      <template #footer>
        <el-button @click="cancelAuth">取消</el-button>
        <el-button type="primary" :loading="authLoading" @click="submitAuth">验证</el-button>
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
.jobs-tip {
  font-size: 12px;
  color: #909399;
}
.submit-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.sql-input {
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
}
.submit-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
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
  background: #1e1e1e;
  color: #d4d4d4;
  border-radius: 4px;
  padding: 10px;
  font-size: 12px;
  line-height: 1.5;
  max-height: 60vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
