// WebSocket 代理(从 index.js 拆出):
// Stingray SQL 查询结果经 ws://…/__/stingray/log/* 实时推送;
// JupyterLab kernel 通信/终端走 ws(路径自带 /apps/jupyter 前缀)。
// upgrade 请求不经过 Express 中间件(PROTECTED_PREFIXES 登录门禁对其失效),
// 此处手动解析 portal_session cookie 校验,未登录/未初始化一律断开。
import httpProxy from 'http-proxy'
import config from '../config.js'

export function setupWsProxies(server, { auth }) {
  // http-proxy-middleware 的 upgrade 订阅依赖 HTTP 请求触发(且 express 剥前缀后
  // pathFilter 不匹配,订阅时机易错过),这里用底层 http-proxy 显式处理 upgrade。
  const wsProxy = httpProxy.createProxyServer({
    target: config.stingrayUrl,
    ws: true,
    changeOrigin: true
  })

  // JupyterLab kernel 通信/终端走 ws,路径自带 /apps/jupyter 前缀(base_url),
  // 原样转发给宿主机 jupyter 即可。
  const jupyterWsProxy = httpProxy.createProxyServer({
    target: config.jupyterUrl,
    ws: true,
    changeOrigin: true
  })

  // S2:目标不可达时必须销毁 socket,否则 unhandled 'error' 会拖垮进程
  const wsErr = (err, _req, socket) => {
    console.error('[ws-proxy]', err instanceof Error ? err.message : err)
    if (socket && !socket.destroyed) socket.destroy()
  }
  wsProxy.on('error', wsErr)
  jupyterWsProxy.on('error', wsErr)

  server.on('upgrade', (req, socket, head) => {
    if (auth.enabled) {
      const cookies = {}
      for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=')
        if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim()
      }
      const user = auth.currentUser({ cookies })
      if (!user) {
        socket.destroy()
        return
      }
    }
    if (req.url.startsWith('/__/stingray')) {
      wsProxy.ws(req, socket, head)
    } else if (req.url.startsWith('/apps/jupyter')) {
      jupyterWsProxy.ws(req, socket, head)
    } else {
      socket.destroy() // 未匹配的 upgrade 直接关闭,避免悬挂
    }
  })
}