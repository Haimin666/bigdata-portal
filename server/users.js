// 用户存储:data/users.json + scrypt 密码哈希(零依赖,node:crypto)。
// 结构:
// {
//   "version": 1,
//   "roles": {
//     "admin":  { "title": "管理员", "modules": null },   // null = 全部模块
//     "dev":    { "title": "开发",   "modules": ["yarn", "dsTask", "hdfs", "dbQuery", ...] },
//     "viewer": { "title": "只读",   "modules": ["yarn", "hdfs"] }
//   },
//   "users": [
//     {
//       "username": "admin",
//       "hash": "scrypt:<salt>:<hash>",
//       "role": "admin",
//       "status": "active",            // active | disabled
//       "modules": null,               // null = 继承角色;数组 = 个人白名单覆盖
//       "createdAt": "...", "updatedAt": "...", "lastLoginAt": null
//     }
//   ]
// }
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_ROLES = {
  admin: { title: '管理员', modules: null },
  dev: {
    title: '开发',
    modules: ['yarn', 'dsTask', 'hdfs', 'dbQuery', 'stingray', 'ds', 'streamx', 'jupyter', 'omd']
  },
  viewer: { title: '只读', modules: ['yarn', 'hdfs'] }
}

export class UserStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'users.json')
    this._data = this._load()
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
      raw.roles = { ...DEFAULT_ROLES, ...(raw.roles || {}) }
      raw.users = raw.users || []
      return raw
    } catch {
      return { version: 1, roles: { ...DEFAULT_ROLES }, users: [] }
    }
  }

  _save() {
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf-8')
    fs.renameSync(tmp, this.file)
  }

  // ── 密码 ─────────────────────────────────────────────
  static hashPassword(pwd) {
    const salt = randomBytes(16).toString('hex')
    const h = scryptSync(String(pwd), salt, 64).toString('hex')
    return `scrypt:${salt}:${h}`
  }

  static verifyPassword(pwd, stored) {
    const [algo, salt, h] = String(stored || '').split(':')
    if (algo !== 'scrypt' || !salt || !h) return false
    try {
      const calc = scryptSync(String(pwd), salt, 64)
      return timingSafeEqual(Buffer.from(h, 'hex'), calc)
    } catch {
      return false
    }
  }

  // ── 用户 ─────────────────────────────────────────────
  isEmpty() {
    return this._data.users.length === 0
  }

  list() {
    return this._data.users.map((u) => this._public(u))
  }

  findByUsername(username) {
    return this._data.users.find((u) => u.username === String(username).trim()) || null
  }

  /** 创建用户;首个用户强制 admin */
  create({ username, password, role = 'dev', status = 'active', modules = null }) {
    const name = String(username || '').trim()
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(name)) throw new Error('用户名需为 2-32 位字母/数字/_.-')
    if (!password || String(password).length < 6) throw new Error('密码至少 6 位')
    if (this.findByUsername(name)) throw new Error(`用户已存在:${name}`)
    if (!this._data.roles[role]) throw new Error(`未知角色:${role}`)
    if (!['active', 'disabled'].includes(status)) throw new Error(`非法状态:${status}`)
    const now = new Date().toISOString()
    const user = {
      username: name,
      hash: UserStore.hashPassword(String(password)),
      role: this.isEmpty() ? 'admin' : role,
      status,
      modules: modules || null,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null
    }
    this._data.users.push(user)
    this._save()
    return this._public(user)
  }

  /** 更新用户(角色/状态/模块/重置密码)。password 为空表示不修改密码。 */
  update(username, { role, status, modules, password } = {}) {
    const user = this.findByUsername(username)
    if (!user) throw new Error(`用户不存在:${username}`)
    if (role !== undefined) {
      if (!this._data.roles[role]) throw new Error(`未知角色:${role}`)
      user.role = role
    }
    if (status !== undefined) {
      if (!['active', 'disabled'].includes(status)) throw new Error(`非法状态:${status}`)
      user.status = status
    }
    if (modules !== undefined) user.modules = modules || null
    if (password) {
      if (String(password).length < 6) throw new Error('密码至少 6 位')
      user.hash = UserStore.hashPassword(String(password))
    }
    user.updatedAt = new Date().toISOString()
    this._save()
    return this._public(user)
  }

  remove(username) {
    const user = this.findByUsername(username)
    if (!user) throw new Error(`用户不存在:${username}`)
    if (user.role === 'admin' && this._data.users.filter((u) => u.role === 'admin').length <= 1) {
      throw new Error('不能删除最后一个管理员')
    }
    this._data.users = this._data.users.filter((u) => u.username !== username)
    this._save()
  }

  touchLogin(username) {
    const user = this.findByUsername(username)
    if (user) {
      user.lastLoginAt = new Date().toISOString()
      this._save()
    }
  }

  /** 用户可访问模块:个人 modules 覆盖角色;null = 全部 */
  modulesOf(user) {
    if (user.modules && Array.isArray(user.modules) && user.modules.length > 0) return user.modules
    const roleModules = this._data.roles[user.role]?.modules
    if (roleModules && Array.isArray(roleModules) && roleModules.length > 0) return roleModules
    return null // 全部
  }

  roles() {
    return this._data.roles
  }

  _public(u) {
    return {
      username: u.username,
      role: u.role,
      status: u.status,
      modules: u.modules,
      effectiveModules: this.modulesOf(u),
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      lastLoginAt: u.lastLoginAt
    }
  }
}
