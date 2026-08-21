# 模块:任务监控(ds-task,海豚调度)

## 1. 职责

DolphinScheduler 工作流实例监控:搜索/筛选、状态色、**单页分栏**(左=当前实例列表,右=跨项目依赖树)、级联重跑、实例操作。默认只看**当天(00:00→现在)**实例,便于排查当日任务执行。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/views/ds/DsTaskMonitor.vue` | 主视图:项目/工作流搜索、实例列表(含项目列)、状态筛选(StateSelect)、分栏布局、行操作(暂停/停止/重跑/依赖·级联) |
| 视图 | `src/views/ds/DsDepsPanel.vue` | **右栏依赖 DAG 面板**(内嵌,替代原弹窗):G6.Graph(dagre) 有向图画上游→当前→下游,浅色卡片节点标最近一次执行状态/执行耗时;勾选级联调起 + 节点右键菜单(复制名称/执行当前及以后)+ hover 启停时间 |
| 视图 | `src/views/ds/DsDepsDialog.vue` | 依赖弹窗(旧,仍可用:G6 树/任务血缘双模式) |
| 视图 | `src/views/ds/DsDepsDagDialog.vue` | **当日页工作流依赖 DAG 弹窗**:G6 有向图(dagre)画上游→当前→下游,节点附当天最新实例完成状态 |
| 视图 | `src/views/ds/DsMonitorToday.vue` | **任务监控·当日页**:统计概览 + 表头排序 + 任务实例「依赖」入口(打开 DAG 弹窗) |
| 视图 | `src/views/ds/DepBranch.vue` | 追踪 UI:依赖树渲染(ECharts tree/链式,节点可拖拽/折叠;支持深链 DS 编辑) |
| API | `src/api/ds.ts` / `src/api/dsDeps.ts` | 实例列表/操作/依赖树 |
| 网关 | `server/index.js` | `/api/ds-*` 转发海豚(dsToken)、`/api/ds-deps`(缓存) |
| 服务 | `server/ds-deps.js` | 依赖树聚合:项目/工作流/最近实例(缓存 `data/ds-deps.json`,默认每天刷新) |

## 3. 数据流

```
DsTaskMonitor → GET /api/ds/process-instances(海豚 API, dsToken;默认当天窗口)
行操作 → POST /api/ds/... (执行/暂停/停止)
右栏依赖 → showDeps(inst) → DsDepsPanel → /api/ds-deps/workflow-tree/:processId(当天实例)
     → 上游 DepBranch(左链) + G6 TreeGraph 下游树
     → 每节点标注当天实例状态 + crontab;选中下游勾选一键级联调起
级联重跑 → POST /api/ds-deps/rerun-cascade(有实例重跑,无实例按今天新建)
```

## 4. 核心机制

- **当天窗口**:时间范围默认 `today`,即当天 00:00:00(本地时区)→ 现在的实例;`fetchLatestInstance` 支持 `today` 参数,依赖树各节点用该窗口返回当天实例状态与 crontab
- **单页分栏**:`.main-split` 左 `.left-pane`(filter + 统计概览条 + 实例表 + 分页,内部纵向滚动)、右 `.right-pane`(DsDepsPanel 依赖 DAG 面板,宽度 46%,内部独立滚动);行「依赖·级联」按钮驱动右栏加载
- **主列表项目列**:`DsTaskMonitor` process/task 表均新增「项目」列,`instProject(row)` 显示(全部项目跨项目合并的行带注入的 `_projectName`,单项目用当前筛选项目)
- **统计概览**:`stats` computed 基于当前加载实例统计 总数/运行中/成功/失败/其他
- **状态色**(与 yarn 对齐):运行中/已提交 = 蓝 `#3b82f6`;成功 = 绿;失败 = 红;暂停 = 橙;停止/已终止 = 灰(`StatusBadge`)
- **级联重跑**:按依赖树找下游实例,批量置为重跑(无实例按今天新建);**真实触发是危险操作** —— 开发验证一律用假 `instanceId=999999999`,真实重跑留给用户
- **依赖获取与更新**:`ds-deps.js` 缓存项目/工作流定义到 `data/ds-deps.json`(持久化,重启保留)。**节点 `upstream`(依赖谁)+ `downstream`(谁依赖我)双向往盘**:采集时构建反向索引,下游全貌落盘,运行时 `buildDownstreamChain` 直接读缓存并按 processId 去重,无需全量扫描。**依赖结构更新=手动刷新(`/api/ds-deps/refresh` 全量或单工作流)+ 每天自动全量一次**(`dsDepsRefreshInterval`,默认 24h,启动后 3s 首采 + 每日定时,`collecting` 锁防重入);工作流/依赖结构变化少,不频繁全量扫描。**工作流实例状态仅看当天**(00:00→现在),SUCCESS 实例进日级内存缓存(到当天结束),失败/运行中等其他状态每次实时调海豚不缓存,次日全部过期;当天无实例短 TTL 60s 缓存避免反复请求。
- **追踪 UI**:`DepBranch` 支持拖拽/折叠,节点样式统一;crontab 信息展示
- **主页面依赖 DAG 交互**:`DsDepsPanel` 浅色卡片节点标最近一次执行(去当天限制)状态与执行耗时(不显示时间点);单击「重跑」勾选参与级联、双击跳转实例;**右键节点**弹菜单:复制工作流名称 / 执行当前及以后节点(当前节点+其所有下游递归重跑);**hover** 弹开始/结束时间提示;实例匹配用工作流名 + 实例名去"-数字-数字"后缀,取最近一次
- **当日页表头排序**:`DsMonitorToday` 列(项目/名称/状态/开始/结束/时长)加 `sortable`,`@sort-change` 在前端对当前结果集升/降排序(切换视图/查询会重新 load 覆盖排序)
- **当日页项目列**:任务实例按当前筛选项目注入 `projectName`,工作流实例(单项目/全项目)注入 `_projectName`+`projectName`,独立「项目」列展示且可排序
- **当日页工作流依赖侧边栏**:任务实例行「依赖级联」按钮 → `openDeps()` 右侧滑出 `el-drawer`(72%) 画布;工作流实例视图用 `processDefinitionId` 调 `/workflow-tree/:processId`,任务实例视图用 `projectName + processInstanceId` 调新增的 `/workflow-tree-by-instance/:projectName/:processInstanceId`(后端先 `instance/query-by-id` 反查 `processDefinitionCode` 再聚合);画布内 G6 有向图(dagre)渲染**当前工作流完整上下游**,节点展示工作流名称/项目/执行状态/最近实例时间,颜色标记最新实例状态(成功绿/失败红/运行中蓝/未执行灰,含 RUNNING_EXECUTION/SUBMITTED_SUCCESS 等运行态)

## 5. 安全红线

- 重跑/停止/暂停等真实操作接口:**禁止在测试中传真实 id**,一律假 id 验证参数构造
- 依赖树遍历必须限并发、低频(遵守 api-request-discipline)

## 6. 配置

- `config.local.json`: `dsWebUrl`(海豚地址)、`dsToken`(网关注入,前端不持有 token)
