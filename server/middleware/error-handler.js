// 统一错误出口(网关级最后防线,2026-08):
// 业务路由全部按 {code, msg} 契约自行 try/catch 返回;本中间件兜住三类漏网错误,
// 维持同一响应格式(此前 parser/未匹配路由会落 express 默认 HTML 错误页):
//   1) 全局 express.json 的 body 解析失败(语法错/超限,err.status=400/413)
//   2) 中间件或路由 next(err) 未处理的异常
//   3) /api/* 及非 GET 等未匹配路由(SPA fallback 只处理非 API 的 GET)
// 挂载(在 index.js):所有路由与 SPA fallback 之后 → app.use(jsonNotFound) → app.use(errorHandler)。
// 约定:4xx 回可读 msg;5xx 完整栈打到服务端日志,响应 msg 保留 error.message 便于排查(内网项目风格)。

// 未匹配路由统一 JSON 404(3 参签名,不走错误链)
export function jsonNotFound(req, res) {
  res.status(404).json({ code: 404, msg: '接口不存在' })
}

// 4 参签名:Express 靠参数个数识别错误中间件,勿改形参
export function errorHandler(err, req, res, next) {
  // body 解析失败等会带 err.status/statusCode;裸异常视为 500
  const code = err.status || err.statusCode || 500
  if (code >= 500) {
    console.error(`[gateway] ${req.method} ${req.originalUrl} → ${code}:`, err)
  }
  // 响应头已发出(如流式/代理中途失败):交还 express 默认收尾,避免二次写头
  if (res.headersSent) return next(err)
  // body 解析失败统一提示(body-parser 的 SyntaxError,err.type='entity.parse.failed')
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ code: 400, msg: '请求体不是合法 JSON' })
  }
  const msg = code >= 500
    ? `服务器内部错误: ${err.message || '未知错误'}`
    : (err.message || 'Bad Request')
  res.status(code).json({ code, msg })
}