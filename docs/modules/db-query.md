# 模块:数据库查询(db-query)

## 1. 职责

统一 SQL 工作台:MySQL / Oracle / Doris / **SparkSQL** / **FlinkSQL** 查询、编辑器(CodeMirror 5)、结果多 tab、脚本文件树、Flink 流任务/PreJob 管理。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/views/db/QueryView.vue` | 主工作台:引擎/数据源下拉、CodeMirror 编辑器、快捷键(Ctrl+Enter 执行/Ctrl+Shift+F 格式化)、结果多 tab、执行历史、日志面板、解锁;支持双击表目录表节点生成预览查询自动执行;结果表**双击单元格行内编辑**(仅带主键的单表预览)生成 UPDATE 写前确认;工具栏 **EXPLAIN** 打开执行计划树;编辑器 **schema 驱动补全**(Ctrl+Space) |
| 视图 | `src/views/db/SqlTreePanel.vue` | 脚本文件树(本地 scripts 存储,右键新建/重命名/删除) + 表目录(库→表→字段,含表/字段注释,双击表预览,复制表名/建表语句) + **历史/收藏**(localStorage 持久化,点击回填编辑器执行) |
| 视图 | `src/views/db/FlinkConnectorDialog.vue` | Flink 连接器:批量建表/DDL 生成/表探测 |
| 视图 | `src/views/db/FlinkJobsDialog.vue` / `FlinkPreJobDialog.vue` | Flink 流任务列表/停止;PreJob 提交(yarn-per-job)/状态/日志/取消 |
| API | `src/api/db.ts` | queryDb / querySpark / queryFlink / sparkAuth / cancelSpark / 日志轮询 / 脚本 CRUD;listTables/listFields(detail 参数返回表/字段注释)、getTableDDL、**getSchema(补全元数据)、explainSql(执行计划)** |
| 网关 | `server/index.js` | `/api/db*` 透传(不含 `/jobs`,提交走专用路由)、`/api/dbquery/query` 与 `/api/db/jobs`(X-Spark-Token)、`/api/spark/*`(spark-gateway)、`/api/flink/*`(flink-gateway)、`/api/scripts` |
| 服务 | `services/db-proxy/main.py` | `/query`(MySQL/Oracle/Doris)、`/spark/query`、`/flink/query`、`/dbs`、`/acl`、护栏(限流/并发);`/tables` `/fields`(detail=1 返回注释/可空/键)、`/ddl`(生成建表语句)、**`/schema`(全量表+字段扁平元数据,供补全)、`/explain`(MySQL EXPLAIN / Oracle EXPLAIN PLAN)、写审计(audit/audit-db.log)** |
| 服务 | `services/db-proxy/spark_engine.py` | 常驻 SparkSession 执行 |
| 服务 | `services/db-proxy/flink_engine.py` / `flink_prejob.py` / `flink_connectors.py` | Flink 三通道 |

## 3. 引擎矩阵

| 引擎 | 通道 | 写权限 | 超时 | 备注 |
|---|---|---|---|---|
| mysql/oracle/doris | db-proxy `/query`(同步)/ `/jobs`(异步任务) | **写权限密码验证已移除**:库访问权由数据权限矩阵管控,数据源 `readOnly` 与 db-proxy 资源护栏兑底;写操作(UPDATE/INSERT/DELETE/DDL)记审计日志 | db-proxy `queryTimeout`;异步默认 1h 可配 | 直连;异步任务提交由网关专用路由处理(非透传),EXEC_GATES 拦 viewer |
| sparksql | db-proxy `/spark/query`(常驻 client session) | 写语句需网关写拦截(isSparkWriteSql);**已移除独立解锁弹窗**,权限由数据权限矩阵 + db-proxy 护栏管控 | **前端/门户/db-proxy 统一 120s**,超时自动 cancelJobGroup | 串行锁;FileNotFound 自动 REFRESH 重试一次 |
| pyspark | 同上 `kind=pyspark` | 同上(与 sparksql 同通道) | 同上 | 前端已移除入口,后端保留给 Jupyter |
| flinksql | db-proxy `/flink/query` | 同上(写权限同 spark 体系) | `queryTimeout`(默认 300s) | 流/批双模式;流查询 collect 到 limit 行返回 |
| flink prejob | db-proxy `/flink/prejob/jobs`(yarn-per-job) | **已移除解锁要求**:直接提交,写凭证由网关自动携带(db-proxy 侧共享密钥校验防直连) | `submitTimeout`(默认 120s) | pyflink 脚本封装;作业列表/日志/停止走 PREJOB 管理 |

## 4. 核心机制

- **批执行互斥**:一次点击一个批次,批内 FIFO 串行(`execSegments`);执行中再点被拒;`batchCancelled` 停止按钮中断批 + `cancelSpark/cancelFlink` 取消当前引擎 job
- **多结果 tab**:`results[]` 数组,每段 SQL 一个 tab,默认展示最后一个;竖排结果 tab
- **结果表格**:el-table(斑马纹 + 固定序号列 + 表头按数值列右对齐 + **内置排序**)+ 前端分页(15/50/100/200);点击列名复制列名;单元格点击复制,NULL 灰字胶囊,对象/数组值显示 JSON 标签点击弹窗格式化查看(已转义);双击单元格行内编辑(预览 tab);**列宽拖拽持久化**:el-table `@header-dragend` 按 库.表(或 SQL 前 40 字符)签名写入 localStorage,刷新保留。结果区合成一个整体卡片(.result-card):**表格 → 翻页 → 底部信息条(行×列/复制/选择模式)**,内部细线分隔
- **结果复制**:单元格/列名点击复制,复制走 src/utils/clipboard.ts 的 copyText(非安全上下文 HTTP 自动降级 execCommand);工具条提供「复制整表(TSV)」与大结果集确认
- **复制/选择模式**:底部开关切换 —— 复制模式(默认)点击单元格即复制;选择模式取消点击劫持,可用鼠标自由选中文本复制
- **Spark 日志透传**:执行时 3s 轮询 `/api/spark/logs` 增量展示 driver 日志,结束即停;自动滚动到底部跟随最新 200 条(双 rAF 等 DOM 就绪再滚,用户上翻阅读旧日志时暂停跟随,回到底部附近自动恢复)
- **解锁体系(已移除)**:写权限密码验证(`/api/spark/auth` + `X-Spark-Token`)已移除 —— 写 SQL 直接执行,权限由「数据权限矩阵」管控,数据源 `readOnly` 兑底;spark/flink 网关不再校验解锁 token(db-proxy 侧 `writeToken` 密钥与资源护栏保留)
- **编辑器**:CodeMirror 5,自实现括号补全/Tab 缩进/Shift+Tab,主题跟随全局
- **脚本树**:`data/scripts` 本地存储,文件 = 脚本(不入库);**按用户隔离**(2026-08)——`tree.json` 按用户名分桶(`users.<username>.my`),普通用户只能看到/操作自己的树,跨用户读写一律 404/403;admin 额外看到「👤 xxx 的目录」只读伪根(可浏览所有人内容)与可写「🤝 共享空间」(仅 admin 可见);旧版顶层 `{my:[]}` 格式首次加载自动迁移
- **元数据深度**:表目录懒加载已切 detail 模式 —— 表节点显示表注释(悬停完整),字段节点显示类型+注释,双击表节点一键预览(`SELECT * ... LIMIT 100`,Oracle 用 `FETCH FIRST 100 ROWS ONLY` 与双引号标识符),表节点按钮支持复制表名 / 复制建表语句(`/ddl`)
- **复制建表语句**:`/ddl?db=&table=` —— MySQL 走 `SHOW CREATE TABLE`,Oracle 走 `DBMS_METADATA.GET_DDL`,需账号有对应元数据读取权限,失败友好报错
- **行内编辑(写场景)**:仅**双击表生成的预览 tab**(单表 `SELECT *` 且带主键)可编辑 —— 双击单元格进入编辑(主键列拒绝),改值后结果工具条「提交修改 (N)」列出全部变更,弹确认框展示生成的 `UPDATE ... SET ... WHERE 主键` 完整 SQL(多条按行分组逐条执行,MySQL 反引号 / Oracle 双引号,字符串/日期转义 `''`、数字/布尔/null 原样),确认后直接执行(写权限验证已移除),成功后清空待提交列表并自动重查刷新;无主键/非预览 tab 不可编辑
- **写审计**:db-proxy 对 MySQL/Oracle/Doris 的写 SQL(INSERT/UPDATE/DELETE/DDL)执行后追加 `audit/audit-db.log`(JSON Lines):时间、数据源、sql(截断 500)、影响行数、耗时、来源(sync/async)。只读数据源被拦的写尝试同样记录
- **数据权限矩阵(P3)**:网关层用户/角色→库白名单(`server/data/db-permissions.json`),带 `db` 参数的 MySQL/Oracle 接口按调用者校验,不在其 dbs → 403;admin 放行、无规则回退全局白名单;**管理入口已集成到「用户管理」页**(用户行内「库权限」编辑弹窗 + 「数据权限」tab 内嵌 DbPermView,原独立菜单/路由 `/db-perms` 已移除);**`GET /api/db/acl` 按当前用户过滤数据源列表**(库下拉/表目录只展示开放的库,admin/无规则全量)。详见 `docs/modules/db-permissions.md`
- **Schema 补全**:`/schema?db=` 一次性返回该库全部表+字段(MySQL `information_schema` / Oracle `all_tables+all_tab_columns`),按当前数据源缓存;编辑器 Ctrl+Space 触发补全 —— 表名优先,表名下钻字段名,SQL 关键字兜底
- **EXPLAIN 可视化**:工具栏「EXPLAIN」取选中 SQL → `/explain` —— MySQL 走 `EXPLAIN FORMAT=JSON` 解析成树(降级普通 EXPLAIN 表格),Oracle 走 `EXPLAIN PLAN FOR` + `DBMS_XPLAN` 表格按 ID/PARENT_ID 递归成树;结果在弹窗中用 el-tree 展示(访问类型/行数/代价/过滤条件)
- **SQL 传参(内联参数行)**:自动识别画布 SQL 中全部 `${var}`(字母/下划线开头,有序去重),在分割条下方「SQL 参数」行内联填值(el-input,无变量时不占位;编辑器内容/tab 切换实时同步,同名变量会话内记忆上次取值自动预填);执行与 EXPLAIN 前校验,有未填变量则提示中止。原 `${T}/${T-N}` 内置日期变量、`${T-1} 传参` 下拉与 ElMessageBox 弹窗传参已移除;快捷键提示行移至底部状态栏主题项旁
- **历史与收藏**:QueryView 每次成功执行把 SQL 记入 localStorage `db-query-history`(**上限 20 条循环缓存**:新在前、同 sql 去重、超出删最旧);侧栏「历史」tab 星标收藏写入 `db-query-favorites`(上限 50);**点击历史/收藏条目只回填编辑器不自动执行**(历史是缓存,用户按 Cmd+Enter 自行运行)
- **画布专业化(DataGrip 式)**:编辑器↔结果区可拖拽调高(`.sql-dragbar`);结果 tab 显示运行状态点(执行中 spinner / 成功绿 / 失败红 / 截断黄),tab 名固定 queryN;底部全局状态栏(引擎/库/行×列·耗时·截断标记/主题);快捷键 Cmd+Enter 运行、Cmd+S 保存、Cmd+Space 补全、Cmd+Shift+F 格式化、Cmd+/ 注释;保存 SQL 后自动刷新左侧脚本目录树(`treePanelRef.reloadMy()`)
- **Spark Stage 进度**:spark 查询执行中,日志面板顶部按 3s 节奏轮询 `/spark/stages`(后端 `sparkContext.statusTracker()` 聚合活跃 job/stage:任务数/已完成/失败/状态),每条 stage 一个 el-progress 进度条,RUNNING 蓝 / SUCCEEDED 绿 / FAILED 红;local 模式或 statusTracker 不可用时自动降级为空

## 5. 数据源

`db-proxy/datasources.json`(启动加载,改后重启):
- `allowedDbs`:可用库列表(引擎按 db 段配置)
- 库别名:oracle 连接串可配置别名,未配置显示库名
- `readOnly: true` 的数据源强制只读

## 6. 已知限制

- db-proxy Oracle thin 模式对旧版本(11g)支持受限(需 thick 模式)
- Spark 首次建 session 需 30~90s(懒加载);session 常驻,跨语句保留临时视图
- Flink 引擎依赖 SQL Gateway / yarn-session(`datasources.json` flink 段)
