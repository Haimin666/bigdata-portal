import { ref } from 'vue'

export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'bigdata-mobile-theme'
const preference = ref<ThemePreference>('system')
let initialized = false
let media: MediaQueryList | null = null

function resolvedDark(value = preference.value): boolean {
  return value === 'dark' || (value === 'system' && Boolean(media?.matches))
}

function applyTheme(): void {
  document.documentElement.classList.toggle('ion-palette-dark', resolvedDark())
  document.documentElement.style.colorScheme = resolvedDark() ? 'dark' : 'light'
}

export function initTheme(): void {
  if (initialized) return
  initialized = true
  media = window.matchMedia('(prefers-color-scheme: dark)')
  const saved = window.localStorage.getItem(STORAGE_KEY)
  preference.value = saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
  media.addEventListener('change', applyTheme)
  applyTheme()
}

export function useTheme() {
  function setTheme(value: ThemePreference): void {
    preference.value = value
    window.localStorage.setItem(STORAGE_KEY, value)
    applyTheme()
  }

  return { preference, setTheme }
}
