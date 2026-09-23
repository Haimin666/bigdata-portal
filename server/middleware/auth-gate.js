// 登录门禁(从 index.js 拆出):受保护路径未登录一律 401(除 /api/auth/* 与静态资源/SPA 页面,
// 由前端路由守卫拦截);未初始化(无任何用户)时,除初始化接口外一律 503,避免门户裸奔。
// 由 index.js 在 setupAuth 之后挂载:app.use(createAuthGate(auth))

const PROTECTED_PREFIXES = [
  '/api/db', '/api/dbquery', '/api/spark', '/api/flink', '/api/users',
  '/api/ds-deps', '/api/scripts', '/api/config', '/api/dataleap',
  '/api/assistant', '/api/mobile/assistant', '/api/sync', '/api/mail',
  '/apps', '/yarniframe', '/hadoopapi', '/api/iframe-proxy', '/__/', '/stingray-static',
  '/webhdfs', '/dolphinscheduler', '/static', '/agent'
]

const MODULE_PREFIXES = [
  { module: 'dbQuery', prefixes: ['/api/db', '/api/dbquery', '/api/spark', '/api/flink', '/api/scripts'] },
  { module: 'dsTask', prefixes: ['/api/ds-deps'] },
  { module: 'dataleap', prefixes: ['/api/dataleap'] },
  { module: 'yarn', prefixes: ['/yarniframe', '/hadoopapi', '/api/iframe-proxy'] },
  { module: 'devAssistant', prefixes: ['/api/assistant', '/api/mobile/assistant'] },
  { module: 'sync', prefixes: ['/api/sync'] },
  { module: 'hdfs', prefixes: ['/apps/hdfs', '/static', '/webhdfs'] },
  { module: 'ds', prefixes: ['/apps/dsweb'] },
  { module: 'ds', prefixes: ['/dolphinscheduler/ui'] },
  { modules: ['dsTask', 'ds'], prefixes: ['/dolphinscheduler'] },
  { module: 'jupyter', prefixes: ['/apps/jupyter'] },
  { module: 'mail', prefixes: ['/apps/mail', '/api/mail'] },
  { module: 'stingray', prefixes: ['/apps/stingray', '/stingray-static', '/__/stingray'] },
  { module: 'devAssistant', prefixes: ['/agent'] }
]

function pathMatches(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function createAuthGate(auth, options = {}) {
  return (req, res, next) => {
    if (!auth.enabled) return next()
    // Express 4 路由默认大小写不敏感,保护前缀必须统一用小写匹配,否则 /API/... 变体绕过门禁
    const p = req.path.toLowerCase()
    if (!PROTECTED_PREFIXES.some((pre) => pathMatches(p, pre))) return next()
    if (pathMatches(p, '/api/sync') && options.syncApiToken && req.headers['x-api-token'] === options.syncApiToken) {
      req.apiTokenAuthenticated = true
      return next()
    }
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

/** 子应用/代理模块门禁:前端隐藏菜单不是安全边界,直接访问代理 URL 也必须校验 modules。 */
export function createModuleGate(auth) {
  return (req, res, next) => {
    if (!auth.enabled) return next()
    if (req.apiTokenAuthenticated) return next()
    const p = req.path.toLowerCase()
    const entry = MODULE_PREFIXES.find((item) => item.prefixes.some((pre) => pathMatches(p, pre)))
    if (!entry) return next()
    const user = req.user || auth.currentUser(req)
    if (!user) return res.status(401).json({ code: 401, msg: '未登录或会话已过期' })
    if (user.role === 'admin') return next()
    const modules = auth.users.modulesOf(user)
    const allowedModules = entry.modules || [entry.module]
    if (Array.isArray(modules) && modules.length > 0 && !allowedModules.some((name) => modules.includes(name))) {
      return res.status(403).json({ code: 403, msg: `无 ${allowedModules.join('/')} 模块权限` })
    }
    next()
  }
}
