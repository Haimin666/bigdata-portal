// 门户认证与会话(自建账号,阶段一只保护门户壳)。
// - 密码:scrypt 加盐哈希(server/users.js,零依赖)
// - 会话:randomBytes token 存 data/sessions.json + HttpOnly cookie `portal_session`
// - 守卫:requireAuth / requireAdmin,保护门户 API 与子应用代理路径
// - 首次启动:无用户时仅放行初始化接口(避免门户裸奔)
// 配置:config.local.json -> "auth": { "enabled": true, "sessionHours": 12 }
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { UserStore } from './users.js'

export function setupAuth(app, config) {
  const dataDir = path.join(import.meta.dirname, '../data')
  const users = new UserStore(dataDir)
  const enabled = config.authEnabled !== false // 默认开启
  const ttlMs = (config.authSessionHours || 12) * 3600 * 1000

  // ── 会话存储 ─────────────────────────────────────────
  const sessionsFile = path.join(dataDir, 'sessions.json')
  let sessions = {}
  try {
    sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'))
  } catch {
    sessions = {}
  }
  const saveSessions = () => {
    try {
      const tmp = sessionsFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2), 'utf-8')
      fs.renameSync(tmp, sessionsFile)
    } catch {
      /* 忽略写失败 */
    }
  }

  function issueSession(username) {
    const token = randomBytes(32).toString('hex')
    sessions[token] = { username, expiresAt: Date.now() + ttlMs }
    saveSessions()
    return token
  }

  function getSession(token) {
    if (!token) return null
    const s = sessions[token]
    if (!s) return null
    if (s.expiresAt < Date.now()) {
      delete sessions[token]
      saveSessions()
      return null
    }
    return s
  }

  function destroySession(token) {
    if (token && sessions[token]) {
      delete sessions[token]
      saveSessions()
    }
  }

  const COOKIE = 'portal_session'

  // 登录限速表(ip -> {count, resetAt})
  const loginAttempts = new Map()

  // ── 守卫 ─────────────────────────────────────────────
  function currentUser(req) {
    const s = getSession(req.cookies?.[COOKIE])
    if (!s) return null
    const user = users.findByUsername(s.username)
    if (!user || user.status !== 'active') return null
    return user
  }

  function requireAuth(req, res, next) {
    if (!enabled) return next()
    if (users.isEmpty()) {
      return res.status(503).json({ code: 503, msg: '系统未初始化,请先创建管理员' })
    }
    const user = currentUser(req)
    if (!user) {
      return res.status(401).json({ code: 401, msg: '未登录或会话已过期' })
    }
    req.user = user
    next()
  }

  function requireAdmin(req, res, next) {
    if (!enabled) return next()
    if (users.isEmpty()) {
      return res.status(503).json({ code: 503, msg: '系统未初始化,请先创建管理员' })
    }
    const user = currentUser(req)
    if (!user) {
      return res.status(401).json({ code: 401, msg: '未登录或会话已过期' })
    }
    if (user.role !== 'admin') {
      return res.status(403).json({ code: 403, msg: '需要管理员权限' })
    }
    req.user = user
    next()
  }

  function setSessionCookie(res, token) {
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!reqSecure(res),
      maxAge: ttlMs,
      path: '/'
    })
  }

  // 动态判断是否 HTTPS(外层反代终止 TLS 时 X-Forwarded-Proto 为 https)
  function reqSecure(res) {
    try {
      const req = res.req
      return req.secure || String(req.headers?.['x-forwarded-proto'] || '').toLowerCase() === 'https'
    } catch {
      return false
    }
  }

  // ── 认证路由 ─────────────────────────────────────────
  app.get('/api/auth/config', (req, res) => {
    res.json({ code: 0, data: { enabled, initialized: !users.isEmpty() } })
  })

  app.post('/api/auth/init', (req, res) => {
    if (!enabled) return res.status(403).json({ code: 403, msg: '认证未启用' })
    if (!users.isEmpty()) return res.status(403).json({ code: 403, msg: '系统已初始化' })
    const { username, password } = req.body || {}
    try {
      const user = users.create({ username, password, role: 'admin' })
      const token = issueSession(user.username)
      setSessionCookie(res, token)
      res.json({ code: 0, data: { username: user.username, role: user.role, modules: user.modules } })
    } catch (e) {
      res.status(400).json({ code: 400, msg: e.message })
    }
  })

  app.post('/api/auth/login', (req, res) => {
    if (!enabled) return res.status(403).json({ code: 403, msg: '认证未启用' })
    // 简单 IP 限速:同 IP 60s 最多 10 次失败(仅失败计数,成功即重置),防暴力破解
    const ip = req.ip || req.socket?.remoteAddress || 'unknown'
    const now = Date.now()
    const rec = loginAttempts.get(ip)
    if (!rec || rec.resetAt < now) {
      loginAttempts.set(ip, { count: 1, resetAt: now + 60_000 })
    } else {
      rec.count += 1
      if (rec.count > 10) {
        return res.status(429).json({ code: 429, msg: '尝试过于频繁,请 60 秒后再试' })
      }
    }
    const { username, password } = req.body || {}
    const user = users.findByUsername(String(username || '').trim())
    if (!user || !UserStore.verifyPassword(String(password || ''), user.hash)) {
      return res.status(401).json({ code: 401, msg: '用户名或密码错误' })
    }
    if (user.status !== 'active') {
      return res.status(403).json({ code: 403, msg: '账号已停用,请联系管理员' })
    }
    loginAttempts.delete(ip) // 登录成功重置限速
    users.touchLogin(user.username)
    const token = issueSession(user.username)
    setSessionCookie(res, token)
    res.json({
      code: 0,
      data: { username: user.username, role: user.role, modules: users.modulesOf(user) }
    })
  })

  app.post('/api/auth/logout', (req, res) => {
    destroySession(req.cookies?.[COOKIE])
    res.clearCookie(COOKIE, { path: '/' })
    res.json({ code: 0, data: { ok: true } })
  })

  app.get('/api/auth/me', (req, res) => {
    if (!enabled) {
      return res.json({ code: 0, data: { authDisabled: true, username: null, role: null, modules: null } })
    }
    if (users.isEmpty()) {
      return res.json({ code: 0, data: { initialized: false, username: null, role: null, modules: null } })
    }
    const user = currentUser(req)
    if (!user) {
      return res.status(401).json({ code: 401, msg: '未登录或会话已过期' })
    }
    res.json({
      code: 0,
      data: {
        initialized: true,
        username: user.username,
        role: user.role,
        modules: users.modulesOf(user)
      }
    })
  })

  // ── 用户管理(仅管理员)──────────────────────────────
  app.get('/api/users/roles', requireAdmin, (req, res) => {
    res.json({ code: 0, data: { roles: users.roles() } })
  })

  app.get('/api/users', requireAdmin, (req, res) => {
    res.json({ code: 0, data: { users: users.list(), roles: users.roles() } })
  })

  app.post('/api/users', requireAdmin, (req, res) => {
    const { username, password, role, status, modules } = req.body || {}
    try {
      const user = users.create({ username, password, role, status, modules })
      res.json({ code: 0, data: user })
    } catch (e) {
      res.status(400).json({ code: 400, msg: e.message })
    }
  })

  app.put('/api/users/:username', requireAdmin, (req, res) => {
    const { role, status, modules, password } = req.body || {}
    const target = req.params.username
    // 禁止把最后一个管理员降级/停用,防止锁死
    const targetUser = users.findByUsername(target)
    if (targetUser?.role === 'admin' && users.list().filter((u) => u.role === 'admin').length <= 1) {
      if (role && role !== 'admin') return res.status(400).json({ code: 400, msg: '不能降级最后一个管理员' })
      if (status === 'disabled') return res.status(400).json({ code: 400, msg: '不能停用最后一个管理员' })
    }
    try {
      const user = users.update(target, { role, status, modules, password })
      res.json({ code: 0, data: user })
    } catch (e) {
      res.status(400).json({ code: 400, msg: e.message })
    }
  })

  app.delete('/api/users/:username', requireAdmin, (req, res) => {
    const target = req.params.username
    if (target === req.user.username) {
      return res.status(400).json({ code: 400, msg: '不能删除当前登录用户' })
    }
    try {
      users.remove(target)
      res.json({ code: 0, data: { deleted: target } })
    } catch (e) {
      res.status(400).json({ code: 400, msg: e.message })
    }
  })

  // 周期清理过期会话与登录限速记录,防止长期运行内存/文件无限增长(G2/G3)
  setInterval(() => {
    const now = Date.now()
    let changed = false
    for (const [k, s] of Object.entries(sessions)) {
      if (s.expiresAt < now) {
        delete sessions[k]
        changed = true
      }
    }
    for (const [ip, rec] of loginAttempts) {
      if (rec.resetAt < now) loginAttempts.delete(ip)
    }
    if (changed) saveSessions()
  }, 30 * 60 * 1000).unref()

  // 返回给 index.js:守卫挂载与状态
  return {
    enabled,
    users,
    requireAuth,
    requireAdmin,
    currentUser
  }
}
