import type { StatusColor } from '@/types/yarn'

export function yarnStateColor(state: string): StatusColor {
  switch (state) {
    case 'RUNNING':
      return 'running'
    case 'FINISHED':
      return 'success'
    case 'FAILED':
      return 'failure'
    case 'KILLED':
      return 'stopped'
    default:
      return 'neutral'
  }
}

export function formatTimestamp(ts: number, humanize: boolean): string {
  if (!ts) return 'n/a'
  if (!humanize) return String(ts)
  const date = new Date(ts)
  const diff = Date.now() - ts
  let rel: string
  if (diff < 60000) rel = '刚刚'
  else if (diff < 3600000) rel = `${Math.floor(diff / 60000)} 分钟前`
  else if (diff < 86400000) rel = `${Math.floor(diff / 3600000)} 小时前`
  else rel = `${Math.floor(diff / 86400000)} 天前`
  return `${date.toLocaleString()} (${rel})`
}

export function formatElapsed(ms: number, humanize: boolean): string {
  if (!ms) return 'n/a'
  if (!humanize) return String(ms)
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const parts: string[] = []
  if (d) parts.push(`${d}天`)
  if (h) parts.push(`${h}小时`)
  if (m) parts.push(`${m}分`)
  if (sec || parts.length === 0) parts.push(`${sec}秒`)
  return parts.join('')
}

const MEM_UNITS = ['MB', 'GB', 'TB', 'PB']

/** 内存格式化:MB → 自适应单位(GB/TB),humanize=false 时原样返回数字 */
export function formatMem(mb: number, humanize: boolean): string {
  if (!Number.isFinite(mb) || mb < 0) return 'n/a'
  if (!humanize || mb < 1024) return `${Math.round(mb)} MB`
  let v = mb
  let i = 0
  while (v >= 1024 && i < MEM_UNITS.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${MEM_UNITS[i]}`
}
