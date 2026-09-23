# bigdata-portal 总体架构

> 本文档是项目的**活架构**(authoritative)。任何模块结构/数据流/API 变更,必须先更新本文档再改代码。

## 1. 总览:三层架构

```
┌────────────┐   HTTP/HTTPS    ┌──────────────────────────────┐
│  浏览器     │ ──────────────▶ │  Node 网关(Express, :3000)   │
│  Vue3 SPA  │                 │  server/ 装配器+中间件+路由模块  │
└────────────┘                 └──────┬─────────────┬─────────┘
                                      │ API 转发     │ 反向代理
                     ┌────────────────▼───┐   ┌─────▼──────────────┐
                     │ db-proxy(FastAPI   │   │ 集群/子应用直连      │
                     │  :8756, 客户机)    │   │ RM/NM/DS/StreamX/    │
                     │ MySQL/Oracle/Impala│   │ Jupyter/OMD/Stingray │
                     │  Spark/Flink 引擎  │   └─────────────────────┘
                     └────────────────────┘
```

- **前端**:Vue3 SPA(编译产物 `dist/`,由网关 serve,`docker` 多阶段构建)
- **网关**:Node Express,聚合三类能力 —— ① 本平台 API(auth/theme/users/db/scripts/ds-deps/spark/flink)② 反向代理(子应用 iframe、YARN 页面重写代理)③ 静态托管(dist)
- **数据服务 db-proxy**:Python FastAPI,部署在能直连数据库的客户机(`hadoop-task-3`),内嵌常驻 SparkSession 与 Flink 引擎;门户不直接连库

## 2. 前端架构

### 2.1 目录结构

```
src/
├── main.ts             # 入口:主题初始化 + 加载管理端主题覆盖
├── App.vue             # 根组件
├── router/index.ts     # 路由:native 静态路由 + 菜单驱动的 subapp 占位路由
├── layouts/            # 门户壳
│   ├── MainLayout.vue      # 侧栏 + TabStage
│   └── components/
│       ├── SideBar.vue     # 菜单(enabledModules 白名单 + 角色过滤)
│       ├── TabStage.vue    # 多 tab 常驻池(v-show 保状态,关闭才销毁)
│       └── SubAppView.vue  # 子应用 iframe 池
├── views/              # 业务视图(见模块文档)
├── store/              # Pinia:auth.ts(会话/角色)、yarn.ts(应用列表/RM 选择)
├── api/                # 后端封装:auth/db/ds/dsDeps/hdfs/yarn
├── utils/theme.ts      # 深浅主题 + 管理端主题覆盖注入
├── styles/             # variables.scss(双主题 CSS 变量)/ index.scss(全局)
├── components/         # 通用:PageHeader/TableToolbar/StateView/StatusBadge 等
├── config/menu.ts      # 静态菜单表(驱动侧栏 + subapp 路由 + 角色过滤)
└── types/              # TS 类型
```

### 2.2 关键机制

- **tab 常驻池**:`TabStage` 用 `v-show` 保留所有打开过 tab 的组件状态(iframe 池保留子应用滚动/登录态),关闭才销毁
- **tab 交互**:`SubappTabs` 提供刷新、关闭当前、关闭左右侧/其他 tab 的上下文操作;操作只改变内存中的常驻池,不改变页面内容区尺寸
- **列表状态**:`StateView` 统一加载完成后的空数据、错误和重试反馈;保留表格的 loading 遮罩,不改变内容区高度
- **表格工具栏**:`TableToolbar` 统一刷新、表格密度和筛选/操作插槽;密度偏好按页面保存在 localStorage,列显隐仍由业务页面维护
- **自建页面滚动契约**:原生页面根节点固定在 `TabStage` 内容区内并使用 `min-height:0; overflow:hidden`;表格、结果集、文件列表、消息流等长内容由自身容器 `flex:1; overflow:auto` 承担滚动,工具栏和分页不随数据行数下移
- **tab 刷新策略**:标签页上下文刷新只递增当前 tab 的 `refreshKey`;常驻池继续使用 `v-show`,不会因为切换丢失页面状态。打开 tab 路径按用户写入 `sessionStorage`,浏览器刷新后恢复顺序,不同用户使用不同键
- **业务页规范**:YARN、工作流、HDFS、数据库查询和数据同步页面不重复展示模块标题,业务操作保持原有内容区,通过 `TableToolbar`、状态卡和结果面板统一交互反馈;开发助手作为跨源 iframe 子应用嵌入 Datadeck Agent,固定使用受控入口用户
- **危险操作反馈**:工作流实例、任务节点、YARN 应用和同步生成等异步操作必须在目标按钮上显示 loading,成功后刷新或展示结果,失败保留可重试入口;不得用全局遮罩阻塞无关页面操作
- **桌面端视觉层**:桌面壳采用低饱和蓝灰中性色、系统无衬线字体和语义主题变量;侧栏/标签页统一使用轻量层级和明确 hover/active/focus 状态,不改变业务页面的宽表格、SQL 画布和内容区尺寸。侧栏折叠入口固定在顶部壳层左侧,使用 `Fold/Expand` 图标切换 220px/64px 宽度;深浅主题入口固定在顶部操作区,切换状态持久化到 `localStorage` 并同步 `html.dark`
- **主题体系**:`variables.scss` 定义 `:root`(浅色)/`html.dark`(深色)两套 CSS 变量(`--bd-*`);`theme.ts` 负责切换、`readCssVarSet` 读真实默认、管理端覆盖注入 `data/theme.json`
- **菜单**:`SideBar` 按 `enabledModules`(配置白名单,空=全部)+ 用户角色过滤;`userManage`/`theme` 仅 admin;**路由守卫同样校验模块白名单**(URL 直达受限页面重定向回首页,后端执行门禁兜底)
- **字体**:全局系统无衬线字体栈 `--bd-font`;SQL/日志等数据组件按需使用等宽字体,管理端可覆盖

## 3. 网关架构(server/)

### 3.1 模块清单

> 2026-08 重构:网关从单文件 `index.js` 拆分为「装配器 + 中间件 + 工具 + 路由模块」,
> 各路由模块内部保持与拆分前相同的注册顺序与路径(行为等价)。`index.js` 只负责顺序装配。

| 文件 | 职责 |
|---|---|
| `index.js` | **Express 装配器**:中间件顺序、各路由模块挂载、SPA fallback、listen(业务逻辑已按模块拆出) |
| `middleware/auth-gate.js` | 登录门禁:PROTECTED_PREFIXES 内未登录一律 401(未初始化 503) |
| `middleware/exec-gate.js` | 执行类操作门禁(EXEC_GATES):viewer 禁执行 + 角色/模块白名单 |
| `middleware/error-handler.js` | 统一错误出口(jsonNotFound + errorHandler):未匹配路由 JSON 404、body 解析失败 400、next(err) 兜底 500,维持全站 `{code,msg}` 契约 |
| `utils/proxy-utils.js` | 子应用代理工具:cookie/Location 重写、onProxyRes、iframeProxy 工厂 |
| `utils/sql-write-detect.js` | SQL 写检测三件套:isSparkWriteSql / splitSqlStatements / extractTables(Spark/Flink/dbquery/权限矩阵共用) |
| `engine-map.js` | 库→引擎映射共享状态(`/api/db/acl` 刷新,dbquery/权限矩阵校验引擎级规则用) |
| `routes/yarn-proxy.js` | YARN 三套代理:hadoopapi(按 X-Resource-Manager 动态)、yarniframe(HTML 重写)、iframe-proxy(NM 日志等白名单主机) |
| `routes/subapps-proxy.js` | 子应用 iframe 代理:HDFS(/apps/hdfs、/static、/webhdfs)、DS Web、Jupyter、DolphinScheduler、Stingray(HTML 注入) |
| `routes/db.js` | DB 访问:/api/db 权限校验 + acl + jobs + explain + 透传,以及 /api/db-perms 管理 API(admin) |
| `routes/spark.js` | Spark SQL:query/jobs/logs/status/config/stages/cancel；用户访问由模块与数据权限矩阵控制 |
| `routes/flink.js` | Flink SQL:交互查询/async/连接器/DDL 生成/jobs/PreJob 全套路由 |
| `routes/dbquery.js` | MySQL/Oracle 同步查询 `/api/dbquery/query`(写检测 + 权限矩阵) |
| `routes/assistant.js` | 开发助手:/api/assistant 项目路由(接 assistant-projects.js)+ 8787 Reasonix 代理;Datadeck Agent `/agent` iframe/API/资源同源代理 |
| `routes/portal.js` | 门户配置下发:`/api/config/modules` + `/api/config`(白名单字段,不泄露敏感配置) |
| `routes/ws-proxy.js` | WebSocket 代理(stingray/jupyter)+ upgrade 登录鉴权 |
| `auth.js` | 认证:会话 cookie(12h)、登录/登出/me/init、角色守卫、登录限速 |
| `users.js` | 用户存储:`data/users.json`(scrypt 加盐)、角色(admin/dev/viewer)、CRUD |
| `config.js` | 配置统一来源:`server/config.local.json`(gitignore),缺省回退环境变量/默认;配置 JSON 非法则启动即报错(fail-fast) |
| `db-permissions.js` | 数据权限矩阵读写与校验(loadPerms/savePerms/checkDbAccess/checkSparkAccess/checkFlinkAccess/allowedDbsFor) |
| `ds-deps.js` | 海豚调度依赖:项目/工作流/实例列表、依赖树缓存(`data/ds-deps.json`) |
| `db-scripts.js` | 本地 SQL 脚本存储(`data/scripts`) |
| `assistant-projects.js` | 开发助手项目元数据 + workspace 目录操作(被 routes/assistant.js 调用) |
| `spark-gateway.js` | Spark 网关纯转发:`/api/spark/*` → db-proxy,注入 X-DB-Token(安全逻辑在 routes/spark.js) |
| `flink-gateway.js` | Flink 网关纯转发:`/api/flink/*` → db-proxy(交互 + prejob) |

### 3.2 代理体系

- **子应用 iframe 代理**:`/apps/*`(DS Web)、`/apps/jupyter`、`/dolphinscheduler`、`/apps/streamx` 等 —— HTML 内绝对路径重写 + cookie 域名重写,保证 iframe 内链路完整
- **YARN 页面代理**:`/yarniframe`(同构代理 → RM,`/cluster/app/{appId}` 与 `/proxy/{appId}/` 均支持,URL 重写)、`/api/iframe-proxy?url=`(动态,host 白名单 `yarnProxyAllowHosts`)
- 白名单默认 `.bigdata.shiqiao.com` 全域名

### 3.3 认证与写操作防线

- 会话:`portal_session` cookie(httpOnly),`requireAuth`/`requireAdmin` 守卫;`PROTECTED_PREFIXES` 内未登录一律 401
- **WebSocket 鉴权**:upgrade 请求不经过 Express 中间件,网关在 `server.on('upgrade')` 手动解析 `portal_session` cookie 并校验 Stingray/Jupyter 模块权限；未登录、未授权或未初始化一律断开。
- **写操作权限**:独立 `X-Spark-Token` 解锁已移除；Spark/Flink/MySQL/Oracle 写操作由模块权限、数据权限矩阵、数据源 `readOnly` 与 db-proxy 资源护栏共同控制，写 SQL 继续执行语句检测与审计。
- **MySQL/Oracle 防线**:同步查询 `/api/dbquery/query` 与异步任务 `/api/db/jobs`(提交)均做 `isSparkWriteSql` 与数据权限校验；db-proxy 侧 `/jobs` 异步路径同步补齐多语句防护与表级白名单(第二道防线)；`/api/db/jobs` 提交/取消受 EXEC_GATES(dbQuery 模块)约束，GET 状态查询放行。
- **数据权限矩阵(用户/角色→库)**:`server/data/db-permissions.json`(userRules/roleRules,不存在即无规则不拦截);带 `db` 参数的 MySQL/Oracle 访问接口(query/jobs/explain 路由内 + tables/fields/ddl/schema GET 前置中间件)按调用者校验,不在其 dbs → 403;**admin 一律放行**,无规则回退 db-proxy 全局白名单;管理 API `GET/PUT /api/db-perms`(admin only)。详见 `docs/modules/db-permissions.md`

## 4. db-proxy(数据服务,Python FastAPI)

部署在客户机 `hadoop-task-3`,端口 `8756`,鉴权头 `X-DB-Token`。

| 文件 | 职责 |
|---|---|
| `main.py` | FastAPI 入口:数据源加载、路由、鉴权、护栏(限流/并发信号量) |
| `spark_engine.py` | Spark 引擎:懒加载 **client 模式常驻 SparkSession**(YARN),串行锁、jobGroup 可取消、120s 超时自动 cancel、FileNotFound 自动 REFRESH 重试一次 |
| `flink_engine.py` | Flink SQL 引擎:流/批双模式,支持 connector jar(paimon/mysql-cdc/kafka/hbase) |
| `flink_prejob.py` | Flink PreJob 通道:pyflink 脚本生成 + `yarn-per-job` 提交 + YARN 状态/日志/cancel |
| `flink_connectors.py` | Flink 连接器元数据:批量建表/DDL 生成/表探测 |
| `selfcheck_guards.py` | 护栏自检(12 例) |

- **数据源**:`datasources.json`(**启动时加载,改配置必须重启**),含 allowedDbs、flink/spark 段配置
- **引擎路由**:`/dbs`、`/query`(MySQL/Oracle/Doris/Impala)、`/acl`、`/spark/*`、`/flink/*`、`/prejob/*`、`/flink/status` 等;异步 query job 状态按 `queued → running → done/failed/cancelled` 更新;Impala 使用该通道,db-proxy 执行服务端类型检查及可选 AI SQL 修复,连接/校验/SQL 执行/结果读取进度日志随 job 状态返回
- **元数据与补全**:`/tables` `/fields`(detail=1 注释/可空/键)、`/ddl`、`/schema`(全量表+字段扁平元数据,供前端补全)、`/explain`(MySQL EXPLAIN FORMAT=JSON / Oracle EXPLAIN PLAN+DBMS_XPLAN)
- **写审计**:MySQL/Oracle/Doris 写 SQL(INSERT/UPDATE/DELETE/DDL)执行后追加 `audit/audit-db.log`(JSON Lines:时间/数据源/sql 截断 500/影响行数/耗时/来源);只读拦截的写尝试同样记录

## 5. 典型数据流:数据库查询(SQL)

```
QueryView.vue
  └─ api/db.ts queryDb/querySpark/queryFlink
       └─ GET/POST /api/db/*、/api/spark/*、/api/flink/*(网关)
            ├─ 写检测(isSparkWriteSql + 数据权限矩阵)
            └─ spark-gateway / flink-gateway
                 └─ db-proxy /query | /spark/query | /flink/query
                      └─ 引擎执行(常驻 session / flink 网关)→ {columns, rows, costMs, truncated}
```

## 6. 配置体系

唯一来源 `server/config.local.json`(不入 git,样例 `config.local.example.json`),`config.js` 缺省回退环境变量。**配置文件 JSON 非法(如布尔误写 `True`/`False`)时启动即报错退出**,避免配置静默失效。

- 服务:`port`(默认 3000)、`enabledModules`(空=全量)
- 开发助手:`assistantUrl`/`assistantToken`/`assistantWorkspace`(Reasonix);`datadeckUrl`(Datadeck Agent,默认 Docker 宿主机映射 `http://host.docker.internal:8000`)
- 集群:`yarnRmList`/`yarnProxyAllowHosts`、`hdfsUrl`、`dsWebUrl`/`dsToken`、`omdUrl`、`stingrayUrl`、`streamxUrl`、`jupyterUrl`
- 数据:`dbProxyUrl`/`dbProxyToken`、`dbScriptsDir`、`dsDepsCacheFile`
- 安全:`auth.enabled`/`auth.sessionHours`、`sparkWritePassword`、`trustProxy`(反代层数,直连部署保持 0);~~loginTlsInsecure/accounts.*~~ 已随子应用自动登录移除(2026-08,多用户体系)

## 7. 部署拓扑

```
生产门户 cn1-prod-data-bigdata-pongo01
  docker compose(bigdata-portal:latest, 多阶段构建 dist 入镜像)
  └─ 9910:9910(node server,config.local.json)
  同宿主机:jupyter 容器(8888,base_url=/apps/jupyter)

客户机 hadoop-task-3(能直连数据库)
  db-proxy:uvicorn main:app --port 8756(py38 环境)

集群:YARN RM hadoop-nn-1:8088 / NM hadoop-dn-*:8042
     Hive metastore hadoop-nn-1/2:9083
     DS Web olds.bigdata.shiqiao.com/dolphinscheduler
     Flink 1.17.2(StreamX)/ Spark 3.4.2(hadoop-task-1)
```

## 8. Android 移动端

仓库新增独立 `mobile/` 子工程（Vue 3 + Ionic Vue + Capacitor）。移动端复用 Express 网关的认证、模块权限和 YARN/DolphinScheduler API，不直连集群，也不持有 `dsToken`、`dbProxyToken` 等服务凭证。

- YARN 与离线开发使用专门的移动页面；离线开发原生覆盖项目、工作流/详情、近两天工作流/任务实例及常用受控操作，避免复用桌面大表格、G6 和 Monaco。
- 完整“离线开发”继续通过网关的 `/apps/dsweb/ui/#/home` 代理入口访问，在 Android 全屏 WebView 容器中运行。
- 本地开发由移动 Vite 服务代理到网关并沿用 `portal_session` Cookie。生产 Android 在企业 VPN/零信任网络内加载 `https://bigdata-portal.corp.shiqiao.com/mobile/`；网关从独立 `mobile/dist/` 托管该路径，桌面 Web 仍使用根路径 `/` 和 `dist/`。两端共享 HTTPS 域名、`portal_session` Cookie、API 与权限体系。
- 移动端危险操作继续由网关角色/模块门禁兜底，前端必须增加目标确认与重复提交保护；DolphinScheduler 门禁覆盖工作流发布/启动、定时上下线和实例执行类接口。

详细边界见 `docs/modules/mobile.md`。
