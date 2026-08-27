// 执行类操作门禁(从 index.js 拆出):角色 + 模块白名单,防 viewer 越权。
// viewer(只读)一律禁止执行类操作;dev/admin 还需通过模块白名单。
// 模块白名单 null(全部)或包含 gate.module 才放行。
// 由 index.js 挂载:app.use(createExecGate(auth))

const EXEC_GATES = [
  { re: /^\/api\/spark\//, module: 'dbQuery' }, // SQL/PySpark 执行、解锁、停止
  { re: /^\/api\/flink\//, module: 'dbQuery' }, // Flink 查询/PreJob 提交/停止
  { re: /^\/api\/dbquery\//, module: 'dbQuery' }, // MySQL/Oracle 查询(/schema /explain 已改走 /api/db/* 透传)
  { re: /^\/api\/db\/jobs/, module: 'dbQuery', onlyWrite: true }, // MySQL/Oracle 异步任务提交/取消(GET 状态查询放行)
  { re: /^\/api\/db\/(schema|explain)(\/|$)/, module: 'dbQuery' }, // 元数据补全/执行计划(只读,仍需模块与角色门禁)
  { re: /^\/api\/scripts\/(new|rename|delete|move|save)/, module: 'dbQuery' }, // 脚本文件写(前缀匹配,容忍尾斜杠)
  { re: /^\/api\/ds-deps\/(refresh|rerun-instances|rerun-cascade|rerun-from-node)$/, module: 'dsTask' }, // 采集/重跑
  { re: /^\/api\/assistant\/projects/, module: 'assistant', onlyWrite: true }, // 项目/文件/目录/上传/会话绑定(POST/PUT/PATCH/DELETE;GET 只读放行)
  { re: /^\/hadoopapi\//, module: 'yarn', onlyWrite: true } // RM 管理 REST(非 GET)
]

export function createExecGate(auth) {
  return (req, res, next) => {
    if (!auth.enabled) return next()
    // Express 路由大小写不敏感,门禁路径统一小写匹配,防 /API/... 变体绕过
    const p = req.path.toLowerCase()
    const gate = EXEC_GATES.find(
      (g) => g.re.test(p) && (g.onlyWrite ? !['GET', 'HEAD'].includes(req.method) : true)
    )
    if (!gate) return next()
    const user = req.user || auth.currentUser(req)
    if (!user) return res.status(401).json({ code: 401, msg: '未登录或会话已过期' })
    if (user.role === 'viewer') {
      return res.status(403).json({ code: 403, msg: '只读账号无权执行该操作' })
    }
    const mods = auth.users.modulesOf(user)
    if (gate.module && mods && Array.isArray(mods) && !mods.includes(gate.module)) {
      return res.status(403).json({ code: 403, msg: `无 ${gate.module} 模块权限,无法执行该操作` })
    }
    next()
  }
}