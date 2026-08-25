// 网关公共工具(routes/proxy.js 与 routes/db.js 共用的纯函数,无业务逻辑)
// 从原 server/index.js「通用工具」区原样迁出,行为零变化。

// Set-Cookie 重写:同源代理后种到门户域。
// 只去掉 HttpOnly(海豚前端需通过 JS 读取 sessionId 放入请求头)。
// 注意:不要设置 SameSite=None 又去掉 Secure——该组合会被浏览器拒绝整个 cookie,
// 导致自动登录的会话 cookie 永远种不上(白屏根因)。同源 iframe 下保持默认 SameSite 即可。
export function rewriteCookie(cookie) {
  return cookie.replace(/;\s*HttpOnly/i, '')
}

// Location 重写:目标源绝对地址 → 门户代理前缀
export function rewriteLocation(location, targetUrl, prefix) {
  if (!location) return location
  const targetOrigin = new URL(targetUrl).origin
  if (location.startsWith(targetOrigin)) {
    return prefix + location.slice(targetOrigin.length)
  }
  return location
}

// 正则转义(用于把 host 拼进 new RegExp)
export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// URL 路径的目录部分(以 / 结尾):/cluster/app/app_1 → /cluster/app/; /proxy/app_1/ → /proxy/app_1/
export function dirOf(path) {
  const i = path.lastIndexOf('/')
  if (i <= 0) return '/'
  return path.slice(0, i + 1)
}
