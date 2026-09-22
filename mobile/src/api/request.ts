const portalUrl = (import.meta.env.VITE_PORTAL_URL as string | undefined)?.replace(/\/$/, '') ?? ''

export const AUTH_EXPIRED_EVENT = 'portal-auth-expired'

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function resolveUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${portalUrl}${path.startsWith('/') ? path : `/${path}`}`
}

function errorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const value = body as { detail?: unknown; msg?: unknown; message?: unknown }
  return String(value.detail ?? value.msg ?? value.message ?? fallback)
}

function notifyAuthExpired(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
}

export async function requestJson<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(resolveUrl(path), {
      ...init,
      credentials: 'include',
      signal: init.signal ?? controller.signal
    })

    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // Some proxy endpoints legitimately return an empty or non-JSON body.
    }

    if (response.status === 401) notifyAuthExpired()
    if (!response.ok) {
      throw new ApiError(errorMessage(body, `HTTP ${response.status}`), response.status)
    }

    if (body && typeof body === 'object' && 'code' in body) {
      const envelope = body as { code?: unknown; data?: T; msg?: unknown }
      const code = Number(envelope.code)
      if (code !== 0) throw new ApiError(errorMessage(body, '请求失败'), response.status, code)
      return envelope.data as T
    }
    return body as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('请求超时', 408)
    }
    throw error
  } finally {
    globalThis.clearTimeout(timer)
  }
}
