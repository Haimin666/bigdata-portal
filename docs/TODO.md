# TODO 清单（暂不执行，待用户排期）

> 记录前端静态审查发现的问题。状态：`open` = 待做，`done` = 完成。
> 优先级 P1 最优先。

## P1 · 任务监控默认视图空态（"没有内容"主因）
- 文件：`src/views/ds/DsTaskMonitor.vue`
- 现象：打开"任务监控"页面列表空白，只显示空态引导"暂无工作流实例"。
- 根因链：`rangeKey` 默认 `'today'`（只查当天）+ `findDefaultProject` 只探测项目列表**前 5 个**当天是否有实例，找不到回退 `list[0]`，而 `list[0]` 当天大概率也没实例。
- 触发场景：项目多 / 凌晨打开 / 当天活跃项目排在前 5 之外。
- 可选修法：探测范围扩大 / 改选"当天实例数最多"的项目 / 空态加引导文案（如"当天无实例,可切换时间范围"）。
- 状态：open

## P2 · 任务视图「全部项目+搜索」传错参数（确定逻辑 bug）
- 文件：`src/views/ds/DsTaskMonitor.vue`，`loadAllOrOne` 精确分支（约 221-244 行）
- 根因：`h.matchedTask` 是命中的**任务名**（`src/api/dsDeps.ts` 中 `matchedTask: string`），但 task 视图查询时传 `taskName: t.processName`（工作流名）→ 后端按任务名匹配必然查不到 → 空结果。
- 正确应传 `h.matchedTask`。
- 触发场景：任务视图 + "全部项目" + 搜索。
- 状态：open

## P3 · QueryView 初始化只认 datasources，不认 allowedDbs
- 文件：`src/views/db/QueryView.vue`，`onMounted`（1963-1989 行）
- 现象：网关 acl 因角色过滤 `datasources=[]`（`allowedDbs` 有 300+）时，每次打开弹「未配置数据库源(检查网关 DB_PROXY_URL)」误导文案，且 `engine`/`db` 默认值不初始化；实际查询靠 `allowedDbs` 兜底仍可用。
- 可选修法：初始化兜底用 `allowedDbs`；文案改为"当前账号无可视数据源(网关权限过滤)"。
- 状态：open

## P4 · DsDepsPanel 共享节点误标为上游
- 文件：`src/views/ds/DsDepsPanel.vue`，`toDagData()`
- 现象：同一 `processId` 同时出现在上游树和下游树时合并节点并永久标 `isUpstream=true` → 该节点失去"重跑"勾选入口。
- 触发场景：跨路径共享节点的工作流。
- 状态：open

## P5 · 性能提示（非 bug，可选优化）
- 文件：`src/views/ds/DsTaskMonitor.vue`，`resolveYarnAppId`
- 现象：展开工作流的**每个任务**逐个发日志接口请求（限 4 路并发），任务多时瞬时请求量大。
- 状态：open