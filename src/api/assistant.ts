/**
 * 开发助手 API 契约 + mock 实现
 *
 * 后端未接入前走 mock(localStorage 持久化会话/消息 + 定时器模拟流式输出),
 * 接后端时把 MOCK_ENABLED 置 false,按下方标注的契约实现接口即可,前端无需改动。
 *
 * ── 后端契约 ──────────────────────────────────────────────
 * GET  /api/assistant/sessions                          → { code:0, data: AssistantSession[] }
 * POST /api/assistant/sessions {title?}                 → { code:0, data: AssistantSession }
 * DELETE /api/assistant/sessions/:id                    → { code:0, data: true }
 * GET  /api/assistant/sessions/:id/messages             → { code:0, data: ChatMessage[] }
 * POST /api/assistant/chat {sessionId, message}         → text/event-stream(SSE):
 *        data: {"delta":"..."}   增量文本
 *        data: {"thinking":"..."} 思考增量(可选)
 *        data: {"done":true}     结束标记
 *        POST /api/assistant/chat/stop 中止当前生成(或直接 AbortController 断连)
 */

export interface AssistantSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 思考过程(可选),助手消息渲染为可折叠块 */
  thinking?: string
  /** 前端状态:思考块是否折叠 */
  thinkCollapsed?: boolean
  createdAt: number
}

const MOCK_ENABLED = true
const MOCK_KEYS = { sessions: 'bd-assistant.sessions', msgs: (id: string) => `bd-assistant.msgs.${id}` }

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ── mock:localStorage 读写 ────────────────────────────────
function mockLoad<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function mockSave(key: string, val: unknown) {
  localStorage.setItem(key, JSON.stringify(val))
}

// ── 会话 CRUD ─────────────────────────────────────────────
export async function listSessions(): Promise<AssistantSession[]> {
  if (MOCK_ENABLED) {
    const list = mockLoad<AssistantSession[]>(MOCK_KEYS.sessions, [])
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  const res = await fetch('/api/assistant/sessions')
  const body = await res.json()
  if (body.code !== 0) throw new Error(body.msg || '加载会话失败')
  return body.data
}

export async function createSession(title?: string): Promise<AssistantSession> {
  if (MOCK_ENABLED) {
    const list = mockLoad<AssistantSession[]>(MOCK_KEYS.sessions, [])
    const s: AssistantSession = {
      id: genId(),
      title: title || '新会话',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    list.unshift(s)
    mockSave(MOCK_KEYS.sessions, list)
    mockSave(MOCK_KEYS.msgs(s.id), [])
    return s
  }
  const res = await fetch('/api/assistant/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  })
  const body = await res.json()
  if (body.code !== 0) throw new Error(body.msg || '创建会话失败')
  return body.data
}

export async function deleteSession(id: string): Promise<void> {
  if (MOCK_ENABLED) {
    const list = mockLoad<AssistantSession[]>(MOCK_KEYS.sessions, []).filter((s) => s.id !== id)
    mockSave(MOCK_KEYS.sessions, list)
    localStorage.removeItem(MOCK_KEYS.msgs(id))
    return
  }
  await fetch(`/api/assistant/sessions/${id}`, { method: 'DELETE' })
}

export async function listMessages(sessionId: string): Promise<ChatMessage[]> {
  if (MOCK_ENABLED) {
    return mockLoad<ChatMessage[]>(MOCK_KEYS.msgs(sessionId), [])
  }
  const res = await fetch(`/api/assistant/sessions/${sessionId}/messages`)
  const body = await res.json()
  if (body.code !== 0) throw new Error(body.msg || '加载消息失败')
  return body.data
}

/** 更新会话标题(取首条用户消息前 24 字) */
export async function touchSession(id: string, title?: string): Promise<void> {
  if (MOCK_ENABLED) {
    const list = mockLoad<AssistantSession[]>(MOCK_KEYS.sessions, [])
    const s = list.find((x) => x.id === id)
    if (s) {
      if (title) s.title = title
      s.updatedAt = Date.now()
      mockSave(MOCK_KEYS.sessions, list)
    }
    return
  }
  await fetch(`/api/assistant/sessions/${id}`, { method: 'PATCH' })
}

// ── 流式对话 ──────────────────────────────────────────────
export interface StreamChatOptions {
  sessionId: string
  message: string
  onDelta: (text: string) => void
  onThinking?: (text: string) => void
  signal?: AbortSignal
}

/** mock 预设回答:覆盖 markdown 渲染演示场景 */
function mockReply(prompt: string): { thinking: string; answer: string } {
  const q = prompt.toLowerCase()
  if (q.includes('sql') || q.includes('查询')) {
    return {
      thinking: '用户在问 SQL 写法,先拆解需求:统计类查询 → 分组聚合 + 排序。',
      answer:
        '可以用**分组聚合**实现,示例:\n\n```sql\nSELECT\n  dt,\n  COUNT(*) AS cnt,\n  SUM(amount) AS total_amt\nFROM lion_dw_ods.ods_etc_bill_dtl\nWHERE dt >= ' + "'2026-08-01'\nGROUP BY dt\nORDER BY dt DESC\nLIMIT 10\n```\n\n**要点**:\n- 时间字段用字符串比较即可(分区格式)\n- 大表查询建议加 `LIMIT` 防误扫全量\n- 需要 join 多表时可参考:"
    }
  }
  if (q.includes('yarn') || q.includes('spark')) {
    return {
      thinking: '排查 Spark 任务卡住的常见原因:资源不足、数据倾斜、Driver 日志。',
      answer:
        '排查 **Spark 任务卡住** 分三步:\n\n1. **看队列资源** → YARN 应用页确认是否在等待资源(`ACCEPTED` 状态)\n2. **看 Driver 日志** → 是否有 GC 频繁 / shuffle 异常\n3. **看数据倾斜** → 某 stage 卡在 99%\n\n> 小技巧:在 SparkSQL 查询里给大 key 加盐可以缓解倾斜。'
    }
  }
  return {
    thinking: '通用问题:给出结构化的操作步骤。',
    answer:
      '好的,给你梳理一下操作步骤:\n\n1. **准备**:确认环境与权限\n2. **执行**:按文档操作\n3. **验证**:检查结果是否符合预期\n\n| 步骤 | 说明 | 耗时 |\n| --- | --- | --- |\n| 准备 | 环境检查 | 5min |\n| 执行 | 实际操作 | 30min |\n| 验证 | 结果核对 | 10min |\n\n需要更具体的方案可以告诉我场景,我来细化。'
  }
}

/**
 * 流式对话。mock 模式:定时器逐字吐出预设回答(支持 abort 中断);
 * 真实模式:POST /api/assistant/chat,解析 SSE `data:` 行。
 */
export async function streamChat(opts: StreamChatOptions): Promise<void> {
  if (!MOCK_ENABLED) {
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: opts.sessionId, message: opts.message }),
      signal: opts.signal
    })
    if (!res.body) throw new Error('no stream body')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (!payload) continue
        const evt = JSON.parse(payload)
        if (evt.delta) opts.onDelta(evt.delta)
        if (evt.thinking && opts.onThinking) opts.onThinking(evt.thinking)
        if (evt.done) return
      }
    }
    return
  }

  // mock:先输出思考,再逐字输出回答,支持 AbortSignal 中断
  const rep = mockReply(opts.message)
  if (opts.onThinking) {
    for (let i = 1; i <= rep.thinking.length; i += 3) {
      if (opts.signal?.aborted) return
      opts.onThinking(rep.thinking.slice(0, i))
      await new Promise((r) => setTimeout(r, 8))
    }
  }
  const chunks = rep.answer.match(/.{1,2}/gs) ?? []
  for (const c of chunks) {
    if (opts.signal?.aborted) return
    opts.onDelta(c)
    await new Promise((r) => setTimeout(r, 24))
  }
}

/** 中止当前生成(真实后端:通知服务端停止,前端本身靠 AbortController 断连) */
export async function stopChat(sessionId: string): Promise<void> {
  if (MOCK_ENABLED) return
  try {
    await fetch('/api/assistant/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    })
  } catch {
    /* 断连中止即可,忽略 */
  }
}
