export interface AuthConfig {
  enabled: boolean
  initialized: boolean
}

export interface AuthUser {
  username: string
  role: string
  modules: string[] | null
}

export interface MeInfo {
  authDisabled?: boolean
  initialized?: boolean
  username: string | null
  role: string | null
  modules: string[] | null
}
