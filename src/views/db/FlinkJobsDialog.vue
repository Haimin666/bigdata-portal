<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, VideoPause } from '@element-plus/icons-vue'
import { flinkJobs, flinkJobStop, type FlinkJob } from '@/api/db'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const jobs = ref<FlinkJob[]>([])
const loading = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  SUBMITTED: { label: '已提交', cls: 'info' },
  CREATED: { label: '创建中', cls: 'info' },
  RUNNING: { label: '运行中', cls: 'primary' },
  RESTARTING: { label: '重启中', cls: 'warning' },
  FINISHED: { label: '已完成', cls: 'success' },
  FAILED: { label: '失败', cls: 'danger' },
  CANCELED: { label: '已取消', cls: 'info' },
  CANCELLING: { label: '取消中', cls: 'warning' },
}

function statusInfo(s: string) {
  return STATUS_MAP[s] || { label: s || '未知', cls: 'info' }
}

async function load() {
  loading.value = true
  try {
    jobs.value = await flinkJobs()
  } catch (e) {
    ElMessage.error(`加载流任务失败:${e instanceof Error ? e.message : e}`)
  } finally {
    loading.value = false
  }
}

async function stop(jobId: string) {
  try {
    const { stopped } = await flinkJobStop(jobId)
    if (stopped) {
      ElMessage.success('已请求停止任务')
      void load()
    } else {
      ElMessage.warning('停止请求未生效,任务可能已结束')
      void load()
    }
  } catch (e) {
    ElMessage.error(`停止失败:${e instanceof Error ? e.message : e}`)
  }
}

watch(() => props.modelValue, (v) => {
  if (v) {
    void load()
    timer = setInterval(() => void load(), 5000)
  } else {
    if (timer) { clearInterval(timer); timer = null }
  }
})
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="Flink 流式任务"
    width="760px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="jobs-head">
      <span class="jobs-tip">流模式 INSERT INTO 提交的后台常驻任务。状态每 5s 自动刷新。</span>
      <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>
    <el-table :data="jobs" size="small" border max-height="420">
      <el-table-column prop="jobId" label="Job ID" min-width="230" show-overflow-tooltip />
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag :type="statusInfo(row.status).cls as any" size="small">{{ statusInfo(row.status).label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="sql" label="SQL(截断)" min-width="220" show-overflow-tooltip />
      <el-table-column prop="submittedAt" label="提交时间" width="150" />
      <el-table-column label="操作" width="90" align="center">
        <template #default="{ row }">
          <el-button
            v-if="row.status !== 'FINISHED' && row.status !== 'FAILED' && row.status !== 'CANCELED'"
            size="small"
            type="danger"
            text
            :icon="VideoPause"
            @click="stop(row.jobId)"
          >停止</el-button>
          <span v-else class="finished-mark">已结束</span>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!loading && !jobs.length" description="暂无流式任务" :image-size="60" />
  </el-dialog>
</template>

<style scoped>
.jobs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.jobs-tip {
  font-size: 12px;
  color: #909399;
}
.finished-mark {
  font-size: 12px;
  color: #c0c4cc;
}
</style>
