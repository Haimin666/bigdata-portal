/** 判断请求是否由门户内 Datadeck Agent iframe 发起。 */
export function isDatadeckIframeRequest(req) {
  const referer = req.get?.('referer') || req.headers?.referer || ''
  if (!referer) return false
  try {
    const url = new URL(referer)
    const requestHost = req.get?.('host') || req.headers?.host
    if (requestHost && url.host.toLowerCase() !== String(requestHost).toLowerCase()) return false
    const pathname = url.pathname
    return pathname === '/agent' || pathname.startsWith('/agent/')
  } catch {
    return false
  }
}

export function datadeckPath(prefix, path) {
  const queryIndex = path.indexOf('?')
  const pathname = queryIndex < 0 ? path : path.slice(0, queryIndex)
  const query = queryIndex < 0 ? '' : path.slice(queryIndex)
  const suffix = pathname === '/' ? '' : pathname
  return `${prefix}${suffix}${query}`
}
