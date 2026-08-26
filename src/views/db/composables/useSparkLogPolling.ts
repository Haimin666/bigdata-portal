/**
 * Spark driver 日志轮询 composable(自 QueryView.vue 迁出,2026-08):
 *  - 轮询状态:日志文本/offset/stage 进度/文件大小基线
 *  - [stage] 完成行解析(audit 日志)与 statusTracker 活跃 stage 合并
 *  - start/stop/clear/poll 手动刷新
 * 展示层(容器高度→保留行数/贴底滚动)仍在 components/SparkLogPanel.vue,
 * 通过 maxLines getter 注入保留行数。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { sparkLogs, sparkStages, type SparkStage, type SparkStagesData } from '@/api/db'

export interface UseSparkLogPollingOptions {
  /** 当前引擎(sparksql/pyspark 才同节奏轮询 stage 接口) */
  engine: Ref<string>
  /** 查询是否执行中(日志空状态提示用) */
  loading: Ref<boolean>
  /** 当前激活面板(0=日志;>0 取对应结果 tab 的错误信息) */
  activePane: Ref<number>
  /** 结果 tab 列表(空状态提示读取当前结果的 error) */
  results: Ref<Array<{ error?: string } | null>>
  /** SparkLogPanel 实例引用(maxLines 由组件按可视高度计算) */
  panelRef: Ref<{ maxLines: number } | null | undefined>
}

const EMPTY_STAGES: SparkStagesData = { activeJobs: [], stages: [], numActiveJobs: 0, numActiveStages: 0 }

export function useSparkLogPolling(opts: UseSparkLogPollingOptions) {
  const sparkLogText = ref('')
  const sparkLogOffsets = ref<{ jvm: number; audit: number }>({ jvm: 0, audit: 0 })
  const sparkStageData = ref<SparkStagesData>({ ...EMPTY_STAGES })
  let sparkLogTimer: number | null = null
  let sparkLogSeq = 0 // 查询批次标记:丢弃在途旧轮询响应,防止旧日志污染新查询
  const sparkLogFileSizes = ref<{ jvm: number; audit: number }>({ jvm: 0, audit: 0 })

  /** [stage] 完成行解析(db-proxy 在查询结束时写入 audit 日志):
   *   [stage] done stage=<id> status=<STATUS> tasks=<done>/<total> name=<name> */
  const stageDoneLineRe = /\[stage\] done stage=(\d+) status=(\w+) tasks=(\d+)\/(\d+) name=(.*)$/
  function parseStageDoneLines(chunk: string): SparkStage[] {
    const out: SparkStage[] = []
    for (const line of chunk.split('\n')) {
      const m = line.match(stageDoneLineRe)
      if (!m) continue
      const done = Number(m[3])
      const total = Number(m[4])
      out.push({
        stageId: Number(m[1]),
        name: m[5],
        status: m[2].toUpperCase(),
        numTasks: total,
        completedTasks: done,
        failedTasks: 0
      })
    }
    return out
  }

  /** 把 [stage] 完成行合并进面板状态(终态,直接覆盖/新增;完成后仍可追溯) */
  function applyParsedStages(stages: SparkStage[]) {
    if (!stages.length) return
    const map = new Map(sparkStageData.value.stages.map((s) => [s.stageId, s]))
    for (const s of stages) map.set(s.stageId, s)
    sparkStageData.value = {
      ...sparkStageData.value,
      stages: [...map.values()].sort((a, b) => a.stageId - b.stageId)
    }
  }

  /** 把 statusTracker 活跃 stage 合并进面板状态(终态不被 RUNNING 覆盖) */
  function applySparkStages(st: SparkStagesData) {
    const map = new Map(sparkStageData.value.stages.map((s) => [s.stageId, s]))
    for (const s of st.stages) {
      const prev = map.get(s.stageId)
      if (prev && (prev.status === 'SUCCEEDED' || prev.status === 'FAILED')) continue
      map.set(s.stageId, s)
    }
    sparkStageData.value = {
      activeJobs: st.activeJobs,
      numActiveJobs: st.numActiveJobs,
      numActiveStages: st.numActiveStages,
      stages: [...map.values()].sort((a, b) => a.stageId - b.stageId)
    }
  }

  /** 拉取 spark 日志增量并追加(基线由 clearSparkLogs 在查询开始前建立,这里读到的都是新增) */
  async function pollSparkLogs() {
    const seq = sparkLogSeq
    try {
      const data = await sparkLogs(sparkLogOffsets.value)
      if (seq !== sparkLogSeq) return // 已有新查询/已清空,丢弃过期响应
      sparkLogFileSizes.value = data.files
      if (data.content) {
        sparkLogText.value += data.content
        // 保留行数按日志容器可视高度动态计算(由 SparkLogPanel 维护,填满即滚动打印)
        const maxLogLines = opts.panelRef.value?.maxLines ?? 200
        const lines = sparkLogText.value.split('\n')
        if (lines.length > maxLogLines) sparkLogText.value = lines.slice(-maxLogLines).join('\n')
        // 解析 [stage] 完成行 → 更新 Stage 进度(查询结束后由 db-proxy 写入)
        applyParsedStages(parseStageDoneLines(data.content))
      }
      sparkLogOffsets.value = data.offsets
      // spark 引擎:同节奏轮询 job/stage 进度(statusTracker,与 [stage] 行按 stageId 合并)
      if (opts.engine.value === 'sparksql' || opts.engine.value === 'pyspark') {
        try {
          const st = await sparkStages()
          if (seq === sparkLogSeq) applySparkStages(st)
        } catch {
          /* stage 接口不可用不影响日志 */
        }
      }
    } catch {
      /* 日志接口失败不打断查询 */
    }
  }

  function stopSparkLogPolling() {
    if (sparkLogTimer != null) {
      window.clearInterval(sparkLogTimer)
      sparkLogTimer = null
    }
  }

  function startSparkLogPolling() {
    stopSparkLogPolling()
    void pollSparkLogs()
    sparkLogTimer = window.setInterval(() => void pollSparkLogs(), 3000)
  }

  /** 清空并建立新基线:offset 跳到已知文件末尾,新查询只展示新增日志。
   *  会话首次(未知文件大小)先探一次拿到当前大小,避免读到既有历史日志(含旧查询的 [stage] 行)。 */
  async function clearSparkLogs() {
    sparkLogSeq++ // 使在途 pollSparkLogs 响应失效
    sparkLogText.value = ''
    sparkStageData.value = { ...EMPTY_STAGES }
    if (sparkLogFileSizes.value.jvm === 0 && sparkLogFileSizes.value.audit === 0) {
      try {
        const base = await sparkLogs({ jvm: 0, audit: 0 })
        sparkLogFileSizes.value = base.files
      } catch {
        /* 探基线失败则沿用 {0,0},代价是本次会读到历史日志 */
      }
    }
    sparkLogOffsets.value = { ...sparkLogFileSizes.value }
  }

  /** 日志空状态提示:区分执行中/成功/失败,避免“查询成功时面板看起来像收起” */
  const logEmptyHint = computed(() => {
    if (opts.engine.value !== 'sparksql' && opts.engine.value !== 'pyspark' && opts.engine.value !== 'flinksql') {
      return '(该引擎不产生引擎日志)'
    }
    if (opts.loading.value) return '(等待引擎输出…)'
    const cur = opts.activePane.value > 0 ? opts.results.value[opts.activePane.value - 1] : null
    if (cur?.error) return '(查询失败,详见结果 tab 错误信息;下方为引擎日志)'
    return '(查询成功,无引擎日志输出)'
  })

  return {
    sparkLogText,
    sparkLogOffsets,
    sparkStageData,
    logEmptyHint,
    parseStageDoneLines,
    applySparkStages,
    pollSparkLogs,
    startSparkLogPolling,
    stopSparkLogPolling,
    clearSparkLogs
  }
}

export type SparkLogPolling = ReturnType<typeof useSparkLogPolling>
export type { ComputedRef }
