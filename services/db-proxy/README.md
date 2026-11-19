# db-proxy:数据库多引擎执行代理(客户机侧)

> **定位(2026-08 权限策略调整后):零读写限制的"多引擎数据执行器"。**
> db-proxy 自身不做门户用户权限判断(库/表白名单与写门禁已移除;
> Spark-Flink 写门禁),所有权限统一由**门户网关**管控。db-proxy 只做:
> **X-DB-Token 鉴权 → 连库执行 → 资源护栏 → 审计**。

## 架构与信任链

```
浏览器/前端 → 门户网关(唯一权限点)
              ├─ 登录/角色 + data/db-permissions.json 权限矩阵
              ├─ /api/db、/api/dbquery、/api/spark、/api/flink 路由写检测(SQL 走私/写语句)
              └─ exec-gate(写操作需密码解锁,权限校验)
                    ↓  dbProxyUrl(如 http://10.25.15.106:8756) + X-DB-Token
              db-proxy(本服务)
              ├─ require_auth(X-DB-Token 匹配 authToken)     ← 服务入口鉴权
              ├─ 校验网关签发的短时 HMAC 主体声明(X-DB-Subject*)
               ├─ 资源护栏: 行数上限 / maxSqlLen / 全局与主体级并发/QPS / 超时
              ├─ 执行: MySQL(Doris)/Oracle/Impala / Spark / Flink / prejob
              └─ 审计日志(时间/库/SQL/行数/耗时)
```

> ⚠️ **安全边界**:数据库 `/query` 与 `/jobs` 接口除 `X-DB-Token` 外,还要求网关签发的短时 HMAC 主体声明；任务状态和取消也会在 db-proxy 再次核对主体。直接持有 `X-DB-Token` 不足以冒充门户用户调用这些接口。其他 Spark/Flink/prejob 接口仍应由防火墙限制来源。
> 1. **防火墙只放行门户服务器 IP** 访问 8756(禁止内网其他机器直连);
> 2. `authToken` 保密(与门户 `config.local.json` 的 `dbProxyToken` 一致),并建议单独配置随机 `identitySecret` 与门户 `dbProxyIdentitySecret` 一致；身份密钥不能下发浏览器。

## 配置唯一来源 `datasources.json`

> 代码写死 `CONFIG_FILE = "datasources.json"`(当前工作目录),文件缺失/非法直接启动报错。

```json
{
  "authToken": "CHANGE_ME",
  "adminToken": "CHANGE_ME_DIFFERENT_FROM_AUTH_TOKEN",
  "identitySecret": "CHANGE_ME",
  "listenHost": "0.0.0.0",
  "listenPort": 8756,
  "maxConcurrent": 5,
  "maxQps": 10,
  "maxConcurrentPerSubject": 2,
  "maxQpsPerSubject": 3,
  "defaultLimit": 1000,
  "maxLimit": 500000,
  "queryTimeout": 60,
  "connectTimeout": 5,
  "oracleClientLib": "/usr/lib/oracle/19.19/client64/lib",
  "datasources": [
    { "name": "mysql_example", "type": "mysql", "connectionString": "mysql://USER:PASSWORD@mysql.example:3306/example_db?charset=utf8mb4" },
    { "name": "oracle_example", "type": "oracle", "connectionString": "oracle://USER:PASSWORD@oracle.example:1521/service_name", "rowLimit": "rownum" },
    { "name": "doris_example", "label": "Doris", "type": "mysql", "connectionString": "mysql://USER:PASSWORD@doris.example:9030/default?charset=utf8mb4" },
    { "name": "impala_example", "type": "impala", "hosts": ["impala-1.example", "impala-2.example"], "port": 21050, "user": "USER", "password": "PASSWORD", "database": "default", "readOnly": true }
  ],
  "impala": { "typeCheck": { "enabled": true }, "aiFix": { "enabled": false, "baseUrl": "https://api.example/v1", "apiKey": "CHANGE_ME", "model": "CHANGE_ME", "maxAttempts": 2 } },
  "spark": { "enabled": false, "master": "yarn", "queue": "default", "executorMemory": "2g", "executorCores": 2, "executorInstances": 0, "sparkConf": {}, "jdbcUrl": "jdbc:hive2://127.0.0.1:10001/default", "user": "root", "beelinePath": "", "exportPath": "hdfs:///tmp/db-proxy-spark-exports" },
  "flink": { "enabled": false }
}
```

### 数据源连接配置与管理 API

`datasources` 中每个对象独立描述一个数据库；JSON 根级保留全局认证、超时、行数和并发配置。db-proxy 启动时加载该配置；管理员可经门户后端管理 MySQL、Oracle、Doris 数据源，更新后由 db-proxy 校验、原子保存并立即热重载，无需重启。管理端点要求独立配置且不同于 `authToken` 的非空 `adminToken`，支持 `GET/POST /admin/datasources`、`PUT/DELETE /admin/datasources/{name}`、`POST /admin/datasources/test`。列表响应不包含密码；创建/更新可提交 `expectedRevision`，删除可用 `If-Match`，版本过期返回 409。配置文件仍保存数据库明文凭证，必须限制在 db-proxy 主机并保持权限 `0600`。

### 数据同步 SQL/JSON 生成

根级可选 `dataSync` 配置控制 `POST /sync/db2hive`。`enabled` 必须为 `true`；`hiveMetastore` 是查询 `lion_dw_ods` Hive 表结构的 MySQL 连接（`align_with_hive=true` 时必需）；`datax.mysqlPassword` 是 MySQLReader 的 DataX 密码，`datax.mysqlUsername` 可选覆盖源数据用户名，`datax.oracleUsername`/`oraclePassword` 用于 OracleReader；`datasourceOverrides` 可用数据源 `name` 覆盖单个源的相应 DataX 凭据或 Oracle JDBC URL。生成 JSON 时，reader `password` 按 `lion#code_` 可逆变换格式编码；已带该前缀的值原样保留。该格式不是密码学加密。`defaultFs` 与 `hadoopConfig` 可覆盖 HDFS HA writer 设置。DataX 凭据与 Hive metastore 密码只放在运行机权限受限的 `datasources.json` 中。CSV 同步只替换 `datasources`，会保留这些根级配置。

Oracle 的 Service Name、owner/schema 与 table 分开处理：连接使用数据源 Service Name；元数据和默认查询 schema 使用数据源配置 `owner`（旧配置缺省取 `name`）。新同步请求用 `datasource_id` 唯一定位连接，并传 `service_name`、`owner`、`table_name`；db-proxy 校验服务名和 owner 与该连接配置一致。`db_name` 继续作为 Hive 目标名前缀。旧请求仍可使用 `{db_name, table_name}`，Oracle `table_name` 支持 `OWNER.TABLE` 并拆分 owner/table；未指定 owner 的旧请求回退到配置 owner。

MySQL、Oracle、Doris 的 CSV 导入来源是项目根目录 `bi_hosts_databases.csv`，只用于首次初始化或显式迁移。CSV 将库名和库 ID 分别放在 `数据库名称列表`、`数据库ID列表`；`datasource` 行定义显式连接，`inventory` 行的分号分隔库清单逐库生成连接项并补齐缺项；同名时显式 datasource 优先。`credential_profile` 行定义共享账号或单数据源覆盖。Oracle inventory 行优先使用 `Oracle服务名`，服务名为空时按维护约定回退到 schema 名。Doris 导入后使用 `type: "mysql"` 与 `sourceType: "doris"`。先准备运行配置 `datasources.json`（从 `datasources.json.example` 复制并填写根级设置及非 CSV 引擎配置），可预演：

```bash
python3 services/db-proxy/sync_datasources.py \
  --csv bi_hosts_databases.csv \
  --config services/db-proxy/datasources.json --dry-run
```

确认后可运行 `./manage.sh import-csv` 显式导入。该命令保留 JSON 根级配置和非 CSV 引擎，仅替换 MySQL/Oracle/Doris 条目；CSV/profile 密码展开到受限权限的 JSON 配置。`manage.sh start`、`restart` 与 `check-datasources` 不再自动同步，日常维护以门户数据库连接管理或 JSON 为准。不要把含账号密码的 CSV 提交到版本库。

连接串中的用户名、密码和数据库名按 URL 规则编码；例如密码里的 `@` 写成 `%40`。MySQL/Doris 使用 `mysql://用户:密码@主机:端口/库名?charset=utf8mb4`；Oracle 使用 `oracle://用户:密码@主机:端口/service_name`。CSV 的 Doris 类型会生成 `type: "mysql"`，通过 MySQL 协议连接。Impala 支持多个主机，继续使用 `hosts` 等字段。旧式 `host`/`port`/`user`/`password` 配置和 `connectionProfiles` 仍可读取以兼容现有部署。

- `allowedDbs`、`allowedTables` 在 db-proxy 配置中仅为旧版 `/acl` 回显字段，不在代理侧实施过滤；新配置可省略。前端列表只负责展示；网关会按 `db-permissions` 规则过滤列表并校验查询，无匹配规则时由 `defaultDeny` 决定是否放行
- `type` 支持 `mysql`(含 Doris)、`oracle` 与 `impala`
- Impala 可配置多个 `hosts`,端口默认 `21050`;`typeCheck` 开启 sqlglot/Hive 方言校验和 DESCRIBE 驱动的类型修正
- `impala.aiFix` 为可选 OpenAI-compatible 接口配置,密钥只放在客户机 `datasources.json`;仅语法/类型/表列名错误触发,修复 SQL 会重新校验为单条只读查询
- Impala `readOnly: true` 会在 db-proxy 再次拒绝写语句
- Oracle 连 11g 必须 `rowLimit: "rownum"` + `oracleClientLib`
- `maxConcurrent/maxQps` 是进程全局查询上限;`maxConcurrentPerSubject`(默认 2)与`maxQpsPerSubject`(默认 3)分别限制单个门户用户/API Token 主体;`maxSqlLen`(默认 32KB)在顶层配置
- 网关对每个 db-proxy 请求签发短时 HMAC 主体声明;`identitySecret` 推荐使用独立随机密钥,缺省兼容回退 `authToken`。主体签名缺失、过期或无效时,查询执行/异步任务接口拒绝请求;`authToken` 与 `identitySecret` 都为空时,查询接口会以 503 拒绝请求。配额和任务归属表均为单进程内状态。
- `allowWrite`/`writeToken`(spark/flink 段)已废弃,不再生效
- SparkSQL 工作台「导出到 HDFS」把单条只读 `SELECT/WITH` 的完整结果写成带表头 CSV 目录;默认根目录 `hdfs:///tmp/db-proxy-spark-exports`,可用 `spark.exportPath` 覆盖。结果按唯一任务目录保存,不收集到 driver;导出失败不返回路径。此配置由 db-proxy 启动时加载,修改后重启生效。

## 启动与进程管理

生产 Linux 环境使用管理脚本；服务启动前校验当前 `datasources.json` 并管理 PID 与日志。日常连接配置通过门户管理界面热重载；CSV 只在需要时显式导入：

```bash
./manage.sh start
./manage.sh status
./manage.sh check-datasources   # 按当前 JSON 逐个探测 MySQL/Doris/Impala/Oracle
./manage.sh import-csv          # 可选：显式执行一次 CSV 导入
./manage.sh logs --follow
./manage.sh restart
./manage.sh stop
```

`check-datasources` 从当前 JSON 读取数据源并直接建立连接执行只读 `SELECT 1`（Oracle 使用 `SELECT 1 FROM dual`）；默认最多 5 个并发连接，单个探测超时 5 秒。输出通过数、总耗时和每个失败项的类型、名称、耗时及脱敏错误原因；有失败时返回非零状态。可用 `DB_PROXY_CHECK_WORKERS`（1–32）和 `DB_PROXY_CHECK_TIMEOUT`（秒，1–60）调整并发和超时，`--verbose` 显示成功项。Doris 使用 MySQL 协议探测，通过 `sourceType: "doris"` 区分。

默认使用 `/opt/spark4-orc/` 作为 `SPARK_HOME`、`/opt/spark/thrift-conf` 作为 `SPARK_CONF_DIR`，Python 使用 `/opt/spark/spark4/py312/bin/python3.12`，监听 `0.0.0.0:8756`。可通过 `DB_PROXY_DIR`、`DB_PROXY_CSV`（仅 `import-csv`）、`DB_PROXY_SPARK_HOME`、`DB_PROXY_SPARK_CONF_DIR`、`DB_PROXY_PYTHON`、`DB_PROXY_HOST`、`DB_PROXY_PORT`、`DB_PROXY_CHECK_WORKERS`、`DB_PROXY_CHECK_TIMEOUT` 覆盖。PID 文件为 `db-proxy.pid`，日志为 `db-proxy.log`；启动后运行 `./manage.sh status` 查看状态。

本地开发仍可直接运行：

```bash
python3 main.py        # 依赖 requirements.txt;Flink 需 pyflink;Spark session 需 PySpark/YARN 客户端环境,Thrift 需 SPARK_HOME/bin/beeline
```

## 请求执行生命周期(MySQL/Doris/Oracle/Impala)

```
请求 → require_auth(X-DB-Token) → 路由 → get_datasource(db)
  → _prepare_query: strip 注释/结尾分号 → is_select 判定(SELECT/SHOW/DESC/EXPLAIN/WITH)
  → 护栏: maxSqlLen / maxQps / maxConcurrent / 行数上限(maxLimit 超限 400)
  → SELECT/WITH 服务端隐式追加行数限制;SHOW/DESC/EXPLAIN 保持原文 → 最多读取 limit+1 行 → 截断并返回
  → Impala:服务端 DESCRIBE/sqlglot 类型检查 → 查询;可修复错误调用可选 AI,执行日志随异步 job 状态返回
  → 写语句(INSERT/UPDATE/DELETE/DDL...) → 原样执行 → _write_audit 审计
```

**无感行数限制(各引擎统一,仅查询类)**
- 前端画布 SQL 保持不变;db-proxy 只在发送到数据库前对无显式行数限制的 `SELECT` / `WITH` 隐式添加引擎对应的上限。Impala 无顶层 `FROM` 且不是集合查询的常量 `SELECT` 不追加 SQL `LIMIT`，但仍通过 `fetchmany(limit + 1)` 限制返回行数。
- MySQL/Doris/Impala 使用 `LIMIT n`,Oracle 12c+ 使用 `FETCH FIRST n ROWS ONLY`,Oracle 11g 使用 `ROWNUM` 包装;Spark SELECT/WITH 使用执行计划限行。
- `SHOW`/`DESC`/`DESCRIBE`/`EXPLAIN` 不追加 SQL 后缀,使用 cursor/Spark 有界迭代读取结果,避免特殊命令被改写后语法错误。
- 默认返回上限为 1000 行;各引擎硬上限为 500,000 行。用户 SQL 自带行数限制时沿用;超过硬上限直接 400(Spark/Flink 按硬上限截取)。达到默认或用户上限时通过 `truncated` 标记告知前端。
- Spark SQL 无显式 `LIMIT` 时默认最多返回 1,000 行;SQL 显式限制最高为 500,000 行。Spark 结果通过 `limit+1` 有界收集并标记截断,不先统计完整结果或自动导出 HDFS。

## 保留的资源护栏(非权限)

| 护栏 | 行为 |
|---|---|
| `X-DB-Token` 鉴权 | 与 `authToken` 不符 → 401(配置空 = 不鉴权,不推荐) |
| 行数上限 | 默认 1000 行;硬上限 `maxLimit`(默认 500000) |
| `maxSqlLen` | SQL 超 32768 字节(默认)拒绝 |
| `maxConcurrent` / `maxQps` | 进程级并发与 QPS 上限 → 429 |
| `maxConcurrentPerSubject` / `maxQpsPerSubject` | 已验签门户主体的并发与查询提交 QPS 上限 → 429 |
| 超时 | 连接/查询超时可配,防远端卡死 |
| 审计 | 每次查询/写操作落日志(时间/库/SQL/行数/耗时) |
| `/explain` 只读检查 | EXPLAIN 仅允许只读 SQL(防 MySQL 5.x EXPLAIN DML 真执行) |

## 接口总表

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/health` | 探活 |
| GET  | `/dbs` | 全部数据源 name(无白名单过滤) |
| GET  | `/acl` | 配置回显(脱敏,含引擎状态)；Oracle 项包含 `serviceName` 与 `owner` |
| POST | `/query` | 同步执行,body `{db, sql, schemaName?, timeoutMs?}`；Oracle `schemaName` 必须匹配数据源 owner |
| POST | `/jobs` | 异步提交,body 同上 → `{jobId}` |
| GET/POST | `/jobs/{id}[/cancel]` | 异步任务状态/取消 |
| GET  | `/tables` `/fields` `/ddl` `/schema` | 元数据(表/字段/建表 DDL/完整 schema)；Oracle 使用数据源配置 `owner`（旧配置缺省为 `name`），Service Name 用于连接 |
| POST | `/explain` | 执行计划树(只读 SQL)，Oracle 可传经数据源校验的 `schemaName` |
| POST | `/sync/db2hive` | 生成 Hive 建表/新增字段 SQL 与 DataX JSON；新请求 `{datasource_id, service_name, owner, db_name, table_name, align_with_hive?}`，旧 `{db_name, table_name, align_with_hive?}` 保持兼容；仅 MySQL/Oracle 数据源；DataX 类型限 `bigint`、`double`、`string`，与 Hive 类型不一致时仍生成并在 `data.type_warnings` 返回告警 |
| POST | `/spark/query` | Spark SQL 执行;body `{db, sql, executionMode?}` |
| GET | `/spark/schema/databases?executionMode=` | Spark 库列表(SHOW DATABASES;TTL 缓存 5 分钟;模式由 query 参数选择) |
| GET | `/spark/schema/tables?db=&executionMode=` | Spark 库下表列表(SHOW TABLES IN;模式由 query 参数选择) |
| GET | `/spark/schema/fields?db=&table=&executionMode=` | Spark 表字段列表(DESC,含类型/注释;模式由 query 参数选择) |
| GET  | `/spark/status?executionMode=` `/spark/logs?executionMode=` | 指定模式的连接状态 / 执行日志 |
| GET  | `/spark/stages?executionMode=` | SparkSession 最近一次 SQL 的 Stage 状态;Thrift 返回空状态 |
| POST | `/spark/jobs` + `GET /spark/jobs/{id}?executionMode=` + `POST /spark/jobs/{id}/cancel` | Spark 异步;提交 body `{db, sql, executionMode?}`;取消可在 JSON body 带 `executionMode` |
| POST | `/flink/query` `/flink/async` (+`/{id}[/cancel]`) | Flink 交互式(批/流) |
| GET  | `/flink/status` `/flink/connectors` `/flink/jobs` | 状态/连接器/流式任务 |
| POST | `/flink/ddl/generate` | 按连接器模板生成建表 DDL |
| POST | `/flink/prejob/jobs` (+`GET /{id}` `/logs` `/cancel` `/disable` `/enable` `PUT /{id}`) | PreJob 独立作业 |
| GET  | `/flink/prejob/config` | PreJob 配置快照 |
| GET/POST | `/scripts/*` | 已迁移平台的旧脚本接口,保留兼容 |

POST 查询、异步任务、导出及取消请求在 JSON body 中携带 `executionMode: "thrift" | "session"`;提交请求未提供时默认 `thrift`。GET Schema、状态、日志、Stage 和 job 轮询请求在 query string 中携带 `?executionMode=session`。异步 job 的状态与取消始终由 jobId 找到原提交模式；客户端应记录该模式并构造对应轮询请求，不要使用用户后来切换的工作台选择。例如：`GET /spark/jobs/abc123?executionMode=session` 和 `POST /spark/jobs/abc123/cancel`（body `{executionMode: "session"}`）。即使控制请求省略模式或带入了当前工作台模式，服务端仍以 job 原归属引擎执行状态/取消。查询、异步任务、状态/取消、日志/Stage、Schema 元数据与 HDFS 导出均按该值路由，响应结构与门户权限校验保持一致。失败不会自动重试另一模式。`session` 指历史 YARN client PySpark `SparkSession`，不是 `spark-sql` shell；SQL 工作台不执行 PySpark 代码。

## Spark Thrift 查询

Thrift 模式在部署主机上启动 Beeline 子进程连接 Spark Thrift Server。默认配置对应的命令为：

```bash
$SPARK_HOME/bin/beeline -u 'jdbc:hive2://127.0.0.1:10001/default' -n root -e 'SELECT ...'
```

`datasources.json` 顶层 `spark` 段：

```json
"spark": {
  "enabled": true,
  "jdbcUrl": "jdbc:hive2://127.0.0.1:10001/default",
  "user": "root",
  "beelinePath": "",
  "defaultLimit": 1000,
  "maxLimit": 500000,
  "maxSqlLen": 65536,
  "exportPath": "hdfs:///tmp/db-proxy-spark-exports"
}
```

Thrift 使用 `jdbcUrl`、`user`、`beelinePath` 等 JDBC/Beeline 字段。Session 模式使用同一 `spark` 段中的历史 YARN client 字段：`master`、`queue`、`executorMemory`、`executorCores`、`executorInstances`、`sparkConf` (以及可选 `appName`)；`master` 默认 `yarn`。两条通道并存，不会因一条通道失败自动切换到另一条。

`beelinePath` 留空时使用 `$SPARK_HOME/bin/beeline`；db-proxy 与 Spark Thrift Server 同机且共享网络命名空间时通过回环地址访问。若 db-proxy 在 Docker 容器中，容器内的 `127.0.0.1` 指向容器本身，需把 `jdbcUrl` 配成容器可达的宿主机地址。Thrift 查询和元数据通过 HiveServer2 执行；取消终止对应 Beeline 子进程，日志显示 stderr 进度与诊断信息，结果 CSV 单独解析后返回。HDFS 导出使用 `INSERT OVERWRITE DIRECTORY ... USING CSV` 并仅返回目录路径。Session 使用历史 YARN client PySpark `SparkSession` 通道。更新配置后重启 db-proxy；门户工作台选择器随前端发布，需要重建门户镜像。

普通 `SELECT/WITH` 查询在 SQL 执行前补上默认 `LIMIT`，已有顶层 `LIMIT` 不超过 `maxLimit`；`SHOW`、`DESC`、`EXPLAIN` 不改写。通过 `/spark/query` 或 `/spark/jobs` 提交 PySpark 代码 payload 会返回 HTTP 400；PySpark 仅由 session 适配器内部执行工作台 SQL。

## Flink 引擎(双通道:交互式 + PreJob)

内嵌 PyFlink 1.17.2:

| 通道 | 模式 | 特点 |
|---|---|---|
| **交互式** | 常驻 YARN Session,共享一个会话 | 秒回,脚本式多语句,流批双模式,适合探索调试 |
| **PreJob** | `flink run -t yarn-per-job -d` 独立作业 | 正式管道,与交互会话完全隔离,可查状态/日志/停止 |

### 配置(datasources.json `flink` 段)

```json
"flink": {
  "enabled": true,
  "javaHome": "/root/whm/jdk/jdk-11.0.32+9",
  "flinkHome": "",
  "hiveLib": "",
  "yarnAppId": "application_xxx",
  "queue": "default",
  "defaultLimit": 1000,
  "maxLimit": 500000,
  "queryTimeout": 300,
  "catalogs": ["CREATE CATALOG paimon_hive_store WITH (...)"],
  "defaultCatalog": "paimon_hive_store",
  "pipelineJars": ["file:///opt/streamx/flink/flink-1.17.2/lib/xxx.jar"],
  "prejob": {
    "enabled": true,
    "flinkHome": "/opt/streamx/flink/flink-1.17.2",
    "pythonBin": "/root/whm/py38/bin/python3.8",
    "javaHome": "/root/whm/jdk/jdk-11.0.32+9",
    "hadoopConfDir": "/etc/hadoop/conf",
    "queue": "default",
    "yarnRmUrl": "http://hadoop-nn-1.bigdata.shiqiao.com:8088",
    "jobsDir": "flink-prejobs",
    "maxConcurrent": 5,
    "submitTimeout": 120
  }
}
```

**特性**
- SQL 脚本 `;` 分隔逐条执行,最后一条查询返回结果;流式 `INSERT INTO` 提交常驻任务返回 jobId
- DDL/CREATE CATALOG 等写操作:引擎不再校验 `allowWrite`/`writeUnlocked`,直接放行——
  写权限由门户网关 `/api/flink` 管控
- 交互通道接口:query/async/cancel/status/connectors(+probe)/ddl/generate/jobs(+stop)
- PreJob 通道:yarn-per-job 独立提交,状态存 `flink-prejobs/prejobs.json`,
  经 YARN REST 刷新;支持 cancel/disable/enable/update/logs

## 平台接入

平台网关 `server/config.js` 配置 `dbProxyUrl`(如 `http://10.25.15.106:8756`),
网关 `/api/db/*`、`/api/dbquery/*`、`/api/spark/*`、`/api/flink/*` 代理到该服务。
平台服务器 `server/config.local.json` 加:

```json
"dbProxyUrl": "http://10.25.15.106:8756",
"dbProxyToken": "与客户机 datasources.json 的 authToken 一致"
```

> **推荐防火墙策略**:db-proxy 机器 8756 端口**只放行门户服务器 IP**,
> 其余来源一律拒绝——门户是唯一合法入口,直连被网络层堵死。

## 已废弃项(配置仍在/死代码,运行无影响)

- 配置字段:`allowedDbs`/`allowedTables`/`allowWrite`/`writeToken`/`readOnly`(仅 /acl 回显)
- 代码:`is_write_sql`/`WRITE_KW`(spark_engine)、`_is_write_sql`(main.py)、
  `check_read_only_sql` 残留判定——已无调用,保留待清
