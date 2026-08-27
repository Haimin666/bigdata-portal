// 登录门禁(从 index.js 拆出):受保护路径未登录一律 401(除 /api/auth/* 与静态资源/SPA 页面,
// 由前端路由守卫拦截);未初始化(无任何用户)时,除初始化接口外一律 503,避免门户裸奔。
// 由 index.js 在 setupAuth 之后挂载:app.use(createAuthGate(auth))

const PROTECTED_PREFIXES = [
  '/api/db', '/api/dbquery', '/api/spark', '/api/flink', '/api/users',
  '/api/ds-deps', '/api/scripts', '/api/config', '/api/dataleap',
  '/api/assistant',
  '/apps', '/yarniframe', '/hadoopapi', '/api/iframe-proxy', '/__/', '/stingray-static',
  '/webhdfs', '/dolphinscheduler', '/static'
]

export function createAuthGate(auth) {
  return (req, res, next) => {
    if (!auth.enabled) return next()
    // Express 4 路由默认大小写不敏感,保护前缀必须统一用小写匹配,否则 /API/... 变体绕过门禁
    const p = req.path.toLowerCase()
    if (!PROTECTED_PREFIXES.some((pre) => p.startsWith(pre))) return next()
    const user = auth.currentUser(req)
    if (!user) {
      if (auth.users.isEmpty()) {
        return res.status(503).json({ code: 503, msg: '系统未初始化,请先创建管理员' })
      }
      return res.status(401).json({ code: 401, msg: '未登录或会话已过期' })
    }
    req.user = user
    next()
  }
}