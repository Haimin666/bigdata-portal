# bigdata-portal 总体架构

> 本文档是项目的**活架构**(authoritative)。任何模块结构/数据流/API 变更,必须先更新本文档再改代码。

## 1. 总览:三层架构

```
┌────────────┐   HTTP/HTTPS    ┌──────────────────────────────┐
│  浏览器     │ ──────────────▶ │  Node 网关(Express, :3000)   │
│  Vue3 SPA  │                 │  server/index.js 单一入口     │
└────────────┘                 └──────┬─────────────┬─────────┘
                                      │ API 转发     │ 反向代理
                     ┌────────────────▼───┐   ┌─────▼──────────────┐
                     │ db-proxy(FastAPI   │   │ 集群/子应用直连      │
                     │  :8756, 客户机)    │   │ RM/NM/DS/StreamX/    │
                     │  MySQL/Oracle/Doris│   │ Jupyter/OMD/Stingray │
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
│   ├── MainLayout.vue      # 顶栏(状态条/UTC 时钟)+ 侧栏 + TabStage
│   └── components/
│       ├── SideBar.vue     # 菜单(enabledModules 白名单 + 角色过滤)
│       ├── TabStage.vue    # 多 tab 常驻池(v-show 保状态,关闭才销毁)
│       └── SubAppView.vue  # 子应用 iframe 池
├── views/              # 业务视图(见模块文档)
├── store/              # Pinia:auth.ts(会话/角色)、yarn.ts(应用列表/RM 选择)
├── api/                # 后端封装:auth/db/ds/dsDeps/hdfs/yarn
├── utils/theme.ts      # 深浅主题 + 管理端主题覆盖注入
├── styles/             # variables.scss(双主题 CSS 变量)/ index.scss(全局)
├── components/         # 通用:DialogMaxBtn/StateSelect/StatusBadge/UrlFrameDialog
├── config/menu.ts      # 静态菜单表(驱动侧栏 + subapp 路由 + 角色过滤)
└── types/              # TS 类型
```

### 2.2 关键机制

- **tab 常驻池**:`TabStage` 用 `v-show` 保留所有打开过 tab 的组件状态(iframe 池保留子应用滚动/登录态),关闭才销毁
- **主题体系**:`variables.scss` 定义 `:root`(浅色)/`html.dark`(深色)两套 CSS 变量(`--bd-*`);`theme.ts` 负责切换、`readCssVarSet` 读真实默认、管理端覆盖注入 `data/theme.json`
- **菜单**:`SideBar` 按 `enabledModules`(配置白名单,空=全部)+ 用户角色过滤;`userManage`/`theme` 仅 admin
- **字体**:全局等宽字体栈 `--bd-font`,管理端可覆盖

## 3. 网关架构(server/)

### 3.1 模块清单

| 文件 | 职责 |
|---|---|
| `index.js` | Express 入口:静态托管、API 路由、代理体系、写操作防线、SPA fallback |
| `auth.js` | 认证:会话 cookie(12h)、登录/登出/me/init、角色守卫、登录限速、**主题设置路由** |
| `users.js` | 用户存储:`data/users.json`(scrypt 加盐)、角色(admin/dev/viewer)、CRUD |
| `config.js` | 配置统一来源:`server/config.local.json`(gitignore),缺省回退环境变量/默认 |
| `ds-deps.js` | 海豚调度依赖:项目/工作流/实例列表、依赖树缓存(`data/ds-deps.json`) |
| `db-scripts.js` | 本地 SQL 脚本存储(`data/scripts`) |
| `spark-gateway.js` | Spark 网关:`/api/spark/*` → db-proxy,注入 X-DB-Token |
| `flink-gateway.js` | Flink 网关:`/api/flink/*` → db-proxy(交互 + prejob) |

### 3.2 代理体系

- **子应用 iframe 代理**:`/apps/*`(DS Web)、`/apps/jupyter`、`/dolphinscheduler`、`/apps/streamx` 等 —— HTML 内绝对路径重写 + cookie 域名重写,保证 iframe 内链路完整
- **YARN 页面代理**:`/yarniframe`(同构,URL 重写)、`/api/iframe-proxy?url=`(动态,host 白名单 `yarnProxyAllowHosts`)、`/api/yarn-resource/*`(REST JSON 转发,支持 `maxBytes` 截断大日志)
- 白名单默认 `.bigdata.shiqiao.com` 全域名

### 3.3 认证与写操作防线

- 会话:`portal_session` cookie(httpOnly),`requireAuth`/`requireAdmin` 守卫;`PROTECTED_PREFIXES` 内未登录一律 401
- **写操作解锁**:Spark/Flink 写 SQL 必须带 `X-Spark-Token`(由 `/api/spark/auth` 校验 `sparkWritePassword` 签发,12h);`isSparkWriteSql` 白名单检测(去注释 + 拒绝多语句 + 防 `/*!` 走私)
- 未配置 `sparkWritePassword` → 写操作一律禁止(默认只读)

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
- **引擎路由**:`/dbs`、`/query`、`/acl`、`/spark/*`、`/flink/*`、`/prejob/*`、`/flink/status` 等

## 5. 典型数据流:数据库查询(SQL)

```
QueryView.vue
  └─ api/db.ts queryDb/querySpark/queryFlink
       └─ GET/POST /api/db/*、/api/spark/*、/api/flink/*(网关)
            ├─ 写检测(isSparkWriteSql + X-Spark-Token)
            └─ spark-gateway / flink-gateway
                 └─ db-proxy /query | /spark/query | /flink/query
                      └─ 引擎执行(常驻 session / flink 网关)→ {columns, rows, costMs, truncated}
```

## 6. 配置体系

唯一来源 `server/config.local.json`(不入 git,样例 `config.local.example.json`),`config.js` 缺省回退环境变量。关键字段:

- 服务:`port`(默认 3000)、`enabledModules`(空=全量)
- 集群:`yarnRmList`/`yarnProxyAllowHosts`、`hdfsUrl`、`dsWebUrl`/`dsToken`、`omdUrl`、`stingrayUrl`、`streamxUrl`、`jupyterUrl`
- 数据:`dbProxyUrl`/`dbProxyToken`、`dbScriptsDir`、`dsDepsCacheFile`
- 安全:`auth.enabled`/`auth.sessionHours`、`sparkWritePassword`
- 各子应用账号 `accounts.*`

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
