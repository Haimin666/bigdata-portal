# 模块：db-permissions — 数据库访问权限矩阵（P3）

## 定位

在门户网关层新增**用户/角色 → 数据源（库）**授权矩阵，与既有权限体系并存：

| 既有能力 | 粒度 | 说明 |
|---|---|---|
| EXEC_GATES（`server/middleware/exec-gate.js`） | 模块级 | admin/dev/viewer + modules 白名单，拦「执行类操作」 |
| db-proxy `allowedDbs`（全局白名单） | 库级（人人相同） | `datasources.json` 启动加载，`check_db_allowed` 校验 |
| 数据源 `readOnly` | 数据源级 | db-proxy 拒绝非查询 SQL，写尝试记审计 |
| ~~写解锁 `X-Spark-Token`~~ | 已移除 | 写权限密码验证移除,由库权限矩阵 + 数据源 readOnly 管控 |
| **db-permissions 矩阵（本模块）** | **用户/角色→库级** | **按调用者区分可访问库，网关层校验** |

设计原则：**权限继续收口在网关**，db-proxy 保持无用户概念的机器代理（`main.py` L78 注释约定）；矩阵只控制「能访问哪些库」，readOnly 覆盖不做（数据源级 readOnly 已覆盖）。表规则中 `tables: null` 表示全部表，`tables: []` 表示不允许任何表。

## 存储

`server/data/db-permissions.json`（**仅文件不存在(ENOENT)**时视为无规则、不拦截；其他读取失败按损坏处理 fail-closed）：```json
{
  "version": 2,
  "userRules": [ { "user": "alice", "engineRules": [ { "engine": "*", "db": "*", "tables": null, "read": true, "write": false } ], "spark": { "read": true, "write": true }, "flink": { "enabled": true } } ],
  "roleRules": [ { "role": "dev", "engineRules": [ { "engine": "mysql", "db": "accounting", "tables": null, "read": true, "write": true } ] } ]
}
```

- **v2 规则形状**:`{user|role, engineRules[], spark?, flink?}`;`engineRules` 每条 `{engine: 'mysql'|'oracle'|'impala'|'*', db, tables: string[]|null, read, write}`。
- **`db: "*"` = 所有库**(2026-08):执行校验(`checkDbAccess`)与 ACL 库下拉过滤(`allowedDbsFor`)均识别通配;旧 `dbs:["*"]`/`dbs:[...]`(v1)加载时自动迁移为 v2(全部引擎读写 + spark/flink 全开)。
- 匹配规则：**先查 userRules（精确用户名），命中即用（覆盖角色规则，不再回退）**；未命中再用 roleRules（该用户的角色）。**匹配规则后**，若请求的 db 不在其 dbs/engineRules → 403。
- **defaultDeny 开关**（2026-08）：规则文件 `"defaultDeny": true` 时，**未配置任何规则的用户/角色一律拒绝**（DB/Spark/Flink 403、ACL 下拉为空）；false/缺省则无规则放行（仅受全局白名单兜底）。管理页头部可切换（开启有确认弹窗）。
- 未配置任何规则 / 用户与角色均无规则 → 按 defaultDeny 决定放行或拒绝；admin 一律放行。
- **规则文件损坏（JSON 解析失败 / 非 ENOENT 的读取失败）/ 结构非法 → fail-closed**：非 admin 一律 403（提示联系管理员修复），避免矩阵静默失效。2026-11 前 EACCES/EISDIR 等读取异常会被当成"无规则"而放行所有人。
- **表级白名单 fail-closed（2026-11）**：规则的 `tables` 为数组时，SQL 表引用提取失败（`extractTables` 返回 `null`，如 `FROM (--c ...)` 这类无法可靠识别）→ 403，不再像以前那样把 `[]` 当"没有表引用"跳过校验。
- **引擎未知 fail-closed（2026-11）**：`dbEngine()` 未命中数据源映射时返回 `null`；命中规则但引擎未知 → 403（此前退化为"任意引擎规则都匹配"）。网关会先惰性拉 `/api/db/acl` 建映射，仍失败则拒绝受限用户（admin 不受影响）。
- **元数据接口与表级规则（2026-11）**：配置 `tables` 白名单的用户调用 `/api/db/tables`、`/api/db/schema`（整库枚举）直接 403；`/fields`、`/ddl` 带 `table` 时按该表校验，缺 `table` 时 fail-closed；`/explain` 对所有用户做表级校验。
- **`/api/db/dbs`（2026-11）**：改为网关侧代理并按权限过滤（普通用户 `allowedDbsFor`、API Token 按 `apiTokenAllowsDatabase`、admin 全量），不再透传 db-proxy 的全量数据源名。
- **Flink 读写分离（2026-11）**：`flink` 规则支持显式 `read`/`write`；写 SQL（多语句脚本中任一条写也算）需 `write` 权限，`writeUnlocked`/`X-Spark-Write` 只在判定为写时置位。旧规则仅 `{enabled:true}` 视为读写均开放（兼容）。
- **异步任务归属（2026-11）**：`/api/db/jobs/:id`、`/api/spark/jobs/:id`、`/api/flink/async/:id`、`/api/flink/prejob/jobs/:id` 的查询/取消/日志要求提交者是当前用户（admin 放行），API Token 只能访问自己提交的任务（见 `server/utils/job-ownership.js`，TTL 2h）。
- **admin 角色一律放行**（管理特权，规则只约束 dev/viewer）。

## 校验点（网关 `server/middleware/exec-gate.js` + 各 `server/routes/*.js` / `db-permissions.js`）

带 `db` 参数的 MySQL/Oracle/Impala 访问接口，执行前校验：

| 接口 | db 参数位置 | 校验方式 |
|---|---|---|
| `POST /api/dbquery/query` | body | 路由内显式调用 |
| `POST /api/db/jobs`（提交） | body | 路由内显式调用（GET 状态查询放行） |
| `POST /api/db/explain` | body | 路由内显式调用 |
| `GET /api/db/tables`、`/fields`、`/ddl`、`/schema` | query | `app.use('/api/db', ...)` 前置中间件（仅处理 GET+query.db，其余 next） |
| `GET /api/db/search/tables` | query.keyword | 返回结果按当前用户允许的数据库过滤（表级白名单下的表名泄露仍属已知限制） |
| `GET /api/db/dbs` | — | 网关代理 + 按 `allowedDbsFor`/Token 规则过滤 |
| `GET /api/spark/schema/*`、`/api/spark/{logs,status,stages}` | — | 统一 `checkSparkAccess` 读校验（2026-11 前部分接口无校验） |
| `/api/flink/{status,connectors,jobs,prejob/*}` | — | 统一 `checkFlinkAccess` 读校验 |

Spark/Flink 常规权限继续使用各自规则；Spark 可选 `writeDbs: string[]` 限制写入目标库。字段缺省保持旧规则行为（有写权限即不限制库），显式空数组表示禁止 Spark 写库。

### 数据库查询 API Token

- 唯一 Token 密钥放在门户服务端 `config.local.json` 的 `dbQueryApiToken`；数据库名单不再重复配置。
- API Token 映射到权限矩阵中的虚拟角色 `db-query-api`。该角色不对应登录账号，角色规则在用户管理 → 数据权限中单独展示和编辑；没有该角色规则时 API Token 的数据库访问默认拒绝，不受 `defaultDeny=false` 的无规则放行影响。
- 通过 `engineRules` 配置 `{engine:"impala"|"mysql"|"oracle", db:"库名", read:true, write:false}` 控制 Impala/MySQL/Oracle 只读查询；通过 Spark 规则 `{read:true, write:true, writeDbs:["目标库"]}` 控制 Spark 读和可写库。Token 本身仍被网关硬限制为 Impala/MySQL/Oracle 单条只读 SQL与 Spark 路由、Spark SQL（不含 PySpark）及 `INSERT INTO` / `INSERT OVERWRITE`；Spark 写 SQL 必须全限定目标库并与请求 `db` 相同。异步任务状态/取消仅允许该 Token 访问自己提交的任务。
- Impala 表级规则仍约束查询引用表；表目录/字段/DDL/整库 Schema 元数据接口要求库规则为整库读取（`tables: null`），以免受限表名或结构通过元数据接口泄露。
- `dbQueryApiToken` 只认证身份，所有库权限均由上述权限矩阵决定；db-proxy 不参与门户用户/Token 授权。

## 管理 API（admin only）

- `GET /api/db-perms` → `{ code: 0, data: { userRules, roleRules } }`
- `PUT /api/db-perms` body `{ userRules, roleRules }` → 全量覆盖保存（原子写：`.tmp` + `renameSync`，文件 `0600`；每条规则校验 `{user|role: 非空字符串}` + `dbs`(v1,字符串数组) 或 `engineRules`(v2,数组且每条 db 非空) 之一，非法 400。2026-08 修复:v2 规则曾被 v1 校验误拒导致保存失败）

## 前端

- `src/api/db.ts`：`getDbPerms()` / `saveDbPerms(rules)`（含 `defaultDeny`）
- `src/views/admin/DbPermView.vue`（内嵌「用户管理」页「数据权限」tab，对标 `UserManageView.vue`）：
  - 两个 tab：用户规则 / 角色规则
  - **角色规则表预设角色全量展示**（2026-08）：未配置的角色也列出（带「未配置」标记），点编辑即创建；已配置但不在预设中的自定义角色追加在后
  - 规则编辑：`DbRuleEditor`（引擎/库/表/读写 + Spark 读写库范围 + Flink；库支持「所有库」`*`）；虚拟角色 `db-query-api` 固定可选
  - 头部「默认拒绝」开关（defaultDeny，开启需确认）；顶部说明匹配顺序与当前模式

## 文档与代码冲突

代码优先，但必须回写本文件与 `docs/ARCHITECTURE.md` 权限节。
