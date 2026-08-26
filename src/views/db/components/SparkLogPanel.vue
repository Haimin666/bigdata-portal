<script setup lang="ts">
// Spark 日志面板(自 QueryView.vue 拆出,2026-08):
// 「Spark 日志」结果页签的内容区 —— driver/audit 增量日志终端式滚动打印 + Stage 进度条。
// 轮询与状态(sparkLogText/sparkStageData 等)留在父组件(与执行流程强耦合),本组件只做:
//   1. 展示日志文本 + 空态提示;
//   2. 按容器可视高度动态计算保留行数(updateMaxLogLines)并在内容变化后贴底滚动;
//   3. Stage 进度条渲染。
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { SparkStage, SparkStagesData } from '@/api/db'

const props = defineProps<{
  logText: string
  emptyHint: string
  stageData: SparkStagesData
  active: boolean // 该页签是否处于激活态(非激活不滚动)
}>()

const emit = defineEmits<{ (e: 'refresh'): void; (e: 'clear'): void }>()

const LOG_LINE_HEIGHT = 20 // 12px 字体 × 1.55 行高 ≈ 18.6px,取整留余量

const box = ref<HTMLElement | null>(null)
const maxLines = ref(200)

/** 容器可视高度能容纳的行数(50~500 夹取);由 ResizeObserver 在尺寸变化时重算 */
function updateMaxLogLines() {
  const el = box.value
  if (!el) return
  const visible = Math.floor((el.clientHeight - 24) / LOG_LINE_HEIGHT) // 减 padding 上下 12px×2
  maxLines.value = Math.max(50, Math.min(500, visible))
}

defineExpose({
  /** 供父级轮询读取当前保留行数(裁剪日志用) */
  maxLines,
  updateMaxLogLines
})

// 内容增量/页签切换后自动贴底(两帧等 DOM 就绪再取 scrollHeight,才能精确到底)
watch(
  () => [props.logText, props.active] as const,
  ([, act], [, prevAct]) => {
    if (!act && prevAct === false) return
    if (act) void scrollToBottom()
  }
)

function scrollToBottom() {
  const el = box.value
  if (!el) return
  void nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight
  })))
}

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  resizeObserver = new ResizeObserver(() => updateMaxLogLines())
  if (box.value) resizeObserver.observe(box.value)
  updateMaxLogLines()
})
onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

// ── Stage 渲染辅助(逐字迁自 QueryView)─────────────────────
function stagePct(s: SparkStage): number {
  return s.numTasks > 0 ? Math.round((s.completedTasks / s.numTasks) * 100) : 0
}
function stageProgressStatus(s: SparkStage): '' | 'success' | 'exception' {
  if (s.status === 'FAILED') return 'exception'
  if (s.status === 'SUCCEEDED') return 'success'
  return ''
}
function stageStatusClass(s: string): string {
  return String(s || 'UNKNOWN').toLowerCase()
}
</script>

<template>
  <div class="spark-logs-panel">
    <div class="spark-logs-head">
      <span class="spark-logs-title">Driver / Audit 日志(增量)</span>
      <span class="spark-logs-actions">
        <el-button text size="small" @click="emit('refresh')">刷新</el-button>
        <el-button text size="small" @click="emit('clear')">清空</el-button>
      </span>
    </div>
    <div v-if="stageData.stages.length" class="spark-stages">
      <div class="spark-stages-head">
        <span class="spark-stages-title">Stage 进度</span>
        <span v-if="stageData.numActiveJobs" class="spark-stages-meta">
          {{ stageData.numActiveJobs }} 个活跃 Job · {{ stageData.numActiveStages }} 个活跃 Stage
        </span>
      </div>
      <div v-for="s in stageData.stages" :key="s.stageId" class="spark-stage">
        <div class="spark-stage-line">
          <span class="spark-stage-id">Stage {{ s.stageId }}</span>
          <span class="spark-stage-name" :title="s.name">{{ s.name }}</span>
          <span class="spark-stage-status" :class="stageStatusClass(s.status)">{{ s.status }}</span>
          <span class="spark-stage-count">{{ s.completedTasks }}/{{ s.numTasks }} tasks</span>
        </div>
        <el-progress
          :percentage="stagePct(s)"
          :show-text="false"
          :stroke-width="5"
          :status="stageProgressStatus(s)"
        />
      </div>
    </div>
    <pre ref="box" class="spark-logs-body">{{ logText || emptyHint }}</pre>
  </div>
</template>

<style scoped lang="scss">
.spark-logs-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.spark-logs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 14px;

  .spark-logs-title {
    font-size: 12px;
    font-weight: 600;
  }

  .spark-logs-actions {
    display: flex;
    gap: 2px;
  }
}
</style>
