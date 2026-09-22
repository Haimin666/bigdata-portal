<template><span class="status-pill" :class="tone">{{ label }}</span></template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ status: string | number }>()
const normalized = computed(() => String(props.status).toUpperCase())
const tone = computed(() => {
  if (['RUNNING', 'ACCEPTED', 'SUBMITTED_SUCCESS', 'RUNNING_EXECUTION', 'RUNNING_EXEUTION'].includes(normalized.value)) return 'running'
  if (['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'FINISHED', 'ONLINE', '1'].includes(normalized.value)) return 'success'
  if (['FAILED', 'FAILURE', 'ERROR', 'NEED_FAULT_TOLERANCE'].includes(normalized.value)) return 'danger'
  if (['PAUSED', 'READY_PAUSE'].includes(normalized.value)) return 'warning'
  return 'neutral'
})
const labels: Record<string, string> = {
  RUNNING: '运行中', ACCEPTED: '等待中', SUCCESS: '成功', SUCCEEDED: '成功',
  FAILURE: '失败', FAILED: '失败', ERROR: '异常', PAUSED: '已暂停', STOP: '已停止',
  KILLED: '已终止', RUNNING_EXECUTION: '运行中', RUNNING_EXEUTION: '运行中', SUBMITTED_SUCCESS: '已提交',
  ONLINE: '已上线', OFFLINE: '已下线', 1: '已上线', 0: '已下线'
}
const label = computed(() => labels[normalized.value] || props.status || '未知')
</script>
