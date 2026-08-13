// 全局深浅色主题工具:html.dark class + localStorage 持久化
// 与 variables.scss 的 :root / html.dark 双主题约定配套。

const THEME_KEY = 'bigdata-portal.theme'

export type ThemeMode = 'light' | 'dark'

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
