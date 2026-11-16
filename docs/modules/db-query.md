# 模块:数据库查询(db-query)

## 1. 职责

统一 SQL 工作台:MySQL / Oracle / Doris / **Impala** / **SparkSQL** / **SparkSession** / **FlinkSQL** 查询、编辑器(Monaco)、结果多 tab、脚本文件树、Flink 流任务/PreJob 管理。

## 1.1 视觉与交互契约

- 查询工作台采用 Soybean 风格的低对比度分层:页面背景、面板、次级面板和边框统一使用门户主题 token(`--bd-*`),浅色/深色主题均保持足够文字对比度;不在模块内引入独立颜色体系。
- 顶部工具条按「数据源上下文 / 编辑器 / 执行与诊断 / 视图」分组,通过紧凑间距、分隔线、Tooltip 和明确的 loading/disabled 状态表达操作上下文;现有按钮、快捷键和弹窗入口不减少。
- 脚本 Tab、结果 Tab、左侧目录 Tab 使用同一套 active/hover/focus 反馈;结果表格、日志、脚本树和历史列表继续在各自容器内滚动,查询页面根节点不产生整页滚动。
- 查询日志与结果区始终受工作台固定高度约束;引擎日志仅在日志面板内部滚动,不得撑开查询页或遮挡底部状态栏。
- Oracle `BEGIN/DECLARE` 匿名 PL/SQL 块和 `CREATE ... PROCEDURE/FUNCTION/PACKAGE/TRIGGER` 按一个执行单元提交,保留块内及结尾分号;兼容 SQL*Plus 独立 `/` 结束行(提交前移除);不影响普通 SQL 按分号批执行。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/views/db/QueryView.vue` | 主工作台:PageHeader + 引擎/数据源下拉、Monaco 编辑器(SqlEditor 封装)、快捷键(Ctrl+Enter 执行/Ctrl+Shift+F 格式化)、结果多 tab、执行历史、日志面板;支持双击表目录表节点生成预览查询自动执行;结果表**双击单元格行内编辑**(仅带主键的单表预览)生成 UPDATE 写前确认;工具栏 **EXPLAIN** 打开执行计划树;编辑器 **schema 驱动补全**(Ctrl+Space);格式化走 **sql-formatter**(方言 mysql/oracle/spark,${var} 占位保护,失败降级自研) |
| 视图 | `src/views/db/QueryResults.vue` | 查询结果面板(2026-09 从 QueryView 拆出):结果 tab 栏(日志 tab 内容经 slot 注入)+ 分页表格 + 单元格行内编辑(提交走 queryDb + emit rerun 重查)+ 复制(单元格/本页/整表 TSV)+ CSV 导出;结果 tab 右键菜单支持关闭当前、关闭左侧、关闭右侧、关闭其他;props: results/activePane/db/loading |
| 视图 | `src/views/db/SqlEditor.vue` | Monaco 编辑器封装(2026-08 替代 CodeMirror):**model 池**(每 tab 一个 ITextModel,独立撤销/光标)、补全 provider(关键字+**内置函数**+**SQL snippet**+schema 表/列点语法+文中词/字符串值行级增量索引——打字只重建光标行 O(行内容),Enter/粘贴/删除才整表重建;输入变更按 SQL 光标上下文显式触发自动提示(80ms 防抖),本地候选不等网络;**当前编辑 Tab 内 SQL 字符串字面量**按前缀补全,不扫描注释、不跨 Tab/历史)、**关系库 schema 预取** db 就绪即拉缓存;Spark 仅显式库/表前缀按模式懒加载)、快捷键(Cmd+Enter/S/Cmd+Shift+F/Cmd+/、Ctrl+Tab 缩进、Shift+Tab 反缩进)、主题 portal-dark/light 与字号联动 |
| 工具 | `src/utils/monaco-setup.ts` | Monaco 环境:worker 注册(Vite `?worker` 内联 EditorWorker)、主题 definePortalThemes(portal-dark/light)、model URI 约定(`portal-sql://editor/<modelId>`,供补全 provider 归属判定) |
| 视图 | `src/views/db/SqlTreePanel.vue` | 脚本文件树(本地 scripts 存储,右键新建/重命名/删除) + 表目录(**引擎 → 库 → 表 → 字段**:mysql/oracle/impala 数据源分组展示 + Spark 组(经 `/spark/schema/*` 元数据,SHOW/DESC 只读+db-proxy 侧 5 分钟 TTL 缓存,Spark 状态与 Schema 请求随工作台 `executionMode` 路由),含表/字段注释,双击表预览,复制表名(Spark 带 db. 前缀)/建表语句) + **历史/收藏**(localStorage 持久化,点击回填编辑器执行) |
| 视图 | `src/views/db/FlinkConnectorDialog.vue` | Flink 连接器:批量建表/DDL 生成/表探测 |
| 视图 | `src/views/db/FlinkJobsDialog.vue` / `FlinkPreJobDialog.vue` | Flink 流任务列表/停止;PreJob 提交(yarn-per-job)/状态/日志/取消 |
| 工具 | `src/utils/db-query-cache.ts` | 历史/收藏/列宽的 localStorage 统一读写:单一上限、读-改-写合并、`storage` 事件同步、配额超限逐条降级、列宽键容量治理 |
| 网关工具 | `server/utils/sql-write-detect.js` / `timeout.js` / `upstream-error.js` / `job-ownership.js` | 引号感知的 SQL 掩码与表引用提取(fail-closed)、超时入参夹逼、上游错误状态/字段透传与脱敏、异步任务归属表 |
| API | `src/api/db.ts` | queryDb / querySpark / queryFlink / sparkAuth / cancelSpark / 日志轮询 / 脚本 CRUD;listTables/listFields(detail 参数返回表/字段注释)、getTableDDL、**getSchema(补全元数据)、explainSql(执行计划)** |
| 网关 | `server/routes/db.js` `/api/db*` 透传(不含 `/jobs`、`/query`、`/spark/*`、`/flink/*`,均走专用路由)、`server/routes/dbquery.js` `/api/dbquery/query`、`server/routes/spark.js` `/api/spark/*`、`server/routes/flink.js` `/api/flink/*`、`server/db-scripts.js` `/api/scripts` |
| 服务 | `services/db-proxy/main.py` | `/query`(MySQL/Oracle/Doris/Impala)、`/spark/query`、`/flink/query`、`/dbs`、`/acl`、护栏(限流/并发/SQL 长度/超时)、**异步 job 真实取消(`cancelMethod`)**;`/tables` `/fields`(detail=1 返回注释/可空/键)、`/ddl`(生成建表语句)、**`/schema`(全量表+字段扁平元数据,供补全)、`/explain`(MySQL EXPLAIN / Oracle EXPLAIN PLAN / Impala EXPLAIN)、写审计(audit/audit-db.log)** |
| 服务 | `services/db-proxy/sql_limits.py` | **行数限制的唯一实现点**:注释/字面量/作用域感知的掩码 + 默认 1000 行追加 + 显式上限压到 500000 硬上限(MySQL `LIMIT` / Oracle 12c+ `FETCH FIRST` / 11g `ROWNUM` 三种语法) |
| 服务 | `services/db-proxy/spark_thrift_engine.py` / `spark_session_engine.py` / `spark_engine.py` | Spark Thrift/Beeline 与历史 YARN client PySpark `SparkSession` SQL 适配器;共享任务管理与历史会话生命周期位于 `spark_engine.py` |
| 服务 | `services/db-proxy/flink_engine.py` / `flink_prejob.py` / `flink_connectors.py` | Flink 三通道 |

## 3. 引擎矩阵

| 引擎 | 通道 | 写权限 | 超时 | 备注 |
|---|---|---|---|---|
| mysql/oracle/doris | db-proxy `/query`(同步)/ `/jobs`(异步任务) | **写权限密码验证已移除**:库访问权由数据权限矩阵管控,数据源 `readOnly` 与 db-proxy 资源护栏兑底;写操作(UPDATE/INSERT/DELETE/DDL)记审计日志 | db-proxy `queryTimeout`;异步默认 1h 可配 | 直连;异步任务提交由网关专用路由处理(非透传),EXEC_GATES 拦 viewer |
| impala | db-proxy `/jobs`(异步任务),Impala HS2/21050 | 数据权限矩阵;数据源可设 `readOnly`;AI 修复仅对只读 SQL 启用 | 数据源 `queryTimeout`;异步默认 1h | impyla 直连;支持表/字段/DDL/schema/EXPLAIN 元数据、服务端 SQL 类型自动检查;可选服务端 AI 修复,每次尝试与诊断通过 job logs 回显,连接/认证/权限/超时错误不触发 AI |
| sparksql | db-proxy `/spark/*`;门户固定传 `executionMode=thrift` | 写语句沿用网关写拦截(isSparkWriteSql);**已移除独立解锁弹窗**,权限由数据权限矩阵管控 | 前端/门户/db-proxy 超时配置 | Beeline/HiveServer2 Spark Thrift;元数据、异步状态/取消、日志与 HDFS 导出走 Thrift;失败不自动切换 |
| sparksession | db-proxy `/spark/*`;门户固定传 `executionMode=session` | 与 SparkSQL 相同 | 前端/门户/db-proxy 超时配置 | 历史 YARN client PySpark `SparkSession`,不是 `spark-sql` shell;元数据、异步状态/取消、日志、Stage 状态与 HDFS 导出走 Session;失败不自动切换 |
| flinksql | db-proxy `/flink/query` | 同上(写权限同 spark 体系) | `queryTimeout`(默认 300s) | 流/批双模式;流查询 collect 到 limit 行返回 |
| flink prejob | db-proxy `/flink/prejob/jobs`(yarn-per-job) | **已移除解锁要求**:直接提交,写凭证由网关自动携带(db-proxy 侧共享密钥校验防直连) | `submitTimeout`(默认 120s) | pyflink 脚本封装;作业列表/日志/停止走 PREJOB 管理 |

## 4. 核心机制

- **Monaco 补全组件加载**:`editor.api` 仅提供基础编辑器 API；`monaco-setup.ts` 必须显式加载 `contrib/suggest/browser/suggestController`，注册补全弹窗、触发命令与 snippet 接受能力，否则 provider 有候选也无法显示提示。验证需覆盖浏览器实际打字自动弹出和 Tab 接受，不能仅依赖类型检查/构建。
- **文档词候选**:使用 `wordBasedSuggestions: 'off'` 禁用 Monaco 默认词源，保留 `suggest.showWords: true`，否则自定义 provider 的 `Text` 候选（例如已输入字段名）也会被隐藏。
- **快捷键与分段执行**:Ctrl/Cmd+F 打开画布内查找；Ctrl+Tab 显式执行缩进(单光标插入缩进空格，多行选择整行缩进)，Shift+Tab 反缩进；SQL 分段只过滤空白和纯注释，不丢弃注释之后的有效语句。
- **无感行数上限(2026-11 修订)**:前端画布 SQL 不变；MySQL/Oracle/Doris/Impala、SparkSQL、SparkSession、FlinkSQL 默认最多返回 **1000 行**,显式上限硬顶 **500,000 行**。db-proxy 的限行判定统一由 `services/db-proxy/sql_limits.py` 实现,并与 Spark 侧 `_apply_row_limit` 保持同一口径:
  - 判定作用域正确 —— 只有**顶层** `LIMIT`/`FETCH FIRST`/`ROWNUM` 才算显式上限；字符串字面量、注释、子查询/括号内的 `LIMIT` 一律忽略(掩码保持字符位置 1:1,不改写原 SQL 语义)。
  - 无顶层显式上限时,**仅** `SELECT`/`WITH` 在服务端追加默认限制,且追加内容独占新行(MySQL `\nLIMIT 1000`、Oracle 12c+ `\nFETCH FIRST 1000 ROWS ONLY`、11g 外层 `SELECT * FROM ( ... ) WHERE ROWNUM <= 1000`),避免被末尾 `--` 行注释吞掉。
  - 显式上限超过 500,000 时**压到硬上限**(不再返回 400),响应中 `truncated=true`;非常量上限表达式(绑定变量/函数)不改写,按硬上限有界读取。
  - `SHOW`/`DESC`/`EXPLAIN` 等特殊命令保持原文,仅通过有界结果读取防止超量返回。
  - 配置项 `defaultLimit`/`maxLimit` 只能在 `[1, 500000]` 内收紧,不能突破硬上限；产品默认值为 1000 / 500000。
- **真实取消(2026-11)**:异步 job 的「停止」不再只是关闭本地连接,而是在数据库侧终止正在执行的语句:
  - MySQL/Doris:`KILL QUERY <connection_id>`(用同账号短连接发送),随后关闭连接；
  - Oracle:优先 `Connection.cancel()`(OCI break),不可用时尝试 `ALTER SYSTEM KILL SESSION '<sid>,<serial#>' IMMEDIATE`,都失败才退化为关闭连接；
  - Impala:优先 HS2 `CancelOperation`(cursor `cancel_operation()`),否则关闭 operation,最后退化为关闭会话(HS2 CloseSession 会取消会话内查询)；
  - Spark:Thrift 杀掉 beeline 进程组(SIGTERM→SIGKILL),Session 用 `cancelJobGroup(interruptOnCancel=True)`。
  job 状态新增 `cancelMethod` 字段回显实际取消方式,并追加一条「已停止/停止中」日志；`cancel_requested` 置位后执行线程的异常统一归类为 `cancelled` 而非 `failed`。
- **元数据资源护栏与跨库搜索(2026-11 修订)**:
  - `/tables`、`/fields`、`/ddl`、`/schema`、`/explain` 共用 `_query_semaphore` 并发槽(`maxConcurrent`,默认 5),超额立即返回 HTTP 429,避免元数据/执行计划请求绕过查询连接上限；槽位在请求完整处理期间占用,包括查询、结果构造与连接释放。
  - `/search/tables` 使用独立请求闸(`maxConcurrentSearches`,默认 2),每轮扫描最多 48 个去重后的关系库实例,通过最多 `min(maxConcurrent,8)` 个 worker 有界并行,每个实际数据库连接仍须取得共享 `_query_semaphore` 槽。
  - 跨库搜索整体 deadline 默认 5 秒(`searchDeadlineSeconds`,允许 1–15 秒);单实例 connect timeout 默认 2 秒(`searchConnectTimeout`,至少 1 秒)。deadline 到达时取消尚未启动的 worker、汇总已完成的结果并记录 partial warning；有任何实例失败或超时的结果**不进入 30 秒缓存**。完整扫描成功(包含完整空结果)才缓存。API 成功响应仍保持 `{code:0,data:[...]}` 数组契约。
- **缓存与失效(2026-11)**:db-proxy 内三处缓存统一走 `TtlCache`(线程安全 + 容量上限 + 同 key 单飞,防惊群):
  - Spark 元数据 `SHOW DATABASES/TABLES/DESC`:TTL 300s、上限 256 条,key 带 `executionMode`；
  - 跨库表搜索:TTL 30s、上限 128 条,key 为关键词；**全部实例都失败时不写缓存**,避免把"连不上"固化成"没有表"；
  - Impala 表结构:落盘 `data/impala-schema-cache.json`,条目带时间戳,默认 24h 过期(可用 `impala.schemaCacheTtlSeconds` 调整),刷新表清单时**清理已删除表的残留结构**；保留"查询报 TableNotFound/ColumnNotFound/TypeMismatch 时强制刷新"的错误驱动路径。
  - MySQL/Oracle/Doris 的 `/schema`、`/tables`、`/fields`、`/ddl` **没有服务端缓存**(每次实连数据库),由前端"每数据源每会话只拉一次"承担复用。

- **Spark 查询结果限制与导出**:普通 Spark SQL 无显式 `LIMIT` 时在提交给 Thrift 前补默认 `LIMIT 1000`；顶层整数 `LIMIT` 超过 `maxLimit`(默认 500,000)时压到上限，`LIMIT ALL` 替换为上限，其他常量表达式包装 `LEAST(expr, maxLimit)`；只有 `OFFSET` 时默认 `LIMIT` 插在 `OFFSET` 前。扫描跳过字符串、引号标识符及 `--`/嵌套 `/* */` 注释；多条 SQL 在 db-proxy 拒绝。提交给 Beeline `-e` 前确保 SQL 有终止分号(无分号时另起一行追加，避免尾部 `--` 注释吞掉分号)。Beeline 失败诊断保留错误开头与结尾，避免长堆栈遮住 Spark 的解析原因和 SQL 上下文。结果从 Beeline CSV 输出解析并设置 `truncated`。工具栏「导出到 HDFS」接受单条只读 `SELECT/WITH`，通过 `INSERT OVERWRITE DIRECTORY ... USING CSV OPTIONS (header 'true')` 在 Spark Thrift 上执行，不将完整结果传回门户；异步执行、可取消，完成后返回 HDFS 路径。
- **Spark 网关提交**:`/api/spark/query` 与 `/api/spark/jobs` 均向 Spark 网关明确传递 `kind: 'sql'`;不能引用请求中未定义的局部类型变量，否则会在请求到达 db-proxy 前抛出 `ReferenceError`。
- **Spark 引擎接口**:工作台将 SparkSQL 与 SparkSession 作为两个独立引擎选项。SparkSQL 固定使用 `executionMode=thrift`，SparkSession 固定使用 `executionMode=session`；底层 API 仍共用 `/api/spark/*` 与 db-proxy `/spark/*`，覆盖查询、异步任务、状态/取消、日志/Stage、Schema 补全和 HDFS 导出。旧调用省略模式时兼容默认 `thrift`。两引擎保持相同门户访问/写权限检查和响应结构；失败后不自动切到另一引擎。SparkSession 是历史 YARN client PySpark `SparkSession`，工作台只执行 SQL，不提供 PySpark 代码执行。
- **Spark 编辑器补全**:库前缀表名与 `库.表.` 后的字段补全使用所选执行模式的 `/spark/schema/tables` 与 `/spark/schema/fields`;只在对应前缀上下文按需请求并按模式缓存,不预取整个 metastore。无匹配 Spark 前缀时仍使用本地关键字、函数和文中词候选,不请求关系库 `/schema`。

- **权限边界**:数据库查询模块的用户/角色/库权限只在门户网关执行;前端仅按网关下发结果展示并处理 403,db-proxy 不承担门户用户权限判断。
- **网关路径归一化(2026-11,安全)**:`/api/db/*` 上所有基于路径的判断统一走 `normalizedPath(req)`(`decodeURIComponent` 反复解码至稳定 → `\\` 归一 `/` → 小写;解码失败 400)。透传层从「黑名单」改为**显式白名单**(`GET acl/health/dbs/tables/fields/ddl/schema/search/tables`、`POST explain`、`GET jobs/:id`、`POST jobs/:id/cancel`),且要求归一化路径与原始路径一致 —— 百分号编码/双重编码/反斜杠变体一律 403。修复前 `/api/db/%73park/jobs`、`/%74ables?db=` 可绕过 Spark/Flink 写权限闸门与元数据权限中间件(Express 不解码、下游 uvicorn 会 unquote)。
- **写 SQL 检测(2026-11,安全)**:`server/utils/sql-write-detect.js` 的掩码改为**引号/注释感知**(单引号含 `''`/`\\'`、双引号、反引号、`--`、`#`、`/* */`);修复 `SELECT '--' INTO OUTFILE ...`、`SELECT '--', LOAD_FILE(...)` 被判为只读的绕过。`extractTables` 无法可靠识别表引用时返回 `null`,权限矩阵对「配了 tables 白名单」的规则 **fail-closed 403**(此前返回 `[]` 会直接跳过表级校验)。
- **异步任务归属(2026-11)**:网关维护 `jobId -> {owner, engine, expiresAt}` 内存表(TTL 2h/上限 5000,`server/utils/job-ownership.js`),`/api/db/jobs/:id`、`/api/spark/jobs/:id`、`/api/flink/async/:id`、`/api/flink/prejob/jobs/:id` 及其 cancel/stop/logs 均校验提交者;admin 放行,非本人/未知/过期一律 403。db-proxy 侧 jobId 同时改为随机 UUID(`dbj_<uuid hex>`),不再可预测。
- **上游错误透传(2026-11)**:网关不再把 db-proxy 的 400/403/429/5xx 折成 502,原样透传状态码并附带 `errorType`/`errorCode`/`logs`(detail 截断并脱敏密码/token/DSN);拿不到上游状态才用 502。前端按状态码分支处理,不再一律当 502。
- **超时入参校验(2026-11)**:网关统一 `clampTimeoutMs(value, def, min, max)`(取整/夹逼),避免 `timeoutMs=-1` 或小数让 `AbortSignal.timeout` 抛 `ERR_OUT_OF_RANGE`。
- **构建边界**:`QueryView.vue` 由路由异步加载,Monaco 经 `SqlEditor.vue`/`monaco-setup.ts` 静态依赖，仅首次进入数据库查询模块时下载;不可把 Monaco 注册到入口或公共首屏 chunk。
- **页面生命周期**:查询页接收 TabStage 的 `active` 状态;隐藏时暂停 Spark 日志轮询,重新激活后恢复必要轮询
- 窄屏(≤900px)下隐藏底部状态栏快捷键长提示,保留引擎/库/主题状态;工具条放不下时整体换行(引擎/库下拉可收缩),不把「执行」挤到内容区外。
- **主题单一口径**:画布深浅色跟随门户全局主题(`theme.ts` 派发的 `portal-theme-change` 事件),工具条不再放重复的主题按钮,统一使用顶部壳层入口;不维护独立的 `db-query-theme` localStorage 键,避免门户与画布深浅色互相不一致。
- **数据源异常提示**:数据源请求失败或为空时,工作台顶部常驻 `el-alert` 并提供「重试」,替代此前一闪而过的 ElMessage。
- **空态与分屏**:没有结果时 SQL 画布占满内容区(`.sql-canvas.expanded`),空画布中央给出「在这里编写 SQL」提示(不拦截点击、输入后消失);产生结果后才回落为可拖拽高度并显示分割条,关闭全部结果 tab 后重新占满。
- **工具栏层级**:主操作「执行/停止」带文字标签,格式化与 EXPLAIN 保留图标+tooltip;库下拉按状态给出占位文案(`请先选择引擎`/`数据源不可用`/`该引擎无可用库`),清空引擎时同步清空库。
- 标题策略:数据库查询页不重复展示“数据库查询”标题,侧栏与 Tab 负责导航标识,工作台状态由引擎/库/结果状态栏承载。

- **批执行互斥**:一次点击一个批次,批内 FIFO 串行(`execSegments`);执行中再点被拒;`batchCancelled` 停止按钮中断批 + `cancelSpark/cancelFlink`/`POST /api/db/jobs/:id/cancel` 取消当前引擎 job。MySQL/Oracle/Impala 的停止走 db-proxy **真实取消**(见「真实取消」),响应 `cancelMethod` 回显实际终止方式。按分号拆段时忽略纯注释段，但保留前置行注释/块注释后的可执行 SQL 段。
- **多结果 tab**:`results[]` 数组,每段 SQL 一个 tab,默认展示最后一个;竖排结果 tab。运行中的结果 tab 显示执行中状态,不把预置的空 `rows`/`columns` 当作查询结果；MySQL/Oracle 异步 job 的状态只保存在 db-proxy 进程内存,完成/失败状态保留 1 小时;页面轮询遇到临时网络错误应重试,但浏览器刷新会丢失 jobId,db-proxy 重启会丢失任务状态。
- **结果表格**:el-table(斑马纹 + 固定序号列 + 表头按数值列右对齐 + **内置排序**)+ 前端分页(15/50/100/200);切换/更新结果项时页码重置为第 1 页，避免沿用旧结果页码造成有数据却显示空白;点击列名复制列名;单元格点击复制,NULL 灰字胶囊,对象/数组值显示 JSON 标签点击弹窗格式化查看(已转义);双击单元格行内编辑(预览 tab);**列宽拖拽持久化(2026-11 修订)**:el-table `@header-dragend` 按 `引擎|库|表名`(非预览结果用 `引擎|库|SQL djb2 哈希`)签名写入 localStorage,读入时一次扫描进内存 Map(不在渲染路径逐列 `getItem`),写入 try/catch,`db-query-colw.` 前缀最多 200 个键、超出删最旧。结果区合成一个整体卡片(.result-card):**表格 → 翻页 → 底部信息条(行×列/复制/选择模式)**,内部细线分隔
- **结果复制**:单元格/列名点击复制,复制走 src/utils/clipboard.ts 的 copyText(非安全上下文 HTTP 自动降级 execCommand);工具条提供「复制整表(TSV)」与大结果集确认
- **复制/选择模式**:底部开关切换 —— 复制模式(默认)点击单元格即复制;选择模式取消点击劫持,可用鼠标自由选中文本复制
- **Spark 日志与取消**:SparkSQL 固定路由到 Thrift，SparkSession 固定路由到历史 session；执行日志、Stage 状态与取消均沿用该引擎固定的 `executionMode`。停止操作只按当前 jobId 取消。不得让一个引擎的失败任务转到另一个引擎重试，以免重复提交写 SQL。
- **解锁体系(已移除)**:写权限密码验证(`/api/spark/auth` + `X-Spark-Token`)已移除 —— 写 SQL 直接执行,权限由「数据权限矩阵」管控,数据源 `readOnly` 兑底;spark/flink 网关不再校验解锁 token(db-proxy 侧 `writeToken` 密钥与资源护栏保留)
- **编辑器(Monaco)**:`SqlEditor.vue` 封装 —— 构造函数一次、model 池按 tab 切换(`editor.setModel`),撤销历史/光标按 tab 独立;主题 `portal-dark/portal-light`(defineTheme,仅画布,不污染全局)与字号由 props 驱动;Tab 缩进交给 Monaco 原生(浮层选词/多行缩进自动),Shift+Tab 反缩进、Cmd+/ 注释(逐行 `-- ` 切换)组件内实现。选中同一行的 1–64 字符时，在当前 SQL 文档中高亮最多 500 个完全相同的其他匹配项(大小写敏感，不限定 ASCII 标识符)。**SQL 专属折叠**:注册 folding provider,按跨行括号(CTE/子查询/INSERT SELECT)与块注释折叠(状态机跳过注释/字符串内的括号)。**超长行降级**:检测单行 >500 字符 → 自动 wordWrap off 防折行计算卡,恢复后回 on。**行内校验**:同样的词法扫描产出 markers —— 未闭合引号/括号 → 波浪线 + hover 提示(300ms 防抖;跳过 -- # /* */ 注释与字符串)。**卡死根治(2026-08)**:CM5 的"每键全文档扫描 + 上千候选一次性渲染 DOM"不复存在 —— 补全为异步 provider + **文中词行级增量索引**(每键只重建光标 1 行;Enter/粘贴/删除等行数变化低频场景才整表重建)+ 候选上限截断 + Monaco 虚拟滚动渲染;`${var}` 参数行同步在 change 事件中与快照**共用一次 getValue**(不再每键两次全量)
- **脚本树**:`data/scripts` 本地存储,文件 = 脚本(不入库);**按用户分桶**(2026-08)——`tree.json` 按用户名分桶(`users.<username>.my` 私有桶 + `users.__shared__` 公共桶);前端固定双根:「我的文件夹」(私有,仅本人可见可写)+「共享文件夹」(**所有人可读可写**,全员协作,右键含完整菜单 + 「复制到我的文件夹」,可拖入拖出);旧版顶层 `{my:[]}` 格式首次加载自动迁移进公共桶;**原子写(2026-11)**:`tree.json` 与脚本内容改为 `tmp + rename` 写入,`tree.json` 解析失败时返回 500 并拒绝写入(不再用空树覆盖导致全员脚本丢失)
- **元数据深度**:表目录懒加载已切 detail 模式 —— 表节点显示表注释(悬停完整),字段节点显示类型+注释,双击表节点一键预览(`SELECT * ... LIMIT 100`,Oracle 用 `FETCH FIRST 100 ROWS ONLY` 与双引号标识符),表节点按钮支持复制表名 / 复制建表语句(`/ddl`)
- **复制建表语句**:`/ddl?db=&table=` —— MySQL 走 `SHOW CREATE TABLE`,Oracle 走 `DBMS_METADATA.GET_DDL`,需账号有对应元数据读取权限,失败友好报错
- **行内编辑(写场景)**:仅**双击表生成的预览 tab**(单表 `SELECT *` 且带主键)可编辑 —— 编辑会绑定发起编辑的结果 tab 与行对象，不能用行号索引结果 tab；双击单元格进入编辑(主键列拒绝),改值后结果工具条「提交修改 (N)」列出全部变更,弹确认框展示生成的 `UPDATE ... SET ... WHERE 主键` 完整 SQL(多条按行分组逐条执行,MySQL 反引号 / Oracle 双引号,字符串/日期转义 `''`、数字/布尔/null 原样),确认后直接执行(写权限验证已移除),成功后清空待提交列表并自动重查刷新;无主键/非预览 tab 不可编辑
- **写审计**:db-proxy 对 MySQL/Oracle/Doris 的写 SQL(INSERT/UPDATE/DELETE/DDL)执行后追加 `audit/audit-db.log`(JSON Lines):时间、数据源、sql(截断 500)、影响行数、耗时、来源(sync/async)。只读数据源被拦的写尝试同样记录
- **数据权限矩阵(P3)**:网关层用户/角色→库白名单(`server/data/db-permissions.json`),带 `db` 参数的 MySQL/Oracle 接口按调用者校验,不在其 dbs → 403;admin 放行、无规则回退全局白名单;**管理入口已集成到「用户管理」页**(用户行内「库权限」编辑弹窗 + 「数据权限」tab 内嵌 DbPermView,原独立菜单/路由 `/db-perms` 已移除);**`GET /api/db/acl` 按当前用户过滤数据源列表**(库下拉/表目录只展示开放的库,admin/无规则全量)。详见 `docs/modules/db-permissions.md`
- **关系库 Schema 补全**:`/schema?db=` 一次性返回该库全部表+字段(MySQL `information_schema` / Oracle `all_tables+all_tab_columns` / Impala `SHOW TABLES+DESCRIBE`),按当前数据源缓存;编辑器输入时快速自动提示,Ctrl+Space 手动触发 —— SQL 关键字、函数、snippet 与文档词由本地候选提供,按输入变更中的 SQL 上下文显式触发(80ms 防抖);表名优先,表名下钻字段名,db 就绪/切换即后台预取 schema,表字段候选从缓存读取;**当前编辑 Tab 内 SQL 单引号字面量**可按前缀补全此前输入值(排除注释、当前未闭合值不作为候选,不跨 Tab/历史);候选按前缀桶过滤,增量索引仅重建变更行,不在每键全量扫描;**内置函数库**(60+ 常用函数,detail 显示签名,插入带参数占位)+ **SQL snippet**(sel/cte/ins/upd/del/crt 缩写字触发模板,Monaco 原生 tabStop);实现:SqlEditor 组件内 provider + 行级增量词表
- **前端缓存与失效(2026-11)**:全部为进程内 + localStorage,现均带明确失效口径:
  - `SqlEditor` schema 缓存:值为 `{data, ts}`,成功 **TTL 5 分钟**、失败只写 **10s 负缓存**(过期自动重试,不再"一次失败整会话失效");key 为 `[engine, executionMode, db, table]`;`schemaLoader` 显式接收发起时的 `(db, engine, executionMode, table)` 快照,结果按快照 key 缓存(切走再切回不重复拉取),retrigger 仍校验当前引擎/模式,避免旧响应污染 UI。
  - 单点号前缀消歧(Spark):库清单未加载时先按最常见的 `库.` 猜测立即加载,同时后台拉 `SHOW DATABASES`;清单确认不是库名时回退 `表.列` 并 retrigger(`emp.id` 这类表.列写法一次纠正)。
  - Monaco model 池:关闭编辑器 tab 时调用 `disposeModel(id)` 释放 model 与词表/字符串索引 Map;tab id 改为不可复用的随机 id,恢复的草稿统一进 `draft-*` 命名空间,杜绝"两个 tab 共用一个 model"。
  - `${var}` 参数记忆按 `引擎:数据源::变量名` 记忆,换数据源/引擎清空预填,不再跨库串味。
  - 表目录 `node-key` 带作用域(`t:<db>:<table>`、`f:<db>:<table>:<col>`),跨库同名表不再冲突。
  - `src/api/db.ts` 的 `request` 带分层超时(普通 30s / schema 45s / 元数据 20s),超时抛 `name='TimeoutError'`、`code='TIMEOUT'`;跨库表搜索带 `AbortController` + 请求序号,迟到响应直接丢弃。
- **EXPLAIN 可视化**:工具栏「EXPLAIN」取选中 SQL → `/explain` —— MySQL 走 `EXPLAIN FORMAT=JSON` 解析成树(降级普通 EXPLAIN 表格),Oracle 走 `EXPLAIN PLAN FOR` + `DBMS_XPLAN` 表格按 ID/PARENT_ID 递归成树;结果在弹窗中用 el-tree 展示(访问类型/行数/代价/过滤条件)
- **SQL 传参(内联参数行)**:自动识别画布 SQL 中全部 `${var}`(字母/下划线开头,有序去重),在分割条下方「SQL 参数」行内联填值(el-input,无变量时不占位;编辑器内容/tab 切换实时同步,同名变量会话内记忆上次取值自动预填);**只替换本次执行段内已填值的变量,未填值的保持 `${var}` 原样交由引擎报错,不阻断其他 SQL 执行**(2026-08 修复:此前按画布全集校验导致缺参卡住所有查询)。原 `${T}/${T-N}` 内置日期变量、`${T-1} 传参` 下拉与 ElMessageBox 弹窗传参已移除;快捷键提示行移至底部状态栏主题项旁
- **历史与收藏**:读写统一收口 `src/utils/db-query-cache.ts`(单一 key 前缀、读-改-写前重新读取合并、监听 `storage` 事件)。QueryView 每次成功执行把 SQL 记入 localStorage `db-query-history:<用户名>`(**按用户隔离**,同一浏览器多账号互不可见;认证关闭落到 `default`),「历史」与「收藏」**上限统一 50 条**(新在前、同 sql 去重);**点击历史/收藏条目只回填编辑器不自动执行**;**结果快照随历史缓存**——执行成功时把该 SQL 的列+前 100 行快照写入条目(按 `Blob` 真实字节估算,>200KB 不缓存),点击带快照的条目除回填编辑器外直接开一个「缓存」标记的结果 tab 免重查展示。**配额保护(2026-11)**:localStorage 写入 `QuotaExceededError` 时逐条剥离最旧快照重试,仍失败则降级为不含快照的条目并 `console.warn`,不再静默丢弃整份历史。**快照明确标注(2026-11)**:cached tab 的状态栏与信息条显示「缓存快照 · 前 N 行」,导出按钮为「导出快照」(文件名带 `_snapshot`),不再伪装成完整结果。历史/收藏列表仍以「结果」小徽标标识
- **画布专业化(DataGrip 式)**:编辑器↔结果区可拖拽调高(`.sql-dragbar`);结果 tab 显示运行状态点(执行中 spinner / 成功绿 / 失败红 / 截断黄),tab 名固定 queryN;底部全局状态栏(引擎/库/行×列·耗时·截断标记/主题 + 快捷键提示);快捷键 Cmd/Ctrl+F 画布内查找、Cmd+Enter 运行、Cmd+S 保存、Cmd+Space 补全、Cmd+Shift+F 格式化、Cmd+/ 注释;保存 SQL 后自动刷新左侧脚本目录树(`treePanelRef.reloadMy()`);**多 tab 独立文档(Monaco model 池,2026-08)**:每个 tab 一个 ITextModel(SqlEditor 内部 `modelId→ITextModel` 池,`editor.setModel` 切换),独立撤销历史(Cmd+Z 不串文件)+ 光标位置;切 tab 不触发 change 事件,参数行由 showTabInEditor 重建,内容快照由 change 事件回调写回(`t.content = editor.getValue()`),自动保存只读活跃 tab 实时内容,非活跃用切换时写回的快照,切走即触发脏 tab 保存
- **SparkSQL / SparkSession 配置**:`datasources.json` 顶层 `spark` 段中，SparkSQL/Thrift 使用 `enabled`、`jdbcUrl`(默认 `jdbc:hive2://127.0.0.1:10001/default`)、`user`(默认 `root`)、`beelinePath`(默认 `$SPARK_HOME/bin/beeline`)、`defaultLimit`、`maxLimit`、`maxSqlLen`、`exportPath`;SparkSession 使用历史字段 `master`、`queue`、`executorMemory`、`executorCores`、`executorInstances`、`sparkConf` 等 YARN client 配置。SparkSession 使用 PySpark 常驻 `SparkSession`,不是 `spark-sql` shell。更改数据源配置后重启 db-proxy；发布独立引擎选择需重建门户镜像。
- **Impala 类型检查与修复**:db-proxy 使用 sqlglot 解析只读查询,通过 DESCRIBE 元数据检查并修正常见列/字面量类型不匹配;列解析按 SELECT 作用域处理未限定字段,并沿 CTE/派生表的直接投影传递字段类型,用于检查跨 CTE/JOIN 的字段比较;JOIN 两侧类型不一致时将两侧均显式转为 STRING。Impala 表名列表和表字段结构缓存到 db-proxy 本地 `data/impala-schema-cache.json`,服务重启后复用;类型检查、`/tables`、`/fields`、`/schema` 共用缓存,缓存缺表/缺结构时按需 DESCRIBE 并持久化。查询返回字段/表引用无法识别错误时强制刷新 SQL 涉及表的结构,更新持久化缓存后再进入 AI 修复流程。缓存按数据源连接指纹与库隔离,不包含密码;数据源结构变化后通过下一次相关错误触发刷新。执行错误时仅对可修复的 SQL 语法/类型错误调用服务端 AI,每次改写必须再次解析为只读 SQL 并重新执行,不重试网络、认证、权限或超时错误;Impala `operands of type ... not comparable` 等错误按类型不匹配处理。执行日志使用中文阶段提示,区分连接、类型校验、SQL 提交/执行、结果读取、执行错误类型、AI 修复建议 SQL 与最终实际执行 SQL,保留数据库原始错误便于排查;执行中的页面显示不确定进度动画和当前阶段,不伪造百分比。`datasources.json` 的 Impala 数据源配置连接地址/端口/库/只读策略;服务端 `impala.aiFix` 配置控制 AI endpoint、密钥、模型与重试数,密钥不下发浏览器。job 状态中的 `logs` 与 `executedSql` 由前端执行日志面板展示。

## 5. 数据源

`db-proxy/datasources.json`(启动加载,改后重启):
- `allowedDbs`:可用库列表(引擎按 db 段配置)
- 库别名:oracle 连接串可配置别名,未配置显示库名
- Impala 数据源设置 `readOnly: true` 时由 db-proxy 二次拒绝写语句

### SparkSQL 与 SparkSession 环境

- db-proxy 所在主机需安装 Spark 客户端并可通过 `$SPARK_HOME/bin/beeline` 连接 HiveServer2 Spark Thrift Server；默认 JDBC URL 为 `jdbc:hive2://127.0.0.1:10001/default`、用户为 `root`。如 db-proxy 位于容器，容器内的 `127.0.0.1` 指向容器本身，需将 `jdbcUrl` 改成容器可达的宿主机地址。
- SparkSQL 使用 `datasources.json` 的 `spark` 段 `enabled`、`jdbcUrl`、`user`、可选 `beelinePath`、`defaultLimit`、`maxLimit`、`maxSqlLen` 和 `exportPath` 字段。未设置 `beelinePath` 时使用 `$SPARK_HOME/bin/beeline`；查询、SHOW/DESC 元数据与 HDFS CSV 导出经 Thrift Server 执行。
- SparkSession 使用同一 `spark` 段的历史 YARN client 配置字段，包括 `master`、`queue`、`executorMemory`、`executorCores`、`executorInstances` 与 `sparkConf`；它在 db-proxy 进程中使用常驻 PySpark `SparkSession`。写入权限仍由门户网关数据权限矩阵控制。
- Thrift 子进程与 SparkSession 各自报告所选通道的执行状态和诊断；停止和超时只作用于所选通道的 job。Stage 状态仅由提供该信息的 session 通道返回。
- `/api/spark/stages?executionMode=` 与 db-proxy `/spark/stages?executionMode=` 按所选模式读取 Stage 快照；Thrift 暂无 Stage 数据时返回空状态，session 返回最近一次 SQL 的 Stage 信息。
- Spark 表双击预览标记对应的数据源引擎：SparkSQL 预览固定走 Thrift，SparkSession 预览固定走 PySpark Session；预览只读，不触发行内关系库编辑和主键加载。
- SparkSQL 请求使用 JDBC URL 默认库或 SQL 中显式库名；SparkSession 请求使用常驻 SparkSession 的既有会话语义。两个引擎都只接受 SQL 工作台请求，不执行用户提交的 PySpark 代码。更新配置后重启 db-proxy；发布门户引擎选择需重建门户镜像。

## 6. 外部 API Token（网关侧）

- 与数据同步 `syncApiToken` 分离，调用方通过 `X-API-Token` 访问门户网关；不向浏览器配置接口回显，不转发给 db-proxy；未配置时保持 Cookie 登录方式。
- token 专用主体允许 Impala、MySQL、Oracle 与 Spark 查询路由，库权限由 `db-permissions` 矩阵的 `db-query-api` 虚拟角色授权。Impala/MySQL/Oracle 限制为单条只读 SQL；Doris、Flink、脚本管理及权限管理接口拒绝 token。
- 外部调用先用 `GET /api/db/acl` 获取已授权数据源；再用 `POST /api/dbquery/query` 同步查询 MySQL/Oracle，或 `POST /api/db/jobs` 异步查询 Impala/MySQL/Oracle。异步任务通过 `GET /api/db/jobs/:id` 轮询、`POST /api/db/jobs/:id/cancel` 取消；所有请求带 `X-API-Token`，提交体使用 `{ "db": "数据源名", "sql": "只读 SQL" }`。
- Impala 查询可按角色规则限制到表；表目录/字段/DDL/整库 Schema 元数据接口仅在该库配置整库读取时开放，避免表级规则下泄露其他表名和结构。
- Spark token 仅允许 Spark SQL；读取按只读语句白名单执行。虚拟角色中的 Spark `writeDbs` 配置写库名单，仅允许 `INSERT INTO` / `INSERT OVERWRITE` 写入名单内库；写请求须提供 `db`，且 SQL 中目标库必须显式限定并与 `db` 一致。`CREATE`、`DROP`、`ALTER`、`USE`、多语句等拒绝。
- API 主体不映射为 admin/dev/viewer 用户，使用权限矩阵中的虚拟角色 `db-query-api` 控制库权限；未配置该角色规则时数据库访问默认拒绝。网关仍硬限制路由和 SQL 能力；权限失败 fail-closed。异步查询通过 `POST /api/db/jobs` 提交，状态/取消只允许访问由该 API 主体提交并登记的 Impala/MySQL/Oracle/Spark job；MySQL/Oracle 同步查询仍可用 `POST /api/dbquery/query`。
- Token 设置仅影响门户服务端 `config.local.json` / 环境变量；请求头仅使用 HTTPS。服务端日志不得记录 token 原文。

配置项仅保留服务端密钥 `dbQueryApiToken`；Impala/MySQL/Oracle 的库读权限通过用户管理 → 数据权限中的 `db-query-api` 虚拟角色 `engineRules` 配置，Spark 读写权限同样在该角色下配置，Spark 写库范围使用 `writeDbs`。

## 7. 已知限制

- db-proxy Oracle thin 模式对旧版本(11g)支持受限(需 thick 模式)
- Spark 首次建 session 需 30~90s(懒加载);session 常驻,跨语句保留临时视图
- Flink 引擎依赖 SQL Gateway / yarn-session(`datasources.json` flink 段)
- 取消查询的「真实终止」依赖数据库侧权限/能力,降级链已在响应 `cancelMethod` 中回显:
  - MySQL/Doris:`KILL QUERY` 由**同账号**连接发送,只能终止本账号自己的线程;若账号被限制则降级为关闭连接;
  - Oracle:普通业务账号通常没有 `ALTER SYSTEM` 权限,`Connection.cancel()`(OCI break)也不在 1.4.x 上可用时只能关闭连接 —— 查询可能在服务端继续跑到语句自然结束(其会话已被断开,结果不再回传);
  - Impala:impyla 未暴露 `CancelOperation` 时降级为关闭 operation/会话;
  - Spark:Thrift 杀进程组是确定性终止;Session 的 `cancelJobGroup` 对已提交到集群的 stage 是「尽力而为」,不会强杀 YARN executor 上的任务。
- Impala 表结构缓存默认 24h 过期,DDL 变更后最长需等 24h 或触发一次"表/字段找不到"的错误才会刷新
- MySQL/Oracle/Doris 的 schema/表/字段/DDL 元数据无服务端缓存,刷新页面或换浏览器会重新打库(单库表数上限 800)

