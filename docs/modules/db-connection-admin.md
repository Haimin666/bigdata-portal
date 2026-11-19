# 模块：数据库连接配置管理（db-connection-admin）

## 1. 职责

在“用户管理 → 数据库连接”中按 Oracle、MySQL、Doris 三个 Tab 分开展示数据源，并提供新增、编辑、删除和连接测试。关键词搜索、排序和分页均作用于当前引擎 Tab。门户浏览器只访问 Express 管理 API；门户后端使用服务端管理凭证代理到 db-proxy。数据库密码只写入 db-proxy 主机上的 `datasources.json`，列表响应只提供 `hasPassword` 状态，不回传密码。

CSV 是一次性初始化/导入来源。初始化后 `datasources.json` 是唯一运行时事实来源；管理 API 写入后由 db-proxy 校验、原子持久化并热重载，不要求重启服务。Impala、Spark、Flink 及其它 JSON 根级配置由此功能保留，不被关系型数据源 CRUD 覆盖。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 前端视图 | `src/views/admin/UserManageView.vue` | 用户管理工作区新增“数据库连接”标签 |
| 前端视图 | `src/views/admin/DbConnectionView.vue` | 可排序连接表、跨字段关键词搜索、分页与类型汇总、引擎表单和连接测试 |
| 前端 API | `src/api/db-connections.ts` | 门户同源管理 API；不含 db-proxy 凭证 |
| 网关 | `server/routes/db-config.js` | admin-only API；仅服务端向 db-proxy 转发并注入管理凭证 |
| 网关配置 | `server/config.js` / `server/config.local.example.json` | `dbProxyAdminToken`，只保存在服务端本地配置 |
| db-proxy | `services/db-proxy/main.py` | 独立管理凭证鉴权、连接测试、datasources JSON 原子更新与运行时热重载 |
| 运维 | `services/db-proxy/manage.sh` / `sync_datasources.py` | CSV 同步仅通过显式 `import-csv` 命令运行，服务启动和连通性批检不再自动导入 |

## 3. API 与数据流

浏览器只调用门户接口：

- `GET /api/db-config/datasources`：管理员读取可管理数据源清单，密码以 `hasPassword` 布尔值表示。
- `POST /api/db-config/datasources`：新增。
- `PUT /api/db-config/datasources/:name`：更新；请求密码为空时保留现有密码。
- `DELETE /api/db-config/datasources/:name`：删除。
- `POST /api/db-config/test`：测试表单中的临时连接，不保存配置。
- 列表返回配置 `revision`；增删改携带 revision，旧版本请求返回 409，要求刷新后再提交。

Express 对上述路由执行 `requireAdmin`，再调用 db-proxy `/admin/datasources` 与 `/admin/datasources/test`。两服务之间使用单独的 `dbProxyAdminToken` / `adminToken`，不复用查询 `authToken` / `dbProxyToken`，也不返回给浏览器。

db-proxy 在进程内构建候选 `DataSource` 集合并验证唯一名称、引擎和必要连接参数；通过后写临时文件并 `os.replace` 原子替换 JSON，再将候选配置与数据源映射切换为当前运行态。验证或持久化失败时保留上一个 JSON 和运行态。连接测试在 db-proxy 主机发起只读探测：MySQL/Doris 使用 `SELECT 1`，Oracle 使用 `SELECT 1 FROM dual`，结果不包含密码。

## 4. 字段规则

- MySQL：名称、主机、端口、用户名、密码、数据库名、字符集、只读标记。
- Doris：名称、主机、MySQL 协议端口、用户名、密码、数据库名、字符集、只读标记。运行配置使用 `type: "mysql"` 与 `sourceType: "doris"`。
- Oracle：名称、主机、端口、用户名、密码、明确的 Service Name、owner/schema、行数限制模式、只读标记。名称是门户查询参数与权限规则使用的稳定数据源 ID；Service Name 只用于连接；owner/schema 独立用于元数据和默认查询 schema，未配置时回退到名称。名称、Service Name 与 owner/schema 可不同。
- 名称在配置中唯一且用于 SQL 工作台的 `db` 参数及数据权限规则；编辑时保持名称不变，数据源类型也不可切换，避免权限规则与脚本引用静默失效。Oracle 的 `/acl` 列表额外返回 `serviceName` 与 `owner`，用于 UI 展示与请求上下文；客户端仍以名称路由和授权。
- 删除前检查用户/角色数据权限矩阵的引用；仍被引用时拒绝删除并提示先移除对应权限规则。
- 列表只回传连接参数与凭据是否已配置，不回传密码。新增要求密码非空；编辑留空表示保留已存密码。
- 当前引擎连接列表按名称、地址、用户、数据库/服务名、认证和访问模式排序；关键词对名称、显示名、类型、主机、端口、用户和数据库/服务名做不区分大小写的包含匹配，多个空格分隔的词均需命中。
- Oracle、MySQL、Doris Tab 按顺序排列，各 Tab 数量徽标统计该引擎全部连接；当前 Tab 内的关键词搜索、排序和分页相互联动，分页总数只计算当前 Tab 中匹配的连接。

## 5. 安全与部署

- 管理 API 仅向登录管理员开放；认证关闭时连接管理 API fail-closed，不允许绕过登录管理凭据。db-proxy 仍建议用防火墙限制为门户服务器可达。
- 管理 token 分别配置在门户 `server/config.local.json` 的 `dbProxyAdminToken` 与 db-proxy `datasources.json` 根级 `adminToken`，均不得提交 git 或下发浏览器。
- db-proxy 配置文件权限为 `0600`，服务不需重启即可生效。门户与 db-proxy 可在不同主机，前提是门户服务端能访问 `dbProxyUrl`。
- CSV 同步脚本继续保留用于首次导入/人工迁移，但 `manage.sh start`、`restart` 和 `check-datasources` 不自动从 CSV 覆盖 JSON。
