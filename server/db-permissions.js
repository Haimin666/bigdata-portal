// 数据权限矩阵 v2:用户/角色 → 引擎级规则 + Spark/Flink 权限
// 设计契约见 docs/modules/db-permissions.md;与既有权限体系并存:
//   EXEC_GATES(模块级) → db-proxy allowedDbs(全局白名单) → 本矩阵(按调用者区分)。
//
// 规则 v2 形状(data/db-permissions.json):
// {
//   version: 2,
//   userRules: [{
//     user: 'bob',
//     engineRules: [                 // mysql/oracle 类引擎规则
//       { engine: 'mysql'|'oracle'|'*', db: 'xxx', tables: ['t1'] | null(全部),
//         read: true, write: false }
//     ],
//     spark: { read: true, write: false } | null(无 Spark 权限),
//     flink: { enabled: true } | null(无 Flink 权限)
//   }],
//   roleRules: [ 同构, key 为 role ]
// }
// 兼容:v1 规则 {user|role, dbs: string[]} 加载时自动迁移(v1 语义 = 全部引擎该库
// 可读可写;spark/flink 保持旧版可用,由管理员后续收紧)。
import fs from 'node:fs'
import path from 'node:path'

const PERMS_FILE = path.join(import.meta.dirname, '../data', 'db-permissions.json')

function isV1Rule(r) {
  return !!r && Array.isArray(r.dbs) && !Array.isArray(r.engineRules)
}

/** 迁移 v1 规则 → v2(旧 dbs 语义:全部引擎该库读写;spark/flink 保持可用) */
function migrateV1(r) {
  const base = { user: r.user, role: r.role }
  return {
    ...base,
    engineRules: r.dbs.map((d) => ({ engine: '*', db: String(d), tables: null, read: true, write: true })),
    spark: { read: true, write: true },
    flink: { enabled: true }
  }
}

/** 读取规则文件;不存在返回空规则(无规则→按 defaultDeny 决定放行/拒绝),损坏时 console.warn 并返回
 *  {userRules:[], roleRules:[], broken:true}(有规则文件但损坏 = fail-closed,
 *  非 admin 一律拒绝,避免矩阵静默失效)。 */
export function loadPerms() {
  let raw
  try {
    raw = fs.readFileSync(PERMS_FILE, 'utf-8')
  } catch {
    return { userRules: [], roleRules: [], defaultDeny: false }
  }
  try {
    const data = JSON.parse(raw) || {}
    const userRules = (Array.isArray(data.userRules) ? data.userRules : []).map((r) => (isV1Rule(r) ? migrateV1(r) : r))
    const roleRules = (Array.isArray(data.roleRules) ? data.roleRules : []).map((r) => (isV1Rule(r) ? migrateV1(r) : r))
    return { userRules, roleRules, defaultDeny: data.defaultDeny === true }
  } catch (e) {
    console.warn(`[db-permissions] 规则文件损坏,按 fail-closed 处理: ${e instanceof Error ? e.message : e}`)
    return { userRules: [], roleRules: [], broken: true }
  }
}

/** 全量覆盖保存(原子写:.tmp + renameSync,照 dataleap.js 模板),返回保存后的规则对象。 */
export function savePerms(rules) {
  const { userRules, roleRules, defaultDeny } = rules || {}
  const data = {
    version: 2,
    defaultDeny: defaultDeny === true,
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

/** 命中规则:userRules 精确匹配 username 优先,否则 roleRules 按角色回退;都不中返回 null(= 放行) */
export function ruleForUser(perms, username, roles) {
  const name = username == null ? '' : String(username)
  const userRule = perms.userRules.find((r) => r && String(r.user) === name)
  if (userRule) return userRule
  const roleList = Array.isArray(roles) ? roles.map(String) : []
  for (const r of perms.roleRules) {
    if (r && roleList.includes(String(r.role))) return r
  }
  return null
}

/**
 * 返回用户可访问库列表(v2 engineRules 的 db 并集;无规则:defaultDeny → [](全拒),
 * 否则 null = 不限制)。用于 /api/db/acl 过滤数据源下拉。旧 v1 数据经 loadPerms 迁移后同样生效。
 */
export function allowedDbsFor(perms, username, roles) {
  const rule = ruleForUser(perms, username, roles)
  if (!rule) return perms.defaultDeny ? [] : null
  const dbs = new Set()
  for (const er of rule.engineRules || []) {
    if (er && typeof er.db === 'string' && er.db) dbs.add(er.db)
  }
  if (rule.engineRules && rule.engineRules.some((er) => er && er.db === '*')) return ['*']
  return dbs.size ? [...dbs] : null
}

function deny(msg) {
  const err = new Error(msg)
  err.statusCode = 403
  throw err
}

function checkBroken(perms) {
  if (perms.broken) {
    deny('数据权限规则文件损坏,请联系管理员修复(server/data/db-permissions.json)')
  }
}

/**
 * MySQL/Oracle 引擎访问校验:
 *  - 命中规则 → 按 engine+db 匹配 engineRules:读需 read=true,写需 write=true,
 *    tables 非空时请求引用的表必须 ⊆ 允许表;
 *  - 无规则 → defaultDeny 开启时拒绝(未授权),否则放行(db-proxy 全局白名单兜底);
 *  - admin 一律放行。
 */
export function checkDbAccess(req, dbName, opts = {}) {
  const { engine = '', write = false, tables = null } = opts
  if (typeof dbName !== 'string' || dbName.trim() === '') return
  if (isAdmin(req)) return
  const perms = loadPerms()
  checkBroken(perms)
  const user = req?.user || {}
  const username = user.username ?? user.user ?? user.name ?? ''
  const roles = Array.isArray(user.roles) ? user.roles : user.role ? [user.role] : []
  const rule = ruleForUser(perms, username, roles)
  if (!rule) {
    if (perms.defaultDeny) deny(`用户 '${username}' 未配置数据访问规则`)
    return
  }
  const engineRules = Array.isArray(rule.engineRules) ? rule.engineRules : []
  const matched = engineRules.find(
    (r) => r && (r.db === '*' || String(r.db) === dbName) && (!engine || r.engine === '*' || r.engine === engine)
  )
  if (!matched) deny(`数据库 '${dbName}' 未授权给用户 '${username}'`)
  if (write && matched.write !== true) deny(`数据库 '${dbName}' 未授予写权限`)
  if (!write && matched.read !== true) deny(`数据库 '${dbName}' 未授予读权限`)
  if (Array.isArray(tables) && tables.length && Array.isArray(matched.tables) && matched.tables.length) {
    const allowed = new Set(matched.tables.map((t) => String(t)))
    const denied = tables.filter((t) => !allowed.has(String(t)))
    if (denied.length) deny(`表未授权: ${denied.join(', ')}`)
  }
}

/** Spark 访问校验:规则命中时需 spark.{read|write};admin 放行;无规则按 defaultDeny 决定 */
export function checkSparkAccess(req, write = false) {
  if (isAdmin(req)) return
  const perms = loadPerms()
  checkBroken(perms)
  const user = req?.user || {}
  const username = user.username ?? user.user ?? user.name ?? ''
  const roles = Array.isArray(user.roles) ? user.roles : user.role ? [user.role] : []
  const rule = ruleForUser(perms, username, roles)
  if (!rule) {
    if (perms.defaultDeny) deny(`用户 '${username}' 未配置数据访问规则`)
    return
  }
  const sp = rule.spark
  if (!sp || typeof sp !== 'object') deny('未授权使用 Spark')
  if (write && sp.write !== true) deny('Spark 未授予写权限')
  if (!write && sp.read !== true) deny('Spark 未授予读权限')
}

/** Flink 使用校验:规则命中时需 flink.enabled === true;admin 放行;无规则按 defaultDeny 决定 */
export function checkFlinkAccess(req) {
  if (isAdmin(req)) return
  const perms = loadPerms()
  checkBroken(perms)
  const user = req?.user || {}
  const username = user.username ?? user.user ?? user.name ?? ''
  const roles = Array.isArray(user.roles) ? user.roles : user.role ? [user.role] : []
  const rule = ruleForUser(perms, username, roles)
  if (!rule) {
    if (perms.defaultDeny) deny(`用户 '${username}' 未配置数据访问规则`)
    return
  }
  if (!rule.flink || rule.flink.enabled !== true) deny('未授权使用 Flink')
}
