# db-proxy:数据库多引擎执行代理(客户机侧)

> **定位(2026-08 权限策略调整后):零读写限制的"多引擎数据执行器"。**
> db-proxy 自身不做任何读写权限判断(已移除库白名单/表白名单/只读保护/多语句拦截/
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
              ├─ 资源护栏: 行数上限 / maxSqlLen / maxConcurrent / maxQps / 超时
              ├─ 执行: MySQL(Doris)/Oracle / Spark / Flink / prejob
              └─ 审计日志(时间/库/SQL/行数/耗时)
```

> ⚠️ **安全边界**:db-proxy 对 `8756` 端口零读写限制——谁能持 `X-DB-Token`
> 谁就能任意读写/执行 pyspark。防护依赖两点:
> 1. **防火墙只放行门户服务器 IP** 访问 8756(禁止内网其他机器直连);
> 2. `authToken` 保密(与门户 `config.local.json` 的 `dbProxyToken` 一致)。

## 配置唯一来源 `datasources.json`

> 代码写死 `CONFIG_FILE = "datasources.json"`(当前工作目录),文件缺失/非法直接启动报错。

```json
{
  "authToken": "你的访问token",                    // X-DB-Token 鉴权,留空=不鉴权
  "listenHost": "0.0.0.0",
  "listenPort": 8756,
  "defaultLimit": 100,                            // 无限制子句时默认行数
  "maxLimit": 10000,                              // 行数硬上限
  "queryTimeout": 60,
  "connectTimeout": 5,
  "allowedDbs": [],                               // 已废弃(不再拦截,仅 /acl 回显)
  "allowedTables": [],                            // 已废弃(同上)
  "oracleClientLib": "/usr/lib/oracle/19.19/client64/lib",  // Oracle 11g 必配(thick 模式)
  "datasources": [
    { "name": "credzy", "type": "oracle", "host": "...", "port": 1521,
      "user": "...", "password": "...", "service": "credzy", "rowLimit": "rownum" },
    { "name": "finance_order_trade", "type": "mysql", "host": "...", "port": 3343,
      "user": "...", "password": "...", "schema": "finance_order_trade" },
    { "name": "doris_cluster1", "type": "mysql", "host": "...", "port": 19030,
      "user": "...", "password": "...", "schema": "default" }
  ],
  "spark": { "enabled": false },                  // 见「Spark 引擎」
  "flink": { "enabled": false }                   // 见「Flink 引擎」
}
```

- `type` 仅支持 `mysql`(含 Doris,走 mysql 协议)与 `oracle`
- oracle 连 11g 必须 `rowLimit: "rownum"` + `oracleClientLib`
- `maxConcurrent/maxQps`、`maxSqlLen`(默认 32KB)在顶层配置
- `allowWrite`/`writeToken`(spark/flink 段)已废弃,不再生效

## 启动

```bash
python3 main.py        # 依赖 requirements.txt;spark 需 pyspark,flink 需 pyflink
```

## 请求执行生命周期(MySQL/Doris/Oracle)

```
请求 → require_auth(X-DB-Token) → 路由 → get_datasource(db)
  → _prepare_query: strip 注释/结尾分号 → is_select 判定(SELECT/SHOW/DESC/EXPLAIN/WITH)
  → 护栏: maxSqlLen / maxQps / maxConcurrent / 行数上限(maxLimit 超限 400)
  → SELECT/WITH 查询 → 追加行数限制 → 执行 → 行数截断 → 返回
  → 写语句(INSERT/UPDATE/DELETE/DDL...) → 原样执行 → _write_audit 审计
```

**行数限制追加规则(各引擎统一,仅查询类)**
- 仅 `SELECT` / `WITH` 前缀追加:
  - MySQL/Doris: `... LIMIT n`
  - Oracle 12c+: `... FETCH FIRST n ROWS ONLY`
  - Oracle 11g(`rowLimit:"rownum"`): `SELECT * FROM (sql) WHERE ROWNUM <= n`
- `SHOW`/`DESC`/`DESCRIBE`/`EXPLAIN` 与写语句**不追加**(Doris 等对非 SELECT 不接受 LIMIT 后缀)
- 用户 SQL 自带 `LIMIT n`/`FETCH FIRST`/`ROWNUM` 时沿用;超过 `maxLimit` 直接 400

## 保留的资源护栏(非权限)

| 护栏 | 行为 |
|---|---|
| `X-DB-Token` 鉴权 | 与 `authToken` 不符 → 401(配置空 = 不鉴权,不推荐) |
| 行数上限 | 无限制子句 SELECT 自动追加;硬上限 `maxLimit`(默认 10000) |
| `maxSqlLen` | SQL 超 32768 字节(默认)拒绝 |
| `maxConcurrent` / `maxQps` | 并发信号量 + QPS 限流 → 429 |
| 超时 | 连接/查询超时可配,防远端卡死 |
| 审计 | 每次查询/写操作落日志(时间/库/SQL/行数/耗时) |
| `/explain` 只读检查 | EXPLAIN 仅允许只读 SQL(防 MySQL 5.x EXPLAIN DML 真执行) |

## 接口总表

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/health` | 探活 |
| GET  | `/dbs` | 全部数据源 name(无白名单过滤) |
| GET  | `/acl` | 配置回显(脱敏,含引擎状态) |
| POST | `/query` | 同步执行,body `{db, sql, timeoutMs?}` |
| POST | `/jobs` | 异步提交,body 同上 → `{jobId}` |
| GET/POST | `/jobs/{id}[/cancel]` | 异步任务状态/取消 |
| GET  | `/tables` `/fields` `/ddl` `/schema` | 元数据(表/字段/建表 DDL/完整 schema) |
| POST | `/explain` | 执行计划树(只读 SQL) |
| POST | `/spark/query` | Spark SQL/pyspark 执行 |
| GET | `/spark/schema/databases` | Spark 库列表(SHOW DATABASES;TTL 缓存 5 分钟) |
| GET | `/spark/schema/tables?db=` | Spark 库下表列表(SHOW TABLES IN) |
| GET | `/spark/schema/fields?db=&table=` | Spark 表字段列表(DESC,含类型/注释) |
| GET  | `/spark/status` `/spark/logs` `/spark/stages` | session 状态/日志/阶段 |
| POST | `/spark/jobs` + `GET/POST /spark/jobs/{id}[/cancel]` | Spark 异步 |
| POST | `/flink/query` `/flink/async` (+`/{id}[/cancel]`) | Flink 交互式(批/流) |
| GET  | `/flink/status` `/flink/connectors` `/flink/jobs` | 状态/连接器/流式任务 |
| POST | `/flink/ddl/generate` | 按连接器模板生成建表 DDL |
| POST | `/flink/prejob/jobs` (+`GET /{id}` `/logs` `/cancel` `/disable` `/enable` `PUT /{id}`) | PreJob 独立作业 |
| GET  | `/flink/prejob/config` | PreJob 配置快照 |
| GET/POST | `/scripts/*` | 已迁移平台的旧脚本接口,保留兼容 |

## Spark 引擎(自建网关,替代 Livy)

db-proxy 内集成**常驻 client 模式 SparkSession**(懒加载,首次 `/spark/query` 才创建),
SQL 与 PySpark 共用同一 session,临时视图跨请求保留;`threading.Lock` 串行执行。

### 配置(datasources.json 顶层 `spark` 段,缺省 = 引擎禁用)

```json
"spark": {
  "enabled": true,
  "master": "yarn",
  "deployMode": "client",
  "appName": "db-proxy-spark",
  "driverMemory": "4g",
  "executorMemory": "8g",
  "executorCores": 2,
  "maxExecutors": 15,
  "minExecutors": 1,
  "queue": "default",
  "hiveMetastoreUris": "thrift://hadoop-nn-1.bigdata.shiqiao.com:9083",
  "defaultLimit": 1000,
  "maxLimit": 10000,
  "maxSqlLen": 65536,
  "logDir": "spark-logs"
}
```

**特性**
- SQL 写语句(**INSERT/CREATE/DROP/ALTER/TRUNCATE/MSCK 等**):引擎不再校验
  `allowWrite`/`writeUnlocked`,直接放行——写权限由门户网关 `/api/spark` 管控
- PySpark 代码:信任模式(执行于 `{spark, sc}` 命名空间),结果赋给 `result`
  变量(DataFrame/dict 列表)即返回表格;完整审计日志
- 日志透传:log4j 重定向 `spark-logs/spark-jvm.log`,审计 `spark-logs/spark-audit.log`;
  `GET /spark/logs?offset=N` 增量读取

**依赖**:Python 3.8+ `pyspark`(版本与集群匹配,如 `pyspark==3.4.2`);
运行机器可提交 YARN(client 模式,需 HADOOP_CONF_DIR)并直连 Hive Metastore。
Session 创建 30~90s,首个请求等待,之后复用。

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
  "maxLimit": 10000,
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