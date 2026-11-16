// 超时参数统一夹取:客户端传入的 timeoutMs 必须经过本函数后再交给
// AbortSignal.timeout / 上游,避免 -1、1.5、NaN 等值触发 ERR_OUT_OF_RANGE(被兜成 502)。
/**
 * @param {unknown} value 客户端原始值
 * @param {number} def 缺省/不可解析时的兜底值(毫秒)
 * @param {number} min 允许下限(毫秒)
 * @param {number} max 允许上限(毫秒)
 * @returns {number} 取整并夹在 [min, max] 内的毫秒数
 */
export function clampTimeoutMs(value, def, min = 1000, max = 600000) {
  const fallback = toSafeMs(def, min, max, min)
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return toSafeMs(n, min, max, fallback)
}

function toSafeMs(n, min, max, fallback) {
  const rounded = Math.trunc(Number(n))
  if (!Number.isFinite(rounded)) return fallback
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}
