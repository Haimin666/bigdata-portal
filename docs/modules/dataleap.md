# DataLeap 实验(文件化数据开发)

> 模块定位:**实验性质**的轻量数据开发平台——一个文件 = 一个节点,文件依赖 = 血缘;
> 独立存储(`data/dleap/`)、独立路由(`/api/dataleap/*`),不影响其他模块。
> 发布到 DS 仅创建工作流定义(**不触发实例执行**);预览为纯 mock。

## 1. 文件清单

| 层 | 文件 | 职责 |
|---|---|---|
| 视图 | `src/views/dataleap/DataLeapView.vue` | 主视图:节点树(按 dir 分组)/ 编辑区(textarea)/ 血缘图(G6, 尺寸自适应已收编 useResizeObserver)/ 执行历史 / 发布预览 |
| 视图 | `src/views/dataleap/components/CronSetter.vue` | cron 5 字段可视化设置器 |
| API | `src/api/dataleap.ts` | nodes CRUD / deps / graph / run / runs / publish 封装 |
| 网关 | `server/dataleap.js` | Express Router + cron 调度器(30s tick,分钟级匹配)+ DS 序列化 |
| 存储 | `data/dleap/nodes.json`、`runs.json`、`run/`(shell cwd) | JSON 文件存储(docker 挂载 `./data:/app/data` 持久化),原子写(tmp+rename) |

## 2. 数据模型

- **节点**:`{ id(uuid), name, type: sql|shell|spark, project, content, deps[](上游 id), cron(5 段), db(数据源,试跑用), dir(目录分组), updatedAt }`
- **执行历史 runs**:内存文件化,保留最近 200 条;`trigger: single|topo|cron|rerun`

## 3. 核心机制

- **血缘/环检测**:`deps` 为上游→下游边;`wouldCreateCycle` DFS 防环;`topoSort` 后序 DFS 出拓扑序 + 环列表
- **节点执行**:`runNode` 按 type 分派——shell 本地 `/bin/sh`(30s 超时 kill、64KB 截断)、sql 经 db-proxy `/query`(60s)、spark 经 db-proxy `/spark/query`(只读 `writeUnlocked:false`)
- **调度器**:`initDataleap()` 启动 30s interval(`unref()` 不阻塞退出),分钟 key 去重后对命中 cron 的节点逐个执行并记录
- **发布到 DS**:`buildDsWorkflow` 把节点序列化为 DS `processDefinitionJson`(每节点一个 SHELL 任务;SQL 包装 spark-sql;依赖=preTasks+connects;任务 id 形如 tasks-1000xx)→ `POST /projects/<project>/process/save`;项目默认 `whm-test`(`config.dataleapPublishProject` 可覆盖)
- **失败重跑**:`POST /runs/:id/rerun` 只重跑该实例中失败的节点

## 4. API 一览(均挂 `/api/dataleap`,登录保护前缀内)

| 方法/路径 | 说明 |
|---|---|
| `GET/POST /nodes`、`GET/PUT/DELETE /nodes/:id` | 节点列表(不含 content)/新建/详情/更新/删除(级联清理依赖引用) |
| `PUT /nodes/:id/deps` | 设置上游依赖(校验存在性+不成环) |
| `GET /graph` | 血缘图(节点+边+拓扑序+环) |
| `POST /run/shell` | 试跑 shell 节点(需登录;30s 超时) |
| `POST /run/all` | 按拓扑串行执行全部(SQL/Spark 只读;失败不中断,记录历史) |
| `GET /runs`、`POST /runs/:id/rerun` | 历史筛选(trigger/status/keyword)/ 失败重跑 |
| `POST /publish/ds` | 发布到 DS 固定测试项目(真实创建定义,不执行) |
| `POST /publish/preview` | 序列化预览(mock,无任何真实操作) |

## 5. 边界与注意事项

- shell 节点在**门户服务器本地**执行脚本内容:依赖登录保护与超时护栏,**不要**放开给 viewer 以外的免登录场景;新增执行类能力须同步考虑 EXEC_GATES 式门禁
- 发布是唯一触碰真实 DS 的路径:仅 `process/save`(保存定义),绝不调 start/execute
- 存储为整文件读写,节点量大时注意并发写(当前规模可接受;扩容前先改分片)
