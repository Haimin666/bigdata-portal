// 上游(db-proxy)错误统一对象:保留 HTTP 状态 / errorType / errorCode / logs,
// 供各路由原样透传到浏览器;错误 message 一律截断并脱敏(不回显 token/密码/DSN)。
const MAX_MESSAGE = 300

const REDACTIONS = [
  // URL 内嵌凭证:http://user:pass@host → http://***:***@host
  [/(\/\/)[^/\s@]+:[^/\s@]+@/g, '$1***:***@'],
  // key=value / key: value 形态的敏感字段
  [/\b(password|passwd|pwd|token|secret|dsn|access[_-]?key)\b\s*([=:])\s*([^\s,;]+)/gi, '$1$2***'],
  // 「token xxxxxxxx」这类空格分隔的长凭证
  [/\b(password|passwd|pwd|token|secret|dsn|access[_-]?key)\b(\s+)([A-Za-z0-9+/=._-]{8,})/gi, '$1$2***'],
  // 显式请求头泄漏(X-DB-Token: xxx)
  [/\b(x-db-token|x-spark-token|x-spark-write)\b\s*[:=]\s*\S+/gi, '$1: ***']
]

/** 截断 + 脱敏上游错误文本;换行压成空格,避免响应头/JSON 展示异常。 */
export function sanitizeUpstreamMessage(message, max = MAX_MESSAGE) {
  let text = String(message ?? '').replace(/\s+/g, ' ').trim()
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement)
  return text.slice(0, max)
}

/**
 * 把 db-proxy 的失败响应包装成带结构化字段的 Error。
 * @param {number} status 上游 HTTP 状态码
 * @param {any} body 上游 JSON 响应体
 * @param {string} [path] 上游路径(仅用于缺省 message)
 */
export function createUpstreamError(status, body, path = '') {
  const detail = body && (body.detail ?? body.msg)
  const text = typeof detail === 'string' && detail.trim()
    ? detail
    : `db-proxy HTTP ${status}${path ? ` ${path}` : ''}`
  const err = new Error(text)
  err.status = status
  err.upstream = true
  if (body && body.errorType !== undefined) err.errorType = body.errorType
  if (body && body.errorCode !== undefined) err.errorCode = body.errorCode
  if (body && body.logs !== undefined) err.logs = body.logs
  return err
}

/**
 * 统一错误出口:{ code: status, msg, errorType?, errorCode?, logs? }。
 * 只有拿不到上游状态(网络错误/超时/本地异常)时才回退 502。
 */
export function sendUpstreamError(res, err, { prefix = '', status } = {}) {
  const upstreamStatus = Number.isInteger(err?.status) ? err.status : null
  const code = Number.isInteger(status)
    ? status
    : upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 600
      ? upstreamStatus
      : 502
  const detail = sanitizeUpstreamMessage(err?.message ?? err)
  const msg = (prefix ? `${prefix}: ${detail}` : detail).slice(0, MAX_MESSAGE)
  const payload = { code, msg }
  if (err && err.errorType) payload.errorType = err.errorType
  if (err && err.errorCode !== undefined) payload.errorCode = err.errorCode
  if (err && err.logs !== undefined) payload.logs = err.logs
  res.status(code).json(payload)
}
