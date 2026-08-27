// 子应用/iframe 代理通用工具(从 index.js 拆出):
// cookie/Location 重写 + 代理响应处理 + iframeProxy 工厂。
// 被 routes/subapps-proxy.js、routes/yarn-proxy.js 共用。
import { createProxyMiddleware } from 'http-proxy-middleware'

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

// 代理响应处理:去 frame 限制、cookie/location 重写
export function onProxyRes(targetUrl, prefix) {
  return (proxyRes) => {
    delete proxyRes.headers['x-frame-options']
    const cookies = proxyRes.headers['set-cookie']
    if (cookies) proxyRes.headers['set-cookie'] = cookies.map(rewriteCookie)
    if (proxyRes.headers.location) {
      proxyRes.headers.location = rewriteLocation(proxyRes.headers.location, targetUrl, prefix)
    }
  }
}

// 带 cookie 重写的 iframe/子应用代理
export function iframeProxy(targetUrl, prefix) {
  return createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,
    // 注意:WebSocket 由 server.on('upgrade') + wsProxy 显式处理,
    // 此处不能开 ws:true(否则 http-proxy-middleware 自动订阅 upgrade,
    // 与手动代理形成双监听,转发数据被双写 → Invalid frame header)
    on: { proxyRes: onProxyRes(targetUrl, prefix) },
    logLevel: 'warn'
  })
}