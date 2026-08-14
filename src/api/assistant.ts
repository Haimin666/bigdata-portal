/**
 * 开发助手 API —— 对接本地 Reasonix serve(经门户网关 /api/assistant 同源代理)
 *
 * 后端契约(8787 Reasonix serve,网关注入 reasonix_token cookie):
 *   GET  /sessions        → [{name, path, title, turns, current}]
 *   POST /resume {path}   → 切换当前会话
 *   GET  /history         → [{role: user|assistant|tool|system, content, reasoning, toolCalls, ...}]
 *   POST /submit {input}  → 提交消息(204,后台执行)
 *   POST /cancel          → 中止当前 turn
 *   POST /delete-session {name}
 *   GET  /events          → SSE(kind: turn_started / reasoning / text / message / turn_done / ...)
 */

export interface AssistantSession {
  /** 唯一标识 = 会话 path(resume 用) */
  id: string
  /** 删除会话用的 name 字段 */
  name?: string
  title: string
  turns?: number
  current?: boolean
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

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function j(res: Response): Promise<any> {
  if (!res.ok) throw new Error(`assistant api ${res.status}`)
  return res.json().catch(() => ({}))
}

/** 会话标题:优先服务端 title,否则用文件名可读化 */
function sessionTitle(s: { title?: string; name?: string; path?: string }): string {
  if (s.title) return s.title
  const name = String(s.name || s.path || '').replace(/^.*\//, '').replace(/\.jsonl$/, '')
  return name.replace(/^\w+-/, '').replace(/T/, ' ').replace(/[-_]/g, ' ').slice(0, 30) || '新会话'
}

// ── 会话 CRUD ─────────────────────────────────────────────
export async function listSessions(): Promise<AssistantSession[]> {
  const data = await j(await fetch('/api/assistant/sessions'))
  const list: AssistantSession[] = Array.isArray(data)
    ? data.map((s: any) => ({
        id: s.path || s.name,
        name: s.name,
        title: sessionTitle(s),
        turns: s.turns,
        current: !!s.current,
        createdAt: 0,
        updatedAt: 0
      }))
    : []
  return list.sort((a, b) => Number(b.current) - Number(a.current))
}

/** 新建会话:通过 /submit /new 让服务端开新会话,返回新 current 会话 */
export async function createSession(): Promise<AssistantSession> {
  await fetch('/api/assistant/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: '/new' })
  })
  const list = await listSessions()
  const cur = list.find((s) => s.current)
  if (cur) return cur
  // 服务端没立即可见新会话时,等一轮刷新
  await new Promise((r) => setTimeout(r, 500))
  const again = await listSessions()
  return again.find((s) => s.current) ?? { id: genId(), title: '新会话', createdAt: Date.now(), updatedAt: Date.now() }
}

export async function deleteSession(id: string, name?: string): Promise<void> {
  await fetch('/api/assistant/delete-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || id })
  })
}

export async function listMessages(sessionId: string): Promise<ChatMessage[]> {
  // 先切换会话,再拉历史
  await fetch('/api/assistant/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: sessionId })
  })
  const data = await j(await fetch('/api/assistant/history'))
  const msgs: ChatMessage[] = Array.isArray(data) ? [] : []
  if (Array.isArray(data)) {
    for (const m of data) {
      if (m.role === 'system') continue
      if (m.role === 'user') {
        if (m.content) msgs.push({ id: genId(), role: 'user', content: String(m.content), createdAt: Date.now() })
      } else if (m.role === 'assistant') {
        const content = String(m.content || '')
        const thinking = m.reasoning ? String(m.reasoning) : undefined
        if (content || thinking) {
          msgs.push({ id: genId(), role: 'assistant', content, thinking, createdAt: Date.now() })
        } else if (m.toolCalls?.length) {
          msgs.push({ id: genId(), role: 'assistant', content: `[调用了 ${m.toolCalls.length} 个工具]`, createdAt: Date.now() })
        }
      }
    }
  }
  return msgs
}

// ── 对话 ──────────────────────────────────────────────────
/** 提交消息(204 即接受,增量内容经 /events SSE 推送) */
export async function submitChat(sessionId: string, message: string): Promise<void> {
  void sessionId // 服务端当前会话由 /resume 决定,提交无需会话参数
  const res = await fetch('/api/assistant/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: message })
  })
  if (!res.ok && res.status !== 204) throw new Error(`submit failed ${res.status}`)
}

/** 中止当前生成 */
export async function stopChat(): Promise<void> {
  await fetch('/api/assistant/cancel', { method: 'POST' }).catch(() => {})
}

// ── 增强能力(侧栏操作:压缩/回退/分支/模型/统计)─────────
/** 直接执行斜杠命令(压缩/回退/分支切换/模型切换等) */
export async function runCommand(cmd: string): Promise<void> {
  const res = await fetch('/api/assistant/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: cmd })
  })
  if (!res.ok && res.status !== 202) throw new Error(`command failed ${res.status}`)
}

export interface BranchInfo {
  id: string
  title?: string
  model?: string
  turns?: number
  preview?: string
  current?: boolean
}

export async function getBranches(): Promise<{ tree?: string; branches: BranchInfo[] }> {
  const data = await j(await fetch('/api/assistant/branches'))
  const list: BranchInfo[] = Array.isArray(data?.branches)
    ? data.branches.map((b: any) => ({
        id: b.id || '',
        title: b.custom_title || b.CustomTitle || b.name || b.Name || b.topic_title || b.id,
        model: b.model || '',
        turns: b.turns ?? b.Turns,
        preview: b.preview || b.Preview || '',
        current: !!b.active || b.id === data.current
      }))
    : []
  return { tree: data?.tree, branches: list }
}

export interface ModelInfo {
  ref: string
  provider?: string
  model?: string
  active?: boolean
}

export async function getModels(): Promise<{ current?: string; models: ModelInfo[] }> {
  const data = await j(await fetch('/api/assistant/models'))
  return {
    current: data?.current,
    models: Array.isArray(data?.models)
      ? data.models.map((m: any) => ({ ref: m.ref, provider: m.provider, model: m.model, active: !!m.active }))
      : []
  }
}

export interface AssistantStatus {
  label?: string
  cwd?: string
  used?: number
  window?: number
  cacheHit?: number
  cacheMiss?: number
  running?: boolean
  plan?: boolean
  balance?: any
  lastUsage?: any
}

export async function getStatus(): Promise<AssistantStatus> {
  return j(await fetch('/api/assistant/status'))
}

// ── 项目制(A+B:门户项目分组 + workspace 目录 + 指令注入)──
export interface AssistantProject {
  id: string
  name: string
  dir: string
  createdAt: number
}

export async function listProjects(): Promise<{ projects: AssistantProject[]; sessionProjects: Record<string, string> }> {
  const body = await j(await fetch('/api/assistant/projects'))
  return {
    projects: body?.data?.projects ?? [],
    sessionProjects: body?.data?.sessionProjects ?? {}
  }
}

export async function createProject(name: string): Promise<AssistantProject> {
  const res = await fetch('/api/assistant/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  })
  const body = await j(res)
  if (body.code !== 0) throw new Error(body.msg || '创建项目失败')
  return body.data
}

export async function deleteProject(id: string): Promise<void> {
  await fetch(`/api/assistant/projects/${id}`, { method: 'DELETE' })
}

/** 会话归属项目(projectId 空 = 解绑) */
export async function bindSessionProject(sessionId: string, projectId: string | null): Promise<void> {
  await fetch('/api/assistant/projects/session', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, projectId })
  })
}

// ── SSE 事件流(全局广播,一个连接驱动当前会话渲染)─────────
export interface ApprovalInfo {
  id: string
  tool: string
  subject?: string
}

export interface AssistantEventHandlers {
  onTurnStart?: () => void
  /** 思考增量 */
  onReasoning?: (delta: string) => void
  /** 正文增量 */
  onText?: (delta: string) => void
  /** 单条消息完成(下一条开始前) */
  onMessage?: () => void
  onTurnDone?: (err?: string) => void
  onNotice?: (text: string, level?: string) => void
  onTool?: (evt: any) => void
  /** 工具调用审批请求 */
  onApproval?: (approval: ApprovalInfo) => void
}

/** 响应工具审批(allow/session/persist/scope 对齐官方 /approve) */
export async function approveTool(
  id: string,
  payload: { allow: boolean; session?: boolean; persist?: boolean; scope?: string }
): Promise<void> {
  await fetch('/api/assistant/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...payload })
  }).catch(() => {})
}

export function connectAssistantEvents(handlers: AssistantEventHandlers): () => void {
  const es = new EventSource('/api/assistant/events')
  es.onmessage = (ev) => {
    let e: any
    try {
      e = JSON.parse(ev.data)
    } catch {
      return
    }
    switch (e.kind) {
      case 'turn_started':
        handlers.onTurnStart?.()
        break
      case 'reasoning':
        handlers.onReasoning?.(e.reasoning || e.text || '')
        break
      case 'text':
        handlers.onText?.(e.text || '')
        break
      case 'message':
        handlers.onMessage?.()
        break
      case 'turn_done':
        handlers.onTurnDone?.(e.err)
        break
      case 'notice':
        handlers.onNotice?.(e.text || '', e.level)
        break
      case 'tool_dispatch':
      case 'tool_result':
      case 'tool_progress':
        handlers.onTool?.(e)
        break
      case 'approval_request':
        if (e.approval) handlers.onApproval?.(e.approval)
        break
      default:
        break
    }
  }
  return () => es.close()
}
