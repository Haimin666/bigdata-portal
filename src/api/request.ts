/** 前端统一 HTTP 层:JSON 契约、超时、错误消息与 401 通知。 */
export class ApiError extends Error {
  status: number
  code?: number

  constructor(message: string, status: number, code?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function messageOf(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const value = body as { detail?: unknown; msg?: unknown; message?: unknown }
  return String(value.detail || value.msg || value.message || fallback)
}

export async function requestJson<T>(path: string, init: RequestInit = {}, timeoutMs = 30000): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(path, { ...init, signal: init.signal ?? controller.signal })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // 非 JSON 响应由状态码决定错误消息
    }
    // 仅门户会话失效才退出登录；下游 DS/RM 自身的 401 不能清空门户会话。
    if (res.status === 401 && messageOf(body, '') === '未登录或会话已过期') {
      window.dispatchEvent(new CustomEvent('portal-auth-expired'))
    }
    if (!res.ok) throw new ApiError(messageOf(body, `HTTP ${res.status}`), res.status)
    if (body && typeof body === 'object' && 'code' in body) {
      const code = Number((body as { code?: unknown }).code)
      if (code !== 0) throw new ApiError(messageOf(body, '请求失败'), res.status, code)
      return ((body as { data?: T }).data ?? {}) as T
    }
    return body as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('请求超时', 408)
    }
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}
