# 模块：db-permissions — 数据库访问权限矩阵（P3）

## 定位

在门户网关层新增**用户/角色 → 数据源（库）**授权矩阵，与既有权限体系并存：

| 既有能力 | 粒度 | 说明 |
|---|---|---|
| EXEC_GATES（`server/index.js`） | 模块级 | admin/dev/viewer + modules 白名单，拦「执行类操作」 |
| db-proxy `allowedDbs`（全局白名单） | 库级（人人相同） | `datasources.json` 启动加载，`check_db_allowed` 校验 |
| 数据源 `readOnly` | 数据源级 | db-proxy 拒绝非查询 SQL，写尝试记审计 |
| 写解锁 `X-Spark-Token` | 会话级 | 密码解锁后 12h 有效，绑定 username |
| **db-permissions 矩阵（本模块）** | **用户/角色→库级** | **按调用者区分可访问库，网关层校验** |

设计原则：**权限继续收口在网关**，db-proxy 保持无用户概念的机器代理（`main.py` L78 注释约定）；矩阵只控制「能访问哪些库」，readOnly 覆盖不做（数据源级 readOnly 已覆盖）。

## 存储

`server/data/db-permissions.json`（不存在时视为无规则，**不拦截**）：```json
{
  "version": 1,
  "userRules": [ { "user": "alice", "dbs": ["accounting", "credzy"] } ],
  "roleRules": [ { "role": "dev", "dbs": ["*"] } ]
}
```

- `dbs: ["*"]` 表示不限制（该用户/角色对全部库放行）。
- 匹配规则：**先查 userRules（精确用户名）**，命中即用；未命中再用 roleRules（该用户的角色）。**匹配规则后**，若请求的 db 不在其 dbs → 403 `database 'xxx' not allowed for user 'yyy'`。
- 未配置任何规则 / 用户与角色均无规则 → 放行（兼容现状，回退全局 allowedDbs 由 db-proxy 兜底）。
- **规则文件损坏（JSON 解析失败）→ fail-closed**：非 admin 一律 403（提示联系管理员修复），避免矩阵静默失效。
- **admin 角色一律放行**（管理特权，规则只约束 dev/viewer）。

## 校验点（网关 `server/index.js` / `db-permissions.js`）

带 `db` 参数的 MySQL/Oracle 访问接口，执行前校验：

| 接口 | db 参数位置 | 校验方式 |
|---|---|---|
| `POST /api/dbquery/query` | body | 路由内显式调用 |
| `POST /api/db/jobs`（提交） | body | 路由内显式调用（GET 状态查询放行） |
| `POST /api/db/explain` | body | 路由内显式调用 |
| `GET /api/db/tables`、`/fields`、`/ddl`、`/schema` | query | `app.use('/api/db', ...)` 前置中间件（仅处理 GET+query.db，其余 next） |

spark/flink 引擎查询不在本矩阵范围（引擎侧库概念不同）。

## 管理 API（admin only）

- `GET /api/db-perms` → `{ code: 0, data: { userRules, roleRules } }`
- `PUT /api/db-perms` body `{ userRules, roleRules }` → 全量覆盖保存（原子写：`.tmp` + `renameSync`，文件 `0600`；每条规则校验 `{user|role: 非空字符串, dbs: 字符串数组}`，非法 400）

## 前端

- `src/api/db.ts`：`getDbPerms()` / `saveDbPerms(rules)`
- `src/views/admin/DbPermView.vue`（路由 `/db-perms`，`meta.adminOnly`，对标 `UserManageView.vue`）：
  - 两个 tab：用户规则 / 角色规则
  - 规则列表：主体（用户/角色名）+ 库列表（tag 展示）+ 编辑/删除
  - 新增/编辑：主体输入（用户名可从 `/api/users` 选择，角色下拉 dev/viewer）+ 库多选（选项来自 `/api/db/dbs` 数据源目录）+ 「全部库」开关（写入 `*`）
  - 顶部说明：未配置规则的用户按 db-proxy 全局白名单放行；admin 不受限

## 文档与代码冲突

代码优先，但必须回写本文件与 `docs/ARCHITECTURE.md` 权限节。
