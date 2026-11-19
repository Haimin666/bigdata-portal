# 模块:数据同步代码生成(sync)

## 1. 职责

选择源数据库连接与表，调用网关生成 db2hive SQL 与 JSON 配置，并支持复制。MySQL 选择库后选择表；Oracle 分开选择 Service Name、稳定数据源连接、可选 owner/schema 和表。owner/schema 留空时列出该账号可见且受 allowlist 限制的全部表，选项使用 `OWNER.TABLE` 消歧。表选项从稳定数据源 ID 对应的元数据接口加载。`db_name` 用作 Hive 目标名前缀：MySQL 取配置数据库名，Oracle 取所选 owner；全部 schema 模式从所选 `OWNER.TABLE` 推导 owner。Oracle Service Name 只用于连接。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/views/sync/SyncCodeView.vue` | TableToolbar 输入区、Oracle Service Name/稳定连接/owner/schema/表逐级选择（owner 从当前连接 `/owners` 加载并支持全部可见 schema）、SQL/JSON 结果面板与复制操作 |
| 路由 | `src/config/menu.ts` | `/sync` 原生模块入口，受 `enabledModules`/用户模块权限控制 |
| 网关 | `server/routes/sync-proxy.js` | 保留 `/api/sync/db2hive`，鉴权后转发至 db-proxy `/sync/db2hive` |
| 服务 | `services/db-proxy/main.py`、`services/db-proxy/sync_generator.py` | 鉴权、数据源选择、读取 MySQL/Oracle 源表结构，生成 Hive SQL 与 DataX JSON |

## 3. API 与数据流

- 新版前端向 `POST /api/sync/db2hive` 发送 `{datasource_id, service_name, owner?, db_name, table_name}`；`datasource_id` 是唯一连接 ID，MySQL `db_name` 取配置数据库名。Oracle 的 `service_name` 与可选 `owner` 分别取连接 Service Name 和 schema；全部 schema 模式下 `owner` 留空、`table_name` 使用 `OWNER.TABLE`，后端据此选 owner。`db_name` 使用所选 owner（或表自身 owner）作为 Hive 目标名前缀。网关按字段白名单转发这些参数。连接 ACL 会附带非敏感的 `database` 字段供 MySQL 下拉显示。
- 旧调用仍可发送 `{db_name, table_name}`；db-proxy 按旧规则解析数据源，兼容期继续接受 Oracle `OWNER.TABLE`。
- db-proxy 按 `datasource_id` 查找新请求的数据源，并校验 `service_name` 与服务端配置一致；Oracle 显式 `owner` 或 `OWNER.TABLE` 前缀都必须属于非空 `owners` allowlist（allowlist 留空时以 Oracle 账号对象权限为边界），且两者同时提供时必须一致。未指定 owner、表名未限定时使用配置默认 owner；默认 owner 也为空时使用连接的 `CURRENT_SCHEMA`。全部 schema 模式使用 `OWNER.TABLE`。MySQL 的源 schema 仍取配置数据库名，Oracle 的 owner 独立于 Service Name。默认对齐 `lion_dw_ods` 中以 `db_name` 和表名构成的 Hive 表，并生成 DataX JSON。DataX 字段类型只生成 `bigint`、`double`、`string`；若 Hive 字段类型与源字段映射类型不一致，或 Hive 字段类型不在白名单内，仍完成生成并在响应中返回告警，前端提示核对 Hive 与 DataX 字段类型。
- Oracle `table_name` 在选定 owner 时使用未限定表名；全部 schema 模式下携带 `OWNER.TABLE` 以消除同名表歧义。owner 用于查询元数据和 DataX 源表，连接仍使用数据源配置中的 Service Name；Hive 目标表只采用所选/解析到的 owner 与表名。旧的 `OWNER.TABLE` 输入继续拆分出 owner 与 table；未带 owner 的旧请求保留配置 owner 的兼容回退。
- 网关继续返回 `{code: 0, data: {sqlContent, jsonContent, typeWarnings?}}`；存在字段类型问题时保留生成结果，并由页面提示核对 Hive 与 DataX 字段类型。
- 旧 `dbaSyncUrl` 不再用于门户同步页面。`bigdata-service` 可以继续服务其他调用方。

### db-proxy 配置

- `dataSync.enabled` 必须显式设为 `true` 才启用生成接口。
- `dataSync.hiveMetastore` 提供 Hive metastore MySQL 连接参数；对齐查询开启时使用。
- MySQL/Oracle DataXReader 的 `username/password` 直接使用所选数据源的 `user/password`；Oracle JDBC URL 使用同一连接配置的 Service Name。旧 `dataSync.datax` 用户名/密码与 `dataSync.datasourceOverrides` 凭据覆盖不再用于生成 Reader 凭据。生成 JSON 时，Reader 的 `password` 按 `lion#code_` 可逆变换格式编码；已带该前缀的值原样保留，避免重复编码。该格式不是密码学加密。
- `dataSync.hadoopConfig` 与 `dataSync.defaultFs` 可覆盖 DataX HDFS writer 配置。凭据只存放在 db-proxy 主机的私有 `datasources.json`，不得提交到仓库。
- `align_with_hive=false` 可跳过 metastore 查询，按源表字段生成建表 SQL 和 JSON。

## 4. 响应式布局

- 桌面端表单为：MySQL 的数据库类型、库、表；Oracle 的数据库类型、Service Name、连接、owner/schema、表。owner/schema 提供“全部可见 Schema”选项，所有下拉支持输入过滤；选择连接或 schema 后加载表。结果为 SQL/JSON 双栏。稳定数据源 ID 是连接选择的值。
- ≤640px 时表单控件纵向排列并允许收缩，生成按钮占满一行；代码面板改为纵向排列，长 SQL/JSON 在面板内滚动。
- 页面级别不得产生横向溢出，结果代码允许在各自代码框内横向滚动。
- **视觉层**:输入区使用桌面统一工具栏;SQL/JSON 结果使用独立浅色面板、低饱和边界和主题变量,不重复显示页面标题。

## 5. 权限与测试限制

- 模块是否可访问由门户统一模块白名单决定，不通过临时放开路由或伪造权限进行视觉测试。
- 浏览器请求使用 `portal_session` 且要求 `sync` 模块权限；配置 `syncApiToken` 后，机器调用可用 `X-API-Token` 访问 `/api/sync/*`，无需 Cookie。无效 Token 不旁路登录门禁。
- 若本地 `enabledModules` 未包含 `sync`，窄屏验证改为静态检查与构建校验，并注明无法执行页面级浏览器回归。
