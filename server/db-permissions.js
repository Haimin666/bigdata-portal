// 数据权限矩阵:用户/角色 → 可访问数据库列表
// 设计契约见 docs/modules/db-permissions.md;与既有权限体系并存:
//   EXEC_GATES(模块级) → db-proxy allowedDbs(全局白名单) → 本矩阵(按调用者区分)。
// 存储:data/db-permissions.json(server/../data),不存在/损坏一律视为"无规则 → 放行",
// 不拦截,由 db-proxy 全局白名单兜底。
import fs from 'node:fs'
import path from 'node:path'

const PERMS_FILE = path.join(import.meta.dirname, '../data', 'db-permissions.json')

/** 读取规则文件;不存在返回空规则(无规则→放行),损坏时 console.warn 并返回
 *  {userRules:[], roleRules:[], broken:true}(有规则文件但损坏 = fail-closed,
 *  非 admin 一律拒绝,避免矩阵静默失效)。 */
export function loadPerms() {
  let raw
  try {
    raw = fs.readFileSync(PERMS_FILE, 'utf-8')
  } catch {
    return { userRules: [], roleRules: [] }
  }
  try {
    const data = JSON.parse(raw) || {}
    return {
      userRules: Array.isArray(data.userRules) ? data.userRules : [],
      roleRules: Array.isArray(data.roleRules) ? data.roleRules : []
    }
  } catch (e) {
    console.warn(`[db-permissions] 规则文件损坏,按 fail-closed 处理: ${e instanceof Error ? e.message : e}`)
    return { userRules: [], roleRules: [], broken: true }
  }
}

/** 全量覆盖保存(原子写:.tmp + renameSync,照 dataleap.js 模板),返回保存后的规则对象。 */
export function savePerms(rules) {
  const { userRules, roleRules } = rules || {}
  const data = {
    version: 1,
    userRules: Array.isArray(userRules) ? userRules : [],
    roleRules: Array.isArray(roleRules) ? roleRules : []
  }
  fs.mkdirSync(path.dirname(PERMS_FILE), { recursive: true })
  const tmp = PERMS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, PERMS_FILE)
  return data
}

/** 管理员判定:与现有认证链路一致(user.role === 'admin'),兼容 roles 数组形态。 */
export function isAdmin(req) {
  const u = req?.user || {}
  return u.role === 'admin' || (Array.isArray(u.roles) && u.roles.includes('admin'))
}

/**
 * 返回用户可访问库列表:
 *  - userRules 精确匹配 username,命中即返回其 dbs(不再看角色规则);
 *  - 否则遍历 roleRules,匹配 roles 中任一角色,返回第一个命中;
 *  - 都不中返回 null(= 不限制,兼容现状)。
 * 规则条目 dbs 非数组(脏数据)按 null 处理 → 放行(由 db-proxy 全局白名单兜底)。
 */
export function allowedDbsFor(perms, username, roles) {
  const { userRules, roleRules } = perms
  const name = username == null ? '' : String(username)
  const userRule = userRules.find((r) => r && String(r.user) === name)
  if (userRule) return Array.isArray(userRule.dbs) ? userRule.dbs : null
  const roleList = Array.isArray(roles) ? roles.map(String) : []
  for (const r of roleRules) {
    if (r && roleList.includes(String(r.role))) {
      return Array.isArray(r.dbs) ? r.dbs : null
    }
  }
  return null
}

/**
 * 核心校验(网关层):
 *  - dbName 为空/非字符串 → 直接通过;
 *  - admin → 通过;无规则(allowedDbsFor 返回 null)→ 通过;
 *  - dbs 含 '*' → 通过;dbName ∈ dbs → 通过;
 *  - 否则抛 statusCode=403 错误。
 */
export function checkDbAccess(req, dbName) {
  if (typeof dbName !== 'string' || dbName.trim() === '') return
  if (isAdmin(req)) return
  const perms = loadPerms()
  if (perms.broken) {
    // 规则文件损坏:非 admin 一律拒绝(fail-closed),需管理员修复 data/db-permissions.json
    const err = new Error('数据权限规则文件损坏,请联系管理员修复(server/data/db-permissions.json)')
    err.statusCode = 403
    throw err
  }
  const user = req?.user || {}
  const username = user.username ?? user.user ?? user.name ?? ''
  const roles = Array.isArray(user.roles) ? user.roles : user.role ? [user.role] : []
  const dbs = allowedDbsFor(perms, username, roles)
  if (dbs == null) return // 无规则 → 放行(兼容现状,db-proxy 全局白名单兜底)
  if (dbs.includes('*')) return
  if (dbs.includes(dbName)) return
  const err = new Error(`数据库 '${dbName}' 未授权给用户 '${username}'`)
  err.statusCode = 403
  throw err
}
