// 全局深浅色主题工具:html.dark class + localStorage 持久化
// 与 variables.scss 的 :root / html.dark 双主题约定配套。

const THEME_KEY = 'bigdata-portal.theme'

export type ThemeMode = 'light' | 'dark'

/** 管理端主题覆盖(来自 GET /api/theme,字段为空 = 用默认) */
export interface ThemeOverrides {
  fontFamily?: string
  light?: Partial<Record<'text' | 'muted' | 'primary' | 'bg' | 'panel' | 'border' | 'sidebar', string>>
  dark?: Partial<Record<'text' | 'muted' | 'primary' | 'bg' | 'panel' | 'border' | 'sidebar', string>>
}

export function getTheme(): ThemeMode {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.classList.toggle('dark', mode === 'dark')
  try {
    localStorage.setItem(THEME_KEY, mode)
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

export function toggleTheme(): ThemeMode {
  const next: ThemeMode = getTheme() === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  return next
}

/** 应用启动时初始化(在 App 挂载前调用,避免深色用户闪白) */
export function initTheme(): void {
  let saved: ThemeMode | null = null
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'dark' || v === 'light') saved = v
  } catch {
    /* 忽略 */
  }
  applyTheme(saved ?? 'light')
}

// ── 管理端主题覆盖(全局 CSS 变量注入)──────────────────────────
let overridesStyle: HTMLStyleElement | null = null
let cached: ThemeOverrides | null = null

const OVERRIDE_KEYS = ['text', 'muted', 'primary', 'bg', 'panel', 'border', 'sidebar'] as const

function cssVars(vals?: Partial<Record<(typeof OVERRIDE_KEYS)[number], string>>): string {
  if (!vals) return ''
  return OVERRIDE_KEYS.filter((k) => vals[k]).map((k) => `  --bd-${k}: ${vals[k]};\n`).join('')
}

/** 将管理端主题覆盖写为 <style> 注入 html 根变量(优先级高于 variables.scss 默认) */
export function applyThemeOverrides(t?: ThemeOverrides | null): void {
  if (t) cached = t
  if (!cached) return
  if (!overridesStyle) {
    overridesStyle = document.createElement('style')
    overridesStyle.id = 'bd-theme-overrides'
    document.head.appendChild(overridesStyle)
  }
  const font = cached.fontFamily || ''
  overridesStyle.textContent =
    (font ? `:root { --bd-font: ${font}; }\n` : '') +
    `:root {\n${cssVars(cached.light)}}\n` +
    `html.dark {\n${cssVars(cached.dark)}}\n`
}

/** 启动时拉取管理端主题覆盖(未登录/未配置时静默跳过,用默认主题) */
export async function loadThemeOverrides(): Promise<void> {
  try {
    const r = await fetch('/api/theme')
    if (!r.ok) return
    const d = await r.json()
    if (d.code === 0 && d.data) applyThemeOverrides(d.data)
  } catch {
    /* 网络或未登录,保持默认主题 */
  }
}
