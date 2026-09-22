// 认证与用户管理 API(自建账号体系)
export interface MeInfo {
  authDisabled?: boolean
  initialized?: boolean
  username: string | null
  role: string | null
  /** 可访问模块(菜单 name 白名单);null = 全部 */
  modules: string[] | null
}

export interface LoginInfo {
  username: string
  role: string
  modules: string[] | null
}

export interface UserInfo {
  username: string
  role: string
  status: string
  modules: string[] | null
  effectiveModules: string[] | null
  createdAt: string
  updatedAt: string
  lastLoginAt: string | null
}

export interface RolesDef {
  [key: string]: { title: string; modules: string[] | null }
}

interface ApiResp<T> {
  code?: number
  data?: T
  detail?: string
  msg?: string
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  let body: ApiResp<T> | null = null
  try {
    body = (await res.json()) as ApiResp<T>
  } catch {
    /* 忽略非 JSON */
  }
  if (!res.ok) {
    const err = new Error(body?.detail || body?.msg || `HTTP ${res.status}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  if (body && body.code !== undefined && body.code !== 0) {
    const err = new Error(body.detail || body.msg || '请求失败') as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return (body?.data ?? {}) as T
}

const jsonInit = (method: string, payload?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
})

export const authApi = {
  config: () => req<{ enabled: boolean; initialized: boolean }>('/api/auth/config'),
  init: (username: string, password: string) =>
    req<LoginInfo>('/api/auth/init', jsonInit('POST', { username, password })),
  login: (username: string, password: string) =>
    req<LoginInfo>('/api/auth/login', jsonInit('POST', { username, password })),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', jsonInit('POST')),
  me: () => req<MeInfo>('/api/auth/me')
}

export const userApi = {
  list: () => req<{ users: UserInfo[]; roles: RolesDef }>('/api/users'),
  create: (p: { username: string; password: string; role: string; status?: string; modules?: string[] | null }) =>
    req<UserInfo>('/api/users', jsonInit('POST', p)),
  update: (
    username: string,
    p: { role?: string; status?: string; modules?: string[] | null; password?: string }
  ) => req<UserInfo>('/api/users/' + encodeURIComponent(username), jsonInit('PUT', p)),
  remove: (username: string) =>
    req<{ deleted: string }>('/api/users/' + encodeURIComponent(username), jsonInit('DELETE'))
}
