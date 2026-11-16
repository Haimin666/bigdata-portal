// 异步任务归属表(网关侧,内存):jobId -> { owner, engine, createdAt, expiresAt }。
// 动机:db-proxy 只认机器 token,不区分用户;普通登录用户若直接拿他人 jobId 查询
// /api/db/jobs/:id、/api/spark/jobs/:id、/api/flink/async/:id 等,即可读取他人
// SQL 结果/日志甚至取消任务。所有「提交类」接口成功后在此登记 owner,所有
// 「按 id 查询/取消」接口先校验 owner(admin 放行),不匹配 403。
//
// owner 主体支持两种身份(与认证链路一致):
//  - 登录用户:user:<username>
//  - 数据库查询 API Token:token:<principal.id>
export const JOB_OWNERSHIP_TTL_MS = 2 * 60 * 60 * 1000 // 2h
export const JOB_OWNERSHIP_MAX_SIZE = 5000

function isAdminRequest(req) {
  // API Token 主体不适用 admin 放行(身份是 token 而非登录会话;真实链路二者不会同时存在)
  if (req?.dbQueryApiPrincipal) return false
  const user = req?.user || {}
  return user.role === 'admin' || (Array.isArray(user.roles) && user.roles.includes('admin'))
}

/** 请求主体标识;未知主体统一落 anonymous(认证关闭时的单租户场景)。 */
export function jobSubjectOf(req) {
  if (req?.dbQueryApiPrincipal) return `token:${req.dbQueryApiPrincipal.id || 'api'}`
  const user = req?.user || {}
  const name = user.username ?? user.user ?? user.name
  return name == null || name === '' ? 'anonymous' : `user:${String(name)}`
}

export function createJobOwnershipRegistry({
  ttlMs = JOB_OWNERSHIP_TTL_MS,
  maxSize = JOB_OWNERSHIP_MAX_SIZE,
  now = Date.now
} = {}) {
  const jobs = new Map()

  function prune() {
    const timestamp = now()
    for (const [id, record] of jobs) {
      if (record.expiresAt <= timestamp) jobs.delete(id)
    }
    while (jobs.size > maxSize) jobs.delete(jobs.keys().next().value)
  }

  return {
    register(req, engine, jobId, meta = {}) {
      if (!jobId) return
      prune()
      const id = String(jobId)
      jobs.delete(id)
      jobs.set(id, {
        owner: jobSubjectOf(req),
        engine: String(engine),
        createdAt: now(),
        expiresAt: now() + ttlMs,
        ...meta
      })
      prune()
    },
    record(jobId) {
      prune()
      return jobs.get(String(jobId)) || null
    },
    /** owner 校验:仅同主体且引擎匹配放行;admin 一律放行;未知 job 一律拒绝(fail-closed)。 */
    allows(req, engine, jobId) {
      prune()
      if (isAdminRequest(req)) return true
      const record = jobs.get(String(jobId))
      if (!record) return false
      if (String(engine) !== record.engine) return false
      return record.owner === jobSubjectOf(req)
    }
  }
}

export const jobOwnership = createJobOwnershipRegistry()
