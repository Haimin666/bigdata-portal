# 模块:YARN 应用监控(yarn)

## 1. 职责

YARN 应用列表/概览/队列、应用详情、以及 Flink/Spark 自建 UI 弹窗(替代 iframe 原生页)。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/views/yarn/YarnView.vue` | 入口:工具栏(RM 切换/筛选/刷新)、表格↔卡片切换 |
| 视图 | `src/views/yarn/AppsTable.vue` / `AppsCardView.vue` | 列表/卡片;展开行按钮:追踪UI / 资源管理器 / **Flink UI** / **Spark UI**(按 `applicationType` 显隐)/ 终止应用 |
| 视图 | `src/views/yarn/YarnOverview.vue` | 总资源概览卡(CPU/内存/进度条)+ 队列资源 |
| 视图 | `src/views/yarn/YarnResourceDialog.vue` | **资源管理器重建弹窗**:应用信息 15 项 + Attempts + 容器日志(5 类文件/尾部 4KB/展开全部) |
| 视图 | `src/views/yarn/FlinkUiDialog.vue` | **Flink UI 重建**:5 tab(Jobs / Job 详情+拓扑 / Task Managers / Job Manager / Configuration) |
| 视图 | `src/views/yarn/SparkUiDialog.vue` | **Spark UI 重建**:4 tab(Jobs / Stages / Executors / Environment)+ **10s 自动刷新**(可切换) |
| 视图 | `src/views/yarn/AppInfoLine.vue` | 单元格渲染(状态色/进度条) |
| API | `src/api/yarn.ts` | fetchApps 等,带 `X-Resource-Manager` 头 |
| Store | `src/store/yarn.ts` | 应用列表/筛选/RM 选择(`rm` 为完整 URL) |
| 网关 | `server/index.js` | `/api/yarn-resource/proxy`(REST 转发,`maxBytes` 截断)、`/api/yarn-resource/logs`、`/api/yarn-resource/log-content`(pre 提取)、`/api/iframe-proxy`(动态 HTML 代理)、`/yarniframe`(同构代理) |

## 3. 数据流

```
YarnView → store.fetchApps(GET /api/yarn/apps, 带 X-Resource-Manager)
  → RM ws/v1/cluster/apps(网关转发)
展开行 → YarnResourceDialog:  /api/yarn-resource/proxy?url=<RM/proxy/{appId}/ws/v1/...>
Flink UI → FlinkUiDialog:     proxy?url=<RM/proxy/{appId}/{flink REST}>
Spark UI → SparkUiDialog:     proxy?url=<RM/proxy/{appId}/api/v1/applications/{appId}/...>
```

## 4. 核心机制

- **REST 转发统一走 `/api/yarn-resource/proxy`**:host 白名单(`yarnProxyAllowHosts`,默认 `.bigdata.shiqiao.com`)校验;`maxBytes` 参数用于大日志截断(如 32MB jobmanager.log 取前 1MB + 截断标记)
- **Flink 拓扑**:`/jobs/:jid` 的 `plan.nodes/edges` 做 BFS 分层渲染(`planLayers` computed),层间竖线+箭头;`vertices` 表展示 records/metrics
- **Spark 10s 刷新**:`setInterval(10s)`,页面可见时才刷;`refreshAll` 失败保留旧数据;404 提示"应用已结束或 RM proxy 暂不可用"(RM 对 completed 应用返回 404+HTML,`getJson` 已做 text 容错)
- **放大**:三个弹窗共用 `DialogMaxBtn`(自绘 SVG 图标按钮,主题化)
- 状态色:运行中蓝 `#3b82f6`、成功绿、失败红(StatusBadge 通用)

## 5. 已知限制

- Spark REST 仅运行中应用有效(/api/v1 无 SQL/时间线/日志 → 跳原生页)
- Flink 1.13(StreamX 旧作业)与 1.17 的 REST 字段基本兼容,`overview` 等字段名 kebab-case
- 终止应用是真实操作,前端有确认;开发验证用假 appId

## 6. 配置依赖

- `config.local.json`: `yarnRmList`(多 RM)、`yarnProxyAllowHosts`
- 部署:客户机需能访问 RM/NM 内网
