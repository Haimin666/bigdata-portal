# 模块:数据库查询(db-query)

## 1. 职责

统一 SQL 工作台:MySQL / Oracle / Doris / **SparkSQL** / **FlinkSQL** 查询、编辑器(CodeMirror 5)、结果多 tab、脚本文件树、Flink 流任务/PreJob 管理。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/views/db/QueryView.vue` | 主工作台:引擎/数据源下拉、CodeMirror 编辑器、快捷键(Ctrl+Enter 执行/Ctrl+Shift+F 格式化)、结果多 tab、执行历史、日志面板、解锁 |
| 视图 | `src/views/db/SqlTreePanel.vue` | 脚本文件树(本地 scripts 存储,右键新建/重命名/删除) |
| 视图 | `src/views/db/FlinkConnectorDialog.vue` | Flink 连接器:批量建表/DDL 生成/表探测 |
| 视图 | `src/views/db/FlinkJobsDialog.vue` / `FlinkPreJobDialog.vue` | Flink 流任务列表/停止;PreJob 提交(yarn-per-job)/状态/日志/取消 |
| API | `src/api/db.ts` | queryDb / querySpark / queryFlink / sparkAuth / cancelSpark / 日志轮询 / 脚本 CRUD |
| 网关 | `server/index.js` | `/api/db*` 透传、`/api/dbquery/query`(X-Spark-Token)、`/api/spark/*`(spark-gateway)、`/api/flink/*`(flink-gateway)、`/api/scripts` |
| 服务 | `services/db-proxy/main.py` | `/query`(MySQL/Oracle/Doris)、`/spark/query`、`/flink/query`、`/dbs`、`/acl`、护栏(限流/并发) |
| 服务 | `services/db-proxy/spark_engine.py` | 常驻 SparkSession 执行 |
| 服务 | `services/db-proxy/flink_engine.py` / `flink_prejob.py` / `flink_connectors.py` | Flink 三通道 |

## 3. 引擎矩阵

| 引擎 | 通道 | 写权限 | 超时 | 备注 |
|---|---|---|---|---|
| mysql/oracle/doris | db-proxy `/query` | 需写解锁(网关校验 + db-proxy 只读白名单) | db-proxy `queryTimeout` | 直连 |
| sparksql | db-proxy `/spark/query`(常驻 client session) | 需 `X-Spark-Token`(isSparkWriteSql 检测) | **前端/门户/db-proxy 统一 120s**,超时自动 cancelJobGroup | 串行锁;FileNotFound 自动 REFRESH 重试一次 |
| pyspark | 同上 `kind=pyspark` | 必须解锁 | 同上 | 前端已移除入口,后端保留给 Jupyter |
| flinksql | db-proxy `/flink/query` | 必须解锁(所有 flink 任务) | `queryTimeout`(默认 300s) | 流/批双模式;流查询 collect 到 limit 行返回 |

## 4. 核心机制

- **批执行互斥**:一次点击一个批次,批内 FIFO 串行(`execSegments`);执行中再点被拒;`batchCancelled` 停止按钮中断批 + `cancelSpark/cancelFlink` 取消当前引擎 job
- **多结果 tab**:`results[]` 数组,每段 SQL 一个 tab,默认展示最后一个;竖排结果 tab
- **Spark 日志透传**:执行时 3s 轮询 `/api/spark/logs` 增量展示 driver 日志,结束即停
- **解锁体系**:写 SQL 时若未解锁,弹密码框(`/api/spark/auth` 校验 `sparkWritePassword`,签发 12h token,存 sessionStorage)
- **编辑器**:CodeMirror 5,自实现括号补全/Tab 缩进/Shift+Tab,主题跟随全局
- **脚本树**:`data/scripts` 本地存储,文件 = 脚本(不入库)

## 5. 数据源

`db-proxy/datasources.json`(启动加载,改后重启):
- `allowedDbs`:可用库列表(引擎按 db 段配置)
- 库别名:oracle 连接串可配置别名,未配置显示库名
- `readOnly: true` 的数据源强制只读

## 6. 已知限制

- db-proxy Oracle thin 模式对旧版本(11g)支持受限(需 thick 模式)
- Spark 首次建 session 需 30~90s(懒加载);session 常驻,跨语句保留临时视图
- Flink 引擎依赖 SQL Gateway / yarn-session(`datasources.json` flink 段)
