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
              ├─ 资源护栏: 行数上限 / maxSqlLen / maxConcurrent / maxQps / 超时
              ├─ 执行: MySQL(Doris)/Oracle/Impala / Spark / Flink / prejob
              └─ 审计日志(时间/库/SQL/行数/耗时)
```

> ⚠️ **安全边界**:除显式配置 `readOnly: true` 的 Impala 数据源外,db-proxy 对 `8756` 端口零读写限制——谁能持 `X-DB-Token`
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
  "defaultLimit": 1000,                           // 无限制子句时默认行数
  "maxLimit": 500000,                             // 行数硬上限
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
      "user": "...", "password": "...", "schema": "default" },
    { "name": "impala_warehouse", "type": "impala", "hosts": ["host1", "host2"],
      "port": 21050, "user": "...", "password": "...", "database": "default", "readOnly": true }
  ],
  "impala": {
    "typeCheck": { "enabled": true },
    "aiFix": { "enabled": false, "baseUrl": "https://.../v1", "apiKey": "...", "model": "...", "maxAttempts": 2 }
  },
  "spark": { "enabled": false },                  // 见「Spark 引擎」
  "flink": { "enabled": false }                   // 见「Flink 引擎」
}
```

- `type` 支持 `mysql`(含 Doris,走 mysql 协议)、`oracle` 与 `impala`
- Impala 可配置多个 `hosts`,端口默认 `21050`;`typeCheck` 开启 sqlglot/Hive 方言校验和 DESCRIBE 驱动的类型修正
- `impala.aiFix` 为可选 OpenAI-compatible 接口配置,密钥只放在客户机 `datasources.json`;仅语法/类型/表列名错误触发,修复 SQL 会重新校验为单条只读查询
- Impala `readOnly: true` 会在 db-proxy 再次拒绝写语句;不配置时门户权限矩阵仍是用户侧主要读写授权点
- oracle 连 11g 必须 `rowLimit: "rownum"` + `oracleClientLib`
- `maxConcurrent/maxQps`、`maxSqlLen`(默认 32KB)在顶层配置
- `allowWrite`/`writeToken`(spark/flink 段)已废弃,不再生效

## 启动

```bash
python3 main.py        # 依赖 requirements.txt;spark 需 pyspark,flink 需 pyflink
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
- 前端画布 SQL 保持不变;db-proxy 只在发送到数据库前对无显式行数限制的 `SELECT` / `WITH` 隐式添加引擎对应的上限。
- MySQL/Doris/Impala 使用 `LIMIT n`,Oracle 12c+ 使用 `FETCH FIRST n ROWS ONLY`,Oracle 11g 使用 `ROWNUM` 包装;Spark SELECT/WITH 使用执行计划限行。
- `SHOW`/`DESC`/`DESCRIBE`/`EXPLAIN` 不追加 SQL 后缀,使用 cursor/Spark 有界迭代读取结果,避免特殊命令被改写后语法错误。
- 默认返回上限为 1000 行;各引擎硬上限为 500,000 行。用户 SQL 自带行数限制时沿用;超过硬上限直接 400(Spark/Flink 按硬上限截取)。达到默认或用户上限时通过 `truncated` 标记告知前端。
- Spark SQL 查询和 PySpark 返回的 DataFrame 先统计执行结果;超过 500,000 行时写为 CSV 分片目录到 HDFS `/tmp/db-query-exports/<日期>/<UUID>/`,返回 `hdfsPath` 且不回传结果行。Spark SQL 无显式 `LIMIT` 且未超限时仍按默认 1000 行收集。

## 保留的资源护栏(非权限)

| 护栏 | 行为 |
|---|---|
| `X-DB-Token` 鉴权 | 与 `authToken` 不符 → 401(配置空 = 不鉴权,不推荐) |
| 行数上限 | 默认 1000 行;硬上限 `maxLimit`(默认 500000) |
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
  "sparkHome": "/opt/spark/spark4/spark4.2",
  "driverMemory": "4g",
  "executorMemory": "8g",
  "executorCores": 4,
  "executorInstances": 4,
  "queue": "default",
  "hiveMetastoreUris": "thrift://hadoop-nn-1.bigdata.shiqiao.com:9083",
  "sparkConf": {
    "spark.archives": "hdfs:///spark4/resources/jdk17.zip#jdk,hdfs:///spark4/resources/py312.zip#py3",
    "spark.yarn.appMasterEnv.JAVA_HOME": "./jdk",
    "spark.executorEnv.JAVA_HOME": "./jdk",
    "spark.yarn.appMasterEnv.PYSPARK_PYTHON": "./py3/bin/python",
    "spark.executorEnv.PYSPARK_PYTHON": "./py3/bin/python",
    "spark.pyspark.python": "./py3/bin/python",
    "spark.hadoop.io.compression.codecs": "org.apache.hadoop.io.compress.DefaultCodec,org.apache.hadoop.io.compress.GzipCodec,org.apache.hadoop.io.compress.BZip2Codec,org.apache.hadoop.io.compress.SnappyCodec,org.apache.hadoop.io.compress.Lz4Codec,org.apache.hadoop.io.compress.ZStandardCodec",
    "spark.hadoop.io.compression.codec.lzo.class": ""
  },
  "defaultLimit": 1000,
  "maxLimit": 500000,
  "maxSqlLen": 65536,
  "logDir": "spark-logs"
}
```

`spark.hadoop.io.compression.codecs` 显式列出 Spark classpath 中可用的 Hadoop codec并排除缺失的 LZO codec；同时将 `spark.hadoop.io.compression.codec.lzo.class` 设为空字符串。调整后重启 db-proxy 使常驻 SparkSession 重新创建。

工作台 `/api/spark/config` 支持任意非负整数 executor 数量：`0` 表示动态分配，正整数表示固定数量；设置后当前 session 停止，并在下一次查询时按新数量重建。

**特性**
- SQL 写语句(**INSERT/CREATE/DROP/ALTER/TRUNCATE/MSCK 等**):引擎不再校验
  `allowWrite`/`writeUnlocked`,直接放行——写权限由门户网关 `/api/spark` 管控
- PySpark 代码:信任模式(执行于 `{spark, sc}` 命名空间),结果赋给 `result`
  变量(DataFrame/dict 列表)即返回表格;完整审计日志
- 日志透传:log4j 重定向 `spark-logs/spark-jvm.log`,审计 `spark-logs/spark-audit.log`;
  `GET /spark/logs?offset=N` 增量读取

**依赖**:Spark 4.2 要求 Python 3.10+、Java 17+；当前部署使用 Python 3.12，
并确保 Spark 安装目录中的 PySpark 与 Spark 版本匹配。client 模式的 driver 在 db-proxy
进程内运行，因此服务本身必须由 Python 3.12 启动；YARN executors 使用 HDFS archives
中的 Python 环境。引擎会将 `$SPARK_HOME/python/lib/*.zip` 加入进程 `sys.path` 和
`PYTHONPATH`，无需在启动脚本里手工设置。运行机器需可提交 YARN(需 `HADOOP_CONF_DIR`)并直连 Hive Metastore。
Session 创建 30~90s,首个请求等待,之后复用。

启动 db-proxy 的服务环境设置如下；服务进程本身由 Python 3.12 启动。YARN 侧的
JDK/Python 通过 `spark.archives` 分发；归档解压后的路径应与 `spark.pyspark.python`
等配置一致。

```bash
export SPARK_HOME=/opt/spark/spark4/spark4.2
export JAVA_HOME=/opt/spark/spark4/jdk17
export PYSPARK_PYTHON=/opt/spark/spark4/py312/bin/python3.12
export PYSPARK_DRIVER_PYTHON=/opt/spark/spark4/py312/bin/python3.12
unset PYTHONPATH
cd /path/to/services/db-proxy
exec /opt/spark/spark4/py312/bin/python3.12 -m uvicorn main:app --host 0.0.0.0 --port 8756
```

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
