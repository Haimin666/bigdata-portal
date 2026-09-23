const base = '/api/mobile/assistant'
const assistantUserId = '1030437'

export interface AssistantToken {
  access_token: string
  uid: string
  username: string
}

export interface AssistantAgent {
  id: string
  slug: string
  name: string
}

export interface AssistantThread {
  id: string
  agent_id: string
  title: string
  updated_at?: string
  is_pinned?: boolean
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at?: string
}

async function assistantRequest<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${base}${path}`, { ...init, headers, credentials: 'include' })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    throw new Error(String(body?.detail ?? body?.msg ?? body?.message ?? `助手请求失败（${response.status}）`))
  }
  return body as T
}

export async function bootstrapAssistant(): Promise<AssistantToken> {
  return assistantRequest<AssistantToken>(`/auth/goai?user_id=${assistantUserId}`)
}

export async function getDefaultAssistant(token: string): Promise<AssistantAgent> {
  const response = await assistantRequest<{ agent: AssistantAgent }>('/agent/default', token)
  return response.agent
}

export async function listAssistantThreads(token: string, agentId: string): Promise<AssistantThread[]> {
  const query = new URLSearchParams({ agent_id: agentId, limit: '50', offset: '0' })
  return assistantRequest<AssistantThread[]>(`/threads?${query}`, token)
}

export async function createAssistantThread(token: string, agentId: string, title: string): Promise<AssistantThread> {
  return assistantRequest<AssistantThread>('/threads', token, {
    method: 'POST',
    body: JSON.stringify({ agent_id: agentId, title, metadata: {} })
  })
}

export async function getAssistantHistory(token: string, threadId: string): Promise<AssistantMessage[]> {
  const response = await assistantRequest<{ history: AssistantMessage[] }>(`/threads/${encodeURIComponent(threadId)}/history`, token)
  return Array.isArray(response.history) ? response.history : []
}

export async function createAssistantRun(token: string, threadId: string, agentSlug: string, query: string): Promise<{ run_id: string }> {
  return assistantRequest<{ run_id: string }>('/runs', token, {
    method: 'POST',
    body: JSON.stringify({ query, agent_slug: agentSlug, thread_id: threadId, meta: {}, queue_policy: 'enqueue' })
  })
}

export async function cancelAssistantRun(token: string, runId: string): Promise<void> {
  await assistantRequest(`/runs/${encodeURIComponent(runId)}/cancel`, token, {
    method: 'POST',
    body: JSON.stringify({})
  })
}

export async function streamAssistantRun(
  token: string,
  runId: string,
  signal: AbortSignal,
  onEvent: (event: string, data: Record<string, unknown>) => void
): Promise<void> {
  const response = await fetch(`${base}/runs/${encodeURIComponent(runId)}/events?verbose=false`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
    signal
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    throw new Error(String(body?.detail ?? body?.msg ?? `流式连接失败（${response.status}）`))
  }
  if (!response.body) throw new Error('当前设备无法读取助手的流式响应')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = 'message'
  let dataLines: string[] = []
  const dispatch = () => {
    if (!dataLines.length) return
    try {
      onEvent(event, JSON.parse(dataLines.join('\n')) as Record<string, unknown>)
    } catch {
      onEvent('parse_error', { message: '收到无法识别的流式消息' })
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '')
        if (!line) {
          dispatch()
          event = 'message'
          dataLines = []
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim() || 'message'
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart())
    dispatch()
  } finally {
    reader.releaseLock()
  }
}
