# 模块:数据同步代码生成(sync)

## 1. 职责

输入数据库类型、已授权数据源、Hive 目标名前缀和源表名，调用网关生成 db2hive SQL 与 JSON 配置，并支持复制。Oracle 的 Service Name、owner/schema、表名分别选择或填写；MySQL schema 仍由连接配置决定。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/views/sync/SyncCodeView.vue` | TableToolbar 输入区、SQL/JSON 结果面板与复制操作 |
| 路由 | `src/config/menu.ts` | `/sync` 原生模块入口，受 `enabledModules`/用户模块权限控制 |
| 网关 | `server/routes/sync-proxy.js` | 保留 `/api/sync/db2hive`，鉴权后转发至 db-proxy `/sync/db2hive` |
| 服务 | `services/db-proxy/main.py`、`services/db-proxy/sync_generator.py` | 鉴权、数据源选择、读取 MySQL/Oracle 源表结构，生成 Hive SQL 与 DataX JSON |

## 3. API 与数据流

- 新版前端向 `POST /api/sync/db2hive` 发送 `{datasource_id, service_name, owner, db_name, table_name}`；`datasource_id` 是唯一数据源名，`service_name` 和 Oracle `owner` 由所选数据源元数据填入，`db_name` 继续表示 Hive 目标名前缀。网关按字段白名单转发这些参数。
- 旧调用仍可发送 `{db_name, table_name}`；db-proxy 按旧规则解析数据源，兼容期继续接受 Oracle `OWNER.TABLE`。
- db-proxy 按 `datasource_id` 查找新请求的数据源，并校验 `service_name`、`owner` 与服务端配置一致；MySQL 的源 schema 仍取配置数据库名，Oracle 的 owner 独立于 Service Name。默认对齐 `lion_dw_ods` 中以 `db_name` 和表名构成的 Hive 表，并生成 DataX JSON。DataX 字段类型只生成 `bigint`、`double`、`string`；若 Hive 字段类型与源字段映射类型不一致，或 Hive 字段类型不在白名单内，仍完成生成并在响应中返回告警，前端提示核对 Hive 与 DataX 字段类型。
- Oracle `table_name` 使用未限定表名，`owner` 用于查询元数据和 DataX 源表，连接仍使用数据源配置中的 Service Name；Hive 目标表只采用 `db_name` 与表名。旧的 `OWNER.TABLE` 输入会拆分出 owner 与 table；未带 owner 的旧请求回退到配置 owner（未配置时为数据源名）。
- 网关继续返回 `{code: 0, data: {sqlContent, jsonContent, typeWarnings?}}`；存在字段类型问题时保留生成结果，并由页面提示核对 Hive 与 DataX 字段类型。
- 旧 `dbaSyncUrl` 不再用于门户同步页面。`bigdata-service` 可以继续服务其他调用方。

### db-proxy 配置

- `dataSync.enabled` 必须显式设为 `true` 才启用生成接口。
- `dataSync.hiveMetastore` 提供 Hive metastore MySQL 连接参数；对齐查询开启时使用。
- `dataSync.datax` 提供 MySQL DataX 密码以及 Oracle DataX 用户名/密码；`dataSync.datasourceOverrides` 可按数据源 `name` 覆盖单个源的 DataX 凭据或 Oracle JDBC URL。生成 JSON 时，MySQLReader/OracleReader 的 `password` 按 `lion#code_` 可逆变换格式编码；已带该前缀的值原样保留，避免重复编码。该格式不是密码学加密。DataX 密码用于生成配置，不是 db-proxy 的数据源连接密码。
- `dataSync.hadoopConfig` 与 `dataSync.defaultFs` 可覆盖 DataX HDFS writer 配置。凭据只存放在 db-proxy 主机的私有 `datasources.json`，不得提交到仓库。
- `align_with_hive=false` 可跳过 metastore 查询，按源表字段生成建表 SQL 和 JSON。

## 4. 响应式布局

- 桌面端表单为数据库类型、数据源/Service Name、Oracle owner/schema、Hive 目标名前缀、源表名和生成操作的紧凑布局，MySQL 隐藏 Oracle owner 控件，结果为 SQL/JSON 双栏。
- ≤640px 时表单控件纵向排列并允许收缩，生成按钮占满一行；代码面板改为纵向排列，长 SQL/JSON 在面板内滚动。
- 页面级别不得产生横向溢出，结果代码允许在各自代码框内横向滚动。
- **视觉层**:输入区使用桌面统一工具栏;SQL/JSON 结果使用独立浅色面板、低饱和边界和主题变量,不重复显示页面标题。

## 5. 权限与测试限制

- 模块是否可访问由门户统一模块白名单决定，不通过临时放开路由或伪造权限进行视觉测试。
- 浏览器请求使用 `portal_session` 且要求 `sync` 模块权限；配置 `syncApiToken` 后，机器调用可用 `X-API-Token` 访问 `/api/sync/*`，无需 Cookie。无效 Token 不旁路登录门禁。
- 若本地 `enabledModules` 未包含 `sync`，窄屏验证改为静态检查与构建校验，并注明无法执行页面级浏览器回归。
