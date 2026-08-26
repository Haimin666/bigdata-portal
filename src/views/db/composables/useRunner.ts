/**
 * useRunner —— DB 查询执行编排(自 QueryView.vue 拆出,2026-08):
 * 引擎执行器(spark/pyspark/flink/mysql-oracle 异步任务轮询)、批次互斥与停止、
 * 执行历史(localStorage)。展示层(results tab/日志面板)留在视图组件,经 ctx 注入。
 * 纯逻辑层:不持有 DOM/编辑器引用;所有外部能力经 ctx 传入,便于单测与复用。
 */
import { ref, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  queryFlink,
  cancelFlink,
  flinkAsyncSubmit,
  flinkAsyncStatus,
  flinkAsyncCancel,
  cancelSpark,
  submitSparkJob,
  getSparkJob,
  cancelSparkJob,
  submitDbJob,
  getDbJob,
  cancelDbJob
} from '@/api/db'
import type { QueryResultItem } from '../queryTypes'
import { splitSqlSegments } from './useSqlParse'

/** 执行上下文:宿主组件注入的状态与回调(解耦点) */
export interface RunnerCtx {
  /** 当前引擎('' 表示未选) */
  engine: Ref<'mysql' | 'oracle' | 'sparksql' | 'pyspark' | 'flinksql' | ''>
  /** 当前库 */
  db: Ref<string>
  /** 批次执行中(互斥位,宿主持有:模板按钮态也用它) */
  loading: Ref<boolean>
  /** 全局错误条文案 */
  error: Ref<string>
  /** 结果列表(追加式结果 tab)与当前激活面板(0=日志) */
  results: Ref<QueryResultItem[]>
  activePane: Ref<number>
  /** 每批最多保留的结果数(超出裁掉最旧) */
  maxResults: number
  /** 数据源过滤后的候选(ensureDb 自动兜底用) */
  filteredDbs: () => Array<{ type?: string; name: string }>
  /** 取待执行 SQL(选区/光标段/全文,宿主编辑器层实现) */
  getSqlToRun: () => string
  /** 变量收集与替换(参数栏实现) */
  collectRunVars: (rawSql: string) => Map<string, string>
  expandSqlVars: (sql: string, values?: Map<string, string>) => string
  /** Spark 日志联动(sparksql/pyspark 批次开/停/收尾拉取) */
  startSparkLogPolling: () => void
  stopSparkLogPolling: () => void
  pollSparkLogs: () => Promise<void>
  clearSparkLogs: () => Promise<void>
}

const VAR_SEG_FILTER = /^\s*(--|\/\*)/

export function useRunner(ctx: RunnerCtx) {
  /** 当前 Spark 异步任务的 jobId(供停止按钮精确取消) */
  const currentSparkJobId = ref('')
  /** Flink 流式异步任务 jobId */
  const currentFlinkJobId = ref('')
  /** mysql/oracle 异步任务 jobId */
  const currentDbJobId = ref('')

  /** 判定 SQL 是否可能为写操作(与后端 server/index.js 的 isSparkWriteSql 保持一致):
   *  只读关键字开头放行;WITH 前缀且无写关键字放行;含分号/其余一律视为写。
   *  引号感知切分(字符串内分号不算多语句),并拦截 SELECT INTO OUTFILE/LOAD_FILE 走私 */
  function isSparkWriteSql(sql: string): boolean {
    const raw = String(sql)
    // MySQL/MariaDB 可执行注释 /*! ... */ 与 /*M! ... */ 会被数据库执行,绝不能当普通注释删除 —— 检测到一律视为写
    if (/\*[Mm]?!/.test(raw)) return true
    let s = raw
      .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '')
      .trim()
    if (!s) return false
    // 引号感知切分:跳过单引号字符串内的分号
    const parts: string[] = []
    let cur = ''
    let inStr = false
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (c === '\\' && i + 1 < s.length) {
        cur += c + s[i + 1]
        i++
        continue
      }
      if (c === "'") {
        inStr = !inStr
        cur += c
        continue
      }
      if (c === ';' && !inStr) {
        parts.push(cur)
        cur = ''
        continue
      }
      cur += c
    }
    parts.push(cur)

    const READ_ONLY_RE =
      /^\s*(select|show|desc|describe|explain|use|set|add\s+jar|add\s+file|list|with\b)/i
    const WRITE_RE =
      /\b(insert|update|delete|merge|create|drop|alter|truncate|rename|grant|revoke|load|msck|repair|into\s+outfile|load_file)\b/i

    for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
      if (!READ_ONLY_RE.test(p)) return true
      if (WRITE_RE.test(p)) return true
    }
    return false
  }

  /** Spark 执行:异步任务模式 —— 提交即返回 jobId,前端轮询结果。
   *  动机:公司网关固定 60s 读超时,同步长请求必被掐断 504;异步化后永不撞超时。 */
  async function execSpark(sql: string, kind: 'sql' | 'pyspark' = 'sql'): Promise<ExecOutcome> {
    const needsAuth = kind === 'pyspark' || (kind === 'sql' && isSparkWriteSql(sql))
    if (needsAuth) {
      // 写权限密码验证已移除(网关库权限矩阵管控),直接执行
    }
    const { jobId } = await submitSparkJob(sql, undefined, kind, 7200000)
    currentSparkJobId.value = jobId
    const deadline = Date.now() + 7200000 // 上限 2 小时
    while (Date.now() < deadline) {
      if (batchCancelled) {
        try {
          await cancelSparkJob(jobId)
        } catch {
          /* 忽略 */
        }
        throw new Error('已取消')
      }
      const j = await getSparkJob(jobId)
      if (j.state === 'done') {
        currentSparkJobId.value = ''
        return j.result as ExecOutcome
      }
      if (j.state === 'failed') {
        currentSparkJobId.value = ''
        throw new Error(j.error || '任务执行失败')
      }
      if (j.state === 'cancelled') {
        currentSparkJobId.value = ''
        throw new Error('已取消')
      }
      await new Promise((r) => setTimeout(r, 3000)) // 3s 轮询(低频)
    }
    try {
      await cancelSparkJob(jobId)
    } catch {
      /* 忽略 */
    }
    currentSparkJobId.value = ''
    throw new Error('任务超时(2 小时),已自动取消')
  }

  /** Flink 执行:流模式走异步任务通道;batch 模式同步秒回。 */
  async function execFlink(sql: string): Promise<ExecOutcome> {
    if (flinkMode.value !== 'stream') return queryFlink(sql, 'batch')
    // stream:异步提交 + 轮询(3s 一次,低频)
    const { jobId } = await flinkAsyncSubmit(sql, 'stream')
    currentFlinkJobId.value = jobId
    const deadline = Date.now() + 60 * 60 * 1000 // 上限 1 小时
    try {
      for (;;) {
        const j = await flinkAsyncStatus(jobId)
        if (j.state === 'done') {
          if (j.result) return j.result
          return { columns: [], rows: [], costMs: 0, truncated: true }
        }
        if (j.state === 'failed') throw new Error(j.error || '任务执行失败')
        if (Date.now() > deadline) {
          try {
            await flinkAsyncCancel(jobId)
          } catch {
            /* ignore */
          }
          throw new Error('任务超时(1 小时),已自动取消')
        }
        await new Promise((r) => setTimeout(r, 3000))
      }
    } finally {
      currentFlinkJobId.value = ''
    }
  }

  /** 执行前确保已选库:下拉有源但 db 未选中(如引擎切换/初始化时序)时自动取该引擎第一个源 */
  function ensureDb(): boolean {
    if (ctx.db.value) return true
    const candidates = ctx.filteredDbs()
    ctx.db.value =
      candidates.find((d) => d.type === ctx.engine.value)?.name || candidates[0]?.name || ''
    return !!ctx.db.value
  }

  /** mysql/oracle 执行:异步任务模式 —— 提交即返回 jobId,前端轮询(慢查询不撞网关 60s 超时)。 */
  async function execDb(sql: string): Promise<ExecOutcome> {
    if (!ensureDb()) throw new Error('请先选择数据库')
    const run = async (): Promise<ExecOutcome> => {
      const { jobId: jid } = await submitDbJob(ctx.db.value, sql, 3600000)
      currentDbJobId.value = jid
      const deadline = Date.now() + 3600000 // 上限 1 小时
      while (Date.now() < deadline) {
        if (batchCancelled) {
          try {
            await cancelDbJob(jid)
          } catch {
            /* 忽略 */
          }
          throw new Error('已取消')
        }
        const j = await getDbJob(jid)
        if (j.state === 'done') {
          currentDbJobId.value = ''
          return j.result as ExecOutcome
        }
        if (j.state === 'cancelled') {
          currentDbJobId.value = ''
          throw new Error('已取消')
        }
        if (j.state === 'failed') {
          currentDbJobId.value = ''
          throw new Error(j.error || '任务执行失败')
        }
        await new Promise((r) => setTimeout(r, 3000))
      }
      try {
        await cancelDbJob(jid)
      } catch {
        /* 忽略 */
      }
      currentDbJobId.value = ''
      throw new Error('任务超时(1 小时),已自动取消')
    }
    try {
      return await run()
    } catch (e) {
      // 写权限密码验证已移除,不再有解锁重试;错误直接上抛(库未授权/资源护栏等)
      throw e
    }
  }

  /** 执行单条 SQL 并记录结果;seq 为批次号,停止后旧批次在途结果丢弃,避免覆盖新批 */
  async function execOne(sql: string, item: QueryResultItem, seq: number): Promise<void> {
    const isSpark = ctx.engine.value === 'sparksql' || ctx.engine.value === 'pyspark'
    const isFlink = ctx.engine.value === 'flinksql'
    const kind = ctx.engine.value === 'pyspark' ? ('pyspark' as const) : ('sql' as const)
    if (isSpark) {
      await ctx.clearSparkLogs()
      ctx.startSparkLogPolling()
    }
    try {
      let r: ExecOutcome
      if (isFlink) r = await execFlink(sql)
      else if (isSpark) r = await execSpark(sql, kind)
      else r = await execDb(sql)
      if (seq !== runSeq) {
        finalizeStaleItem(item, '已停止')
        return
      }
      pushHistory(sql, r)
      const idx = ctx.results.value.indexOf(item)
      if (idx < 0) return // 已被裁剪(结果超上限删旧),丢弃
      ctx.results.value[idx] = { sql, ...r, running: false }
    } catch (e) {
      if (seq !== runSeq) {
        finalizeStaleItem(item, '已停止')
        return
      }
      const idx = ctx.results.value.indexOf(item)
      if (idx < 0) return
      ctx.results.value[idx] = {
        sql,
        columns: [],
        rows: [],
        costMs: 0,
        truncated: false,
        running: false,
        error: e instanceof Error ? e.message : String(e)
      }
    } finally {
      // 仅本批次仍有效时才停日志轮询(否则会停掉新批次的轮询)
      if (isSpark && seq === runSeq) {
        try {
          await ctx.pollSparkLogs() // 收尾补拉:[stage] 完成行与快照可追溯
        } catch {
          /* 日志失败不影响结果 */
        }
        ctx.stopSparkLogPolling()
      }
    }
  }

  /** 旧批次在途结果失效时落定为「已停止」:防旧结果 tab 永久 running */
  function finalizeStaleItem(item: QueryResultItem, msg: string) {
    const idx = ctx.results.value.indexOf(item)
    if (idx >= 0 && ctx.results.value[idx]?.running) {
      ctx.results.value[idx] = { ...ctx.results.value[idx], running: false, error: msg }
    }
  }

  /** 历史记录 key 与容量(SqlTreePanel 历史/收藏共用);key 按用户名隔离 */
  const HISTORY_MAX = 20
  const HIST_RESULT_ROWS = 100
  const HIST_RESULT_MAX_BYTES = 200_000

  /**
   * 执行成功后写入历史:新在前、同 sql 去重(保留最新)、上限 20 循环缓存、仅 trim 非空且 ≤2000;
   * 附带结果快照(仅查询类结果,空 rows 不缓存)。
   */
  function pushHistory(sql: string, result?: { columns?: string[]; rows?: Record<string, unknown>[] }) {
    const s = String(sql ?? '').trim()
    if (!s || s.length > 2000) return
    try {
      let list: Array<{ ts: number; sql: string; result?: { columns: string[]; rows: Record<string, unknown>[] } }> = []
      try {
        const raw = localStorage.getItem(histKey())
        if (raw) {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) list = parsed.filter((h) => h && typeof h.sql === 'string' && typeof h.ts === 'number')
        }
      } catch {
        /* 历史数据损坏则忽略,重新开始 */
      }
      list = list.filter((h) => h.sql !== s)
      const entry: { ts: number; sql: string; result?: { columns: string[]; rows: Record<string, unknown>[] } } = {
        ts: Date.now(),
        sql: s
      }
      if (result && Array.isArray(result.columns) && result.columns.length && Array.isArray(result.rows) && result.rows.length) {
        try {
          const snapshot = { columns: [...result.columns], rows: result.rows.slice(0, HIST_RESULT_ROWS) }
          if (JSON.stringify(snapshot).length <= HIST_RESULT_MAX_BYTES) entry.result = snapshot
        } catch {
          /* 快照序列化失败(循环引用等)不影响历史本身 */
        }
      }
      list.unshift(entry)
      if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX)
      localStorage.setItem(histKey(), JSON.stringify(list))
    } catch {
      /* localStorage 不可用(Safari 隐私模式等)或配额已满时静默忽略 */
    }
  }

  /** 执行目标 SQL 段列表(逐条 FIFO 串行执行;每段一个新结果 tab,整体最多 maxResults 个) */
  async function execSegments(segs: string[], seq: number) {
    const items = segs.map((sql) => ({
      sql, columns: [], rows: [], costMs: 0, truncated: false, running: true
    })) as QueryResultItem[]
    ctx.results.value.push(...items)
    if (ctx.results.value.length > ctx.maxResults) {
      ctx.results.value.splice(0, ctx.results.value.length - ctx.maxResults)
    }
    for (let i = 0; i < segs.length; i++) {
      if (batchCancelled) {
        for (const it of items.slice(i)) {
          const idx = ctx.results.value.indexOf(it)
          if (idx >= 0) ctx.results.value[idx] = { ...ctx.results.value[idx], running: false, error: '已停止' }
        }
        break
      }
      await execOne(segs[i], items[i], seq)
    }
    if (seq === runSeq && ctx.results.value.length) ctx.activePane.value = ctx.results.value.length
  }

  /** 单段整发(pyspark / flink stream 共用:整段一个结果 tab) */
  async function runWhole(target: string, seq: number) {
    const item = { sql: target, columns: [], rows: [], costMs: 0, truncated: false, running: true } as QueryResultItem
    ctx.results.value.push(item)
    if (ctx.results.value.length > ctx.maxResults) {
      ctx.results.value.splice(0, ctx.results.value.length - ctx.maxResults)
    }
    await execOne(target, item, seq)
    if (seq === runSeq) ctx.activePane.value = ctx.results.value.indexOf(item) + 1
  }

  /** 执行(选中内容 / 光标段;选中内容含多条时逐条执行;python 整段执行) */
  async function runQuery() {
    // 每人同时最多提交一批:上一批未结束则拒绝新批(FIFO 排队由批内逐条完成)
    if (ctx.loading.value) {
      ElMessage.warning('上一批 SQL 仍在执行,请等待完成后再提交')
      return
    }
    batchCancelled = false
    const seq = ++runSeq
    if (!ensureDb()) {
      ElMessage.warning('请先选择数据库')
      return
    }
    const rawSql = ctx.getSqlToRun().trim()
    if (!rawSql) {
      ElMessage.warning('请输入 SQL')
      return
    }
    // 自定义 ${var} 参数:只替换本次执行段内已填值的变量;未填的原样传给引擎
    const varVals = ctx.collectRunVars(rawSql)
    const target = ctx.expandSqlVars(rawSql, varVals)
    // python 编辑器整段执行(分号是 python 合法语句分隔符,不能切段)
    if (ctx.engine.value === 'pyspark') {
      ctx.loading.value = true
      ctx.error.value = ''
      try {
        await runWhole(target, seq)
      } finally {
        ctx.loading.value = false
      }
      return
    }
    // flinksql 流式:整段提交给 pyflink(后端内部拆分使 CREATE/INSERT 同会话生效),绝不在此拆段
    if (ctx.engine.value === 'flinksql' && flinkMode.value === 'stream') {
      ctx.loading.value = true
      ctx.error.value = ''
      try {
        await runWhole(target, seq)
      } finally {
        ctx.loading.value = false
      }
      return
    }
    // 先按分号拆段、再逐段替换 ${var}:防变量值内含分号被二次拆段(注入面)
    const segs = getSegments(rawSql).map((s) => ctx.expandSqlVars(s, varVals))
    if (!segs.length) {
      ElMessage.warning('没有可执行的 SQL')
      return
    }
    ctx.loading.value = true
    ctx.error.value = ''
    try {
      await execSegments(segs, seq)
    } finally {
      ctx.loading.value = false
    }
  }

  /** 停止当前查询:中断本批剩余段,并尝试取消引擎 job */
  async function stopQuery() {
    batchCancelled = true
    runSeq++ // 使当前批次在途结果/日志失效
    try {
      if (ctx.engine.value === 'flinksql') {
        if (currentFlinkJobId.value) {
          try {
            await flinkAsyncCancel(currentFlinkJobId.value)
          } catch {
            /* 忽略 */
          }
          currentFlinkJobId.value = ''
        } else {
          await cancelFlink()
        }
      } else if (ctx.engine.value === 'sparksql' || ctx.engine.value === 'pyspark') {
        if (currentSparkJobId.value) {
          try {
            await cancelSparkJob(currentSparkJobId.value)
          } catch {
            /* 忽略 */
          }
        }
        await cancelSpark()
      } else if (currentDbJobId.value) {
        try {
          await cancelDbJob(currentDbJobId.value)
        } catch {
          /* 忽略 */
        }
      }
      // mysql/oracle(无 job 时)置位后批循环自行停止;立即释放 loading
      ctx.stopSparkLogPolling()
      ctx.loading.value = false
      ElMessage.info('已请求停止,当前批剩余 SQL 不再执行')
    } catch (e) {
      ElMessage.error(`停止失败:${e instanceof Error ? e.message : e}`)
    }
  }

  /** Flink 流批模式(stream=异步常驻流任务;batch=同步)——弹窗状态留在宿主,模式值在此消费 */
  const flinkMode = ref<'batch' | 'stream'>('batch')

  /** 开新批次号并清停止位(rerunResult 等旁路执行入口用;主入口 runQuery 内部已含) */
  function beginBatch(): number {
    batchCancelled = false
    return ++runSeq
  }

  return {
    currentSparkJobId,
    currentFlinkJobId,
    currentDbJobId,
    isSparkWriteSql,
    execSpark,
    execFlink,
    execDb,
    ensureDb,
    pushHistory,
    runQuery,
    stopQuery,
    flinkMode,
    beginBatch,
    /** 当前批次号读取(rerunResult 判定过期用) */
    get seq() {
      return runSeq
    }
  }
}

/** 执行器统一返回形状 */
interface ExecOutcome {
  columns: string[]
  rows: Record<string, unknown>[]
  costMs: number
  truncated: boolean
}

/** 批次互斥状态(模块级:同一次「执行」点击为一个批次) */
let batchCancelled = false
let runSeq = 0

/** 历史记录 key(按用户名隔离,与 SqlTreePanel 读取端一致)—— 由宿主注入用户名 */
let histUser = 'default'
export function setHistUser(u: string) {
  histUser = u || 'default'
}
function histKey(): string {
  return `db-query-history:${histUser}`
}

/** 拆 SQL 段并过滤空段/纯注释段 */
function getSegments(text: string): string[] {
  return splitSqlSegments(text)
    .map((s) => s.sql.trim())
    .filter((s) => s && !VAR_SEG_FILTER.test(s))
}
