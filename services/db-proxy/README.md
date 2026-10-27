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
> 谁就能通过 Spark Thrift 执行 SQL。防护依赖两点:
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
  "spark": { "enabled": false, "exportPath": "hdfs:///tmp/db-proxy-spark-exports" }, // Spark CSV 导出根目录
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
- SparkSQL 工作台「导出到 HDFS」把单条只读 `SELECT/WITH` 的完整结果写成带表头 CSV 目录;默认根目录 `hdfs:///tmp/db-proxy-spark-exports`,可用 `spark.exportPath` 覆盖。结果按唯一任务目录保存,不收集到 driver;导出失败不返回路径。此配置由 db-proxy 启动时加载,修改后重启生效。

## 启动

```bash
python3 main.py        # 依赖 requirements.txt;Flink 需 pyflink;Spark Thrift 需本机 SPARK_HOME/bin/beeline
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
- Spark SQL 无显式 `LIMIT` 时默认最多返回 1,000 行;SQL 显式限制最高为 500,000 行。Spark 结果通过 `limit+1` 有界收集并标记截断,不先统计完整结果或自动导出 HDFS。

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
| POST | `/spark/query` | Spark SQL 执行 |
| GET | `/spark/schema/databases` | Spark 库列表(SHOW DATABASES;TTL 缓存 5 分钟) |
| GET | `/spark/schema/tables?db=` | Spark 库下表列表(SHOW TABLES IN) |
| GET | `/spark/schema/fields?db=&table=` | Spark 表字段列表(DESC,含类型/注释) |
| GET  | `/spark/status` `/spark/logs` | Thrift 连接状态 / Beeline 执行日志 |
| POST | `/spark/jobs` + `GET/POST /spark/jobs/{id}[/cancel]` | Spark 异步 |
| POST | `/flink/query` `/flink/async` (+`/{id}[/cancel]`) | Flink 交互式(批/流) |
| GET  | `/flink/status` `/flink/connectors` `/flink/jobs` | 状态/连接器/流式任务 |
| POST | `/flink/ddl/generate` | 按连接器模板生成建表 DDL |
| POST | `/flink/prejob/jobs` (+`GET /{id}` `/logs` `/cancel` `/disable` `/enable` `PUT /{id}`) | PreJob 独立作业 |
| GET  | `/flink/prejob/config` | PreJob 配置快照 |
| GET/POST | `/scripts/*` | 已迁移平台的旧脚本接口,保留兼容 |

## Spark Thrift 查询

db-proxy 不再在本地创建 SparkSession，而是在部署主机上启动 Beeline 子进程连接 Spark Thrift Server。默认配置对应的命令为：

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

`beelinePath` 留空时使用 `$SPARK_HOME/bin/beeline`；db-proxy 与 Spark Thrift Server 同机且共享网络命名空间时通过回环地址访问。若 db-proxy 在 Docker 容器中，容器内的 `127.0.0.1` 指向容器本身，需把 `jdbcUrl` 配成容器可达的宿主机地址。查询和元数据都通过 HiveServer2 执行；取消会终止当前 Beeline 子进程，日志显示 stderr 进度与诊断信息，结果 CSV 单独解析后返回。HDFS 导出使用 `INSERT OVERWRITE DIRECTORY ... USING CSV` 并仅返回目录路径。此改造不再支持 PySpark、Executor 数量控制或 SparkContext Stage 进度。更新配置后重启 db-proxy。

普通 `SELECT/WITH` 查询在 SQL 执行前补上默认 `LIMIT`，已有顶层 `LIMIT` 不超过 `maxLimit`；`SHOW`、`DESC`、`EXPLAIN` 不改写。通过 `/spark/query` 或 `/spark/jobs` 提交 PySpark payload 会返回 HTTP 400。

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
