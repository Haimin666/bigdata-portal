# Spark / Flink 网关与写操作防线

> 模块定位:门户侧的 Spark/Flink 执行通道——网关(`server/`)只做**鉴权与转发**,
> 真正执行在 db-proxy(常驻 SparkSession / Flink 引擎)。写防线是本模块的核心资产。

## 1. 文件清单

| 层 | 文件 | 职责 |
|---|---|---|
| 网关 | `server/spark-gateway.js` | `/spark/*` db-proxy 客户端:query/submitJob/jobStatus/cancel/readLogs/status/setExecutors/stages/cancel |
| 网关 | `server/flink-gateway.js` | `/flink/*` db-proxy 客户端:query/cancel/status/connectors/probe/ddl/jobs/async/prejob 全家桶 |
| 路由 | `server/routes/db.js`(拆解后;原 `server/index.js`) | `/api/spark/*`、`/api/flink/*` HTTP 路由 + 写拦截 + token 签发校验 |
| 服务 | `services/db-proxy/spark_engine.py` | 常驻 client 模式 SparkSession(YARN),串行锁,120s 超时自动 cancelJobGroup |
| 服务 | `services/db-proxy/flink_engine.py` / `flink_prejob.py` / `flink_connectors.py` | Flink 流/批交互引擎 / PreJob(yarn-per-job)/ 连接器元数据 |

## 2. 写操作防线(三层)

1. **网关写检测**:`isSparkWriteSql`(去注释 → 拒多语句 → 防 `/*!` 走私 → `SET GLOBAL` 视为写);
   命中写语句则要求请求头 `X-Spark-Token`
2. **token 体系**:用户在 `/api/spark/auth` 用 `sparkWritePassword` 换 12h token;
   **token 绑定签发用户**(HMAC 携 username),校验时必须匹配当前会话用户,跨用户复用立即删除失效(防 XSS 窃取)
3. **db-proxy 第二道防线**:解锁请求带 `writeUnlocked:true` + 共享密钥头 `X-Spark-Write`;
   db-proxy 侧 `allowWrite` 校验该密钥,直连 8756 无法伪造

未配置 `sparkWritePassword` → 一切写操作禁止(默认只读)。

## 3. Spark 通道(`/api/spark/*`,登录保护)

| 路径 | 说明 |
|---|---|
| `POST /auth` | 写密码换 token(12h,绑定用户) |
| `POST /query` | 同步执行 SQL/pyspark(前端统一 120s) |
| `POST /jobs` + `GET /jobs/:jobId` + `POST /jobs/:jobId/cancel` | 异步任务(公司网关 60s 读超时规避):秒级提交/轮询/取消 |
| `GET /logs?jvm=&audit=` | driver 日志+审计增量透传 |
| `GET /status` | session state/appId/配置快照 |
| `POST /config` | 设置 executor 数(0=动态) |
| `GET /stages` | 活跃 job/stage 进度(日志面板进度条) |
| `POST /cancel` | 取消当前查询(jobGroup 可取消) |

## 4. Flink 通道(`/api/flink/*`,登录保护)

| 路径 | 说明 |
|---|---|
| `POST /query` | 交互引擎(batch/stream 双模式,共享常驻会话) |
| `POST /async` + status/cancel | 流式 SELECT/大结果异步通道(防 504) |
| `POST /cancel`、`GET /status` | 停止当前查询 / 引擎状态(yarnAppId/allowWrite) |
| `GET /connectors`、`POST /connectors/:name/probe`、`POST /ddl/generate` | 连接器元数据/表探测/DDL 生成(只读) |
| `GET /jobs`、`GET /jobs/:id`、`POST /jobs/:id/stop` | 交互引擎内存态流任务管理 |
| `POST/GET /prejob/jobs`(+`:id`/logs/cancel)、`GET /prejob/config` | PreJob 提交(yarn-per-job,真实占集群资源,**强制 token**) |

## 5. 边界与注意事项

- **db-proxy 透传黑名单**:`/api/db/*` 透传里拦 `/spark/`、`/flink/`、`/query`、`/scripts/`、`/jobs`(含子路径),
  防止绕过网关鉴权直透——修改黑名单必须同步评估三条防线是否仍然完整
- Spark UI 的 SQL/时间线/日志无 REST,只能跳原生页或 iframe(见 ARCHITECTURE 技术债)
- Flink 1.13(StreamX 旧作业)与 1.17 并存,`/jobs/:jid` 结构差异由前端兼容
- 引擎超时口径:**Spark 前端/门户/db-proxy 统一 120s**;Flink 交互 `queryTimeout`(默认 300s);异步默认 10min
- 验证纪律:涉及集群的操作用假 id(如 `jobId=999999999`),不触发真实任务
