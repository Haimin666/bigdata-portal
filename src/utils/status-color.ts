import type { StatusColor } from '@/types/yarn'

export const STATUS_COLORS: Record<StatusColor, string> = {
  success: '#3eaf6f',
  failure: '#e5484d',
  running: '#3b82f6',
  paused: '#e8820a',
  stopped: '#71717a',
  neutral: '#71717a'
}