# db-proxy:数据库只读 HTTP 代理(客户机侧)

在**可直连数据库的客户机**上运行,把数据库查询能力以 HTTP API 暴露给平台。
平台服务器无需直连数据库,也永远不接触数据库密码。
**支持 MySQL 与 Oracle 多数据源**(一个服务连多套库,按 `db` 参数路由)。

**所有配置集中在一个文件 `datasources.json`**,代码写死路径,无需其他配置。

## 架构

```
[平台服务器] --HTTP--> [客户机(本服务)] --MySQL/Oracle--> [数据库们]
  /api/db/*            :8756                     (客户机可直连)
```

## 环境要求

- Python 3.7+(老旧机器可用 3.7.6)
- 客户机能直连目标数据库

## 安装

```bash
cd services/db-proxy
python3.7 -m pip install -r requirements.txt
```

## 配置(只需 datasources.json)

复制 `datasources.json.example` 为 `datasources.json`,填写真实配置:

```json
{
  "authToken": "你的访问token",                    // 请求鉴权(X-DB-Token),留空=不鉴权
  "listenHost": "0.0.0.0",
  "listenPort": 8756,
  "defaultLimit": 100,                            // 无限制子句时默认行数
  "maxLimit": 10000,                              // 行数硬上限
  "queryTimeout": 60,
  "connectTimeout": 5,
  "allowedDbs": ["credzy", "credzx", "finance_order_trade"],  // 库白名单
  "allowedTables": [],                            // 表白名单(可选)
  "oracleClientLib": "/usr/lib/oracle/19.19/client64/lib",  // Oracle 客户端库目录(连 11g 必配)
  "datasources": [
    { "name": "credzy", "type": "oracle", "host": "...", "port": 1521,
      "user": "...", "password": "...", "service": "credzy", "rowLimit": "rownum" },
    { "name": "finance_order_trade", "type": "mysql", "host": "...", "port": 3343,
      "user": "...", "password": "...", "schema": "finance_order_trade" }
  ]
}
```

数据源字段:
- `name` = 前端请求的 `db` 参数
- `type`: `mysql` / `oracle`
- Oracle 用 `service`(服务名);MySQL 用 `schema`(库名)
- `rowLimit`(可选,Oracle 用):`fetch`(默认,12c+)/ `rownum`(11g);MySQL 无需配
- 数据库密码**只存在客户机**,平台不接触

## 启动

```bash
python3.7 main.py
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/health` | 探活 |
| GET  | `/dbs`    | 列出可用数据源(白名单过滤) |
| POST | `/query`  | 执行只读查询,body `{db, sql}`(db=数据源 name) |
| GET  | `/acl`    | 回显配置(脱敏,排查) |
| GET  | `/scripts/tree` | ~~我的目录~~(已迁移到平台 `/api/scripts`,此处保留兼容) |
| POST | `/scripts/new`  | ~~新建目录/文件~~(已迁移平台,保留兼容) |
| POST | `/scripts/rename`| ~~重命名~~(已迁移平台,保留兼容) |
| POST | `/scripts/delete`| ~~删除~~(已迁移平台,保留兼容) |
| POST | `/scripts/save`  | ~~保存 SQL~~(已迁移平台,保留兼容) |
| GET  | `/scripts/get`  | ~~读取 SQL~~(已迁移平台,保留兼容) |
| GET  | `/tables` | 表目录:某库的表列表,`?db=`(MySQL `SHOW TABLES`/Oracle `user_tables`) |
| GET  | `/fields` | 表目录:某表的字段列表,`?db=&table=`(MySQL `DESC`/Oracle `user_tab_columns`) |

鉴权:配置了 `authToken` 后,请求需带请求头 `X-DB-Token: <token>`。

> 脚本存储已迁移到**平台网关** `/api/scripts`(存平台 `data/scripts/`,docker 挂载 `./data:/app/data` 持久化);
> db-proxy 的 `/scripts/*` 接口保留仅为兼容旧版,前端不再调用。

## 安全约束

1. **鉴权**:配置了 `authToken` 后,请求需带请求头 `X-DB-Token: <token>`(网关自动注入);未配 = 无鉴权(仅内网可信环境)
2. **权限收口到门户**:读写权限已移除(db-proxy 不再有 writableTables/只读判定/过程白名单),由**门户网关统一管控**——mysql/oracle/spark/flink 写操作需门户密码解锁(`X-Spark-Token`,与 Spark 同一密码);db-proxy 仅保留资源护栏
3. **库白名单**:请求的 `db` 必须在 `allowedDbs`(且是已配置数据源)
4. **表白名单(可选)**:`allowedTables` 开启后从 SQL 提取表名校验
5. **多语句防护**:拒绝分号分隔的多语句(`SELECT 1; DELETE ...` 403),末尾结尾分号允许(过程 BEGIN...END 块除外)
6. **强制行数上限**:无限制子句自动加(MySQL `LIMIT` / Oracle 12c+ `FETCH FIRST` / Oracle 11g `ROWNUM`),硬上限 `maxLimit`
7. **SQL 长度上限**:超过 `maxSqlLen`(默认 32768 字节)拒绝,防超大 SQL
8. **超时**:连接/查询超时可配,防远端卡死
9. **审计**:每次查询打日志(时间/库/SQL/行数/耗时)

> ⚠️ 权限收口后,`8756` 端口的写能力依赖门户网关保护。**务必配置 `authToken`**,避免网络内其他人直连绕过门户执行任意 SQL。

## Oracle 11g 说明

- **必须配 `oracleClientLib`** 指向客户端库目录(含 `libclntsh.so`),走 thick 模式
  (thin 模式不支持 11g)
- **必须配 `rowLimit: "rownum"`**(11g 无 `FETCH FIRST` 语法,用 ROWNUM 包装)

## 平台接入

平台网关 `server/config.js` 配置 `dbProxyUrl`(如 `http://10.25.15.106:8756`),
网关 `/api/db/*` 会代理到该地址。平台服务器 `server/config.local.json` 加:

```json
"dbProxyUrl": "http://10.25.15.106:8756",
"dbProxyToken": "与客户机 datasources.json 的 authToken 一致"
```

> 提示:客户机防火墙需放行 8756 端口,并确认平台服务器能访问
> `10.25.15.106:8756`(可用 `curl http://10.25.15.106:8756/health` 验证)。

## Spark 引擎(自建网关,替代 Livy)

db-proxy 内集成一个**常驻 client 模式 SparkSession**(自建 Spark 网关,放弃 Livy),
SQL 与 PySpark 代码共用同一 session,支持临时视图跨请求保留。

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
  "allowWrite": false,
  "logDir": "spark-logs",
  "sparkConf": {}
}
```

### 特性

- **懒加载**:首次 `/spark/query` 才创建 SparkSession;未配 spark 或未装 pyspark 不影响
  MySQL/Oracle 查询(db-proxy 启动即用)。
- **串行执行**:同一时刻只跑一个请求(threading.Lock),避免 SparkSession 并发串扰。
- **SQL 写限制**:只读关键字(`SELECT/SHOW/DESC/EXPLAIN/SET/USE`)放行;写语句
  (INSERT/CREATE/DROP/ALTER/TRUNCATE/MSCK 等)需 `allowWrite: true` 且请求带
  `writeUnlocked: true`(由门户网关在 X-Spark-Token 校验通过后置位)。
- **PySpark 代码**:信任模式(执行于 `{spark, sc}` 命名空间),完整审计日志;
  代码里把结果赋给 `result` 变量(DataFrame 或 dict 列表)即返回表格,
  否则返回 `print()` 捕获的 stdout。
- **日志透传**:log4j 重定向到 `spark-logs/spark-jvm.log`(driver JVM 日志),
  Python 侧审计写 `spark-logs/spark-audit.log`;`GET /spark/logs?offset=N` 增量读取,
  门户前端查询页自动轮询展示。

### 依赖

- Python 3.8+ 且安装 `pyspark`(版本与目标集群 Spark 匹配,如 `pyspark==3.4.2`)。
- 运行机器需可提交 YARN(spark-submit 客户端、HADOOP_CONF_DIR)并直连 Hive Metastore
  (thrift://hadoop-nn-1:9083)。
- SparkSession 创建耗时较长(30~90s),首个请求会等待;之后复用常驻 session。

### 接口

| 端点 | 说明 |
|---|---|
| `POST /spark/query` | body `{kind: "sql"\|"pyspark", sql/code, writeUnlocked, timeoutMs}` |
| `GET /spark/logs?offset=N` | 增量读取 driver 日志 |
| `GET /spark/status` | session 状态 / appId / 配置快照 |

## Flink 引擎(双通道:交互式 + PreJob)

db-proxy 内嵌 PyFlink 1.17.2,**双通道架构**:

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
  "allowWrite": true,
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

### 交互式通道接口

| 端点 | 说明 |
|---|---|
| `POST /flink/query` | body `{sql, limit?, mode: batch\|stream, timeoutMs}`;脚本式多语句,最后一条查询结果返回 |
| `POST /flink/cancel` | 取消当前正在执行的查询(超时/手动) |
| `GET /flink/status` | session 状态 / yarnAppId / allowWrite |
| `GET /flink/connectors` | 连接器注册表(前端 DDL 生成用) |
| `POST /flink/ddl/generate` | 按连接器模板生成建表 DDL |
| `GET /flink/jobs` | 交互引擎内提交的流式任务列表(内存态) |
| `POST /flink/jobs/{id}/stop` | 停止交互引擎的流式任务 |

### PreJob 通道接口(独立作业)

| 端点 | 说明 |
|---|---|
| `POST /flink/prejob/jobs` | body `{name, sql, queue?}`;SQL 包装成 pyflink 脚本,`yarn-per-job` 提交,返回 `{jobId, appId}` |
| `GET /flink/prejob/jobs` | 作业列表(状态经 YARN REST 刷新,持久化到 `flink-prejobs/prejobs.json`) |
| `GET /flink/prejob/jobs/{id}` | 作业详情(状态/队列/trackingUrl/错误诊断) |
| `GET /flink/prejob/jobs/{id}/logs` | 尾部日志(`yarn logs -applicationId`) |
| `POST /flink/prejob/jobs/{id}/cancel` | 停止作业(`yarn application -kill`) |
| `GET /flink/prejob/config` | prejob 配置快照(无敏感信息) |

> PreJob 生成脚本是纯 SQL(无 Python UDF)时 executor 不需要 python 环境,
> yarn-per-job 的 JobGraph 全 Java;提交脚本落在 `flink-prejobs/main_<jobId>.py`,
> 本地持久化,不对外暴露。
