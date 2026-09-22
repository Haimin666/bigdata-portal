import { requestJson } from './request'
import type { AuthConfig, AuthUser, MeInfo } from '../types/auth'

const jsonRequest = (method: 'POST', payload?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
})

export const authApi = {
  config: (): Promise<AuthConfig> => requestJson('/api/auth/config'),
  init: (username: string, password: string): Promise<AuthUser> =>
    requestJson('/api/auth/init', jsonRequest('POST', { username, password })),
  login: (username: string, password: string): Promise<AuthUser> =>
    requestJson('/api/auth/login', jsonRequest('POST', { username, password })),
  logout: (): Promise<{ ok: boolean }> => requestJson('/api/auth/logout', jsonRequest('POST')),
  me: (): Promise<MeInfo> => requestJson('/api/auth/me')
}
