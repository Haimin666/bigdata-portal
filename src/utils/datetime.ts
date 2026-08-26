/**
 * datetime —— dayjs 统一时间工具(2026-08,Phase B):
 * 收编各视图手写的 padStart 拼串时间格式化(MainLayout 时钟 / DsTaskMonitor rangeDates /
 * SqlTreePanel formatTime / format.ts formatTimestamp),格式与原实现逐字对齐(行为零变化)。
 */
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

// 相对时间中文文案("N 分钟前")
dayjs.extend(relativeTime)
import('dayjs/locale/zh-cn')
  .then(() => dayjs.locale('zh-cn'))
  .catch(() => {
    /* 语言包加载失败退回英文文案,不影响功能 */
  })

/** 标准日期时间:YYYY-MM-DD HH:mm:ss(海豚 API/日志通用) */
export function fmtDateTime(input: dayjs.ConfigType): string {
  return dayjs(input).format('YYYY-MM-DD HH:mm:ss')
}

/** 仅日期:YYYY-MM-DD */
export function fmtDate(input: dayjs.ConfigType): string {
  return dayjs(input).format('YYYY-MM-DD')
}

/** 仅时间:HH:mm:ss */
export function fmtTime(input: dayjs.ConfigType): string {
  return dayjs(input).format('HH:mm:ss')
}

/**
 * 时间戳 → 人读格式:`YYYY-MM-DD HH:mm:ss (相对时间)`。
 * 等价原 utils/format.ts formatTimestamp(toLocaleString → 固定格式,消除浏览器差异)。
 */
export function fmtTimestampHuman(ts: number): string {
  const d = dayjs(ts)
  return `${d.format('YYYY-MM-DD HH:mm:ss')} (${d.fromNow()})`
}

/**
 * 历史列表时间:今天 HH:mm,跨天 MM-DD HH:mm(SqlTreePanel 原实现等价)。
 */
export function fmtHistTime(ts: number): string {
  const d = dayjs(ts)
  const hm = d.format('HH:mm')
  return d.isSame(dayjs(), 'day') ? hm : d.format('MM-DD ') + hm
}

/**
 * 海豚监控时间范围 → [start, end] yyyy-MM-dd HH:mm:ss:
 * today = 当天 00:00:00 → 现在;其余 = 近 N 小时(DsTaskMonitor 原实现等价)。
 */
export function dsRangeDates(rangeKey: string): { start?: string; end?: string } {
  const now = dayjs()
  if (rangeKey === 'today') {
    return { start: now.startOf('day').format('YYYY-MM-DD HH:mm:ss'), end: now.format('YYYY-MM-DD HH:mm:ss') }
  }
  const hours: Record<string, number> = { '1d': 24, '3d': 24 * 3, '7d': 24 * 7 }
  const h = hours[rangeKey]
  if (!h) return {}
  return {
    start: now.subtract(h, 'hour').format('YYYY-MM-DD HH:mm:ss'),
    end: now.format('YYYY-MM-DD HH:mm:ss')
  }
}
