# 模块:YARN 应用监控(yarn)

## 1. 职责

YARN 应用列表/概览/队列、应用详情、以及 Flink/Spark 自建 UI 弹窗(替代 iframe 原生页)。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/views/yarn/YarnView.vue` | 入口:工具栏(RM 切换/筛选/刷新)、表格↔卡片切换 |
| 视图 | `src/views/yarn/AppsTable.vue` / `AppsCardView.vue` | 列表/卡片;展开行按钮:追踪UI / 资源管理器 / 终止应用 |
| 视图 | `src/views/yarn/YarnOverview.vue` | 总资源概览卡(CPU/内存/进度条)+ 队列资源 |
| 视图 | `UrlFrameDialog`(通用) | **资源管理器 iframe 弹窗**:打开 RM 原生 `/cluster/app/{appId}`(经 `/yarniframe` 同构代理,子页面/静态资源可跟随) |
| 视图 | `src/views/yarn/AppInfoLine.vue` | 单元格渲染(状态色/进度条) |
| API | `src/api/yarn.ts` | fetchApps 等,带 `X-Resource-Manager` 头 |
| Store | `src/store/yarn.ts` | 应用列表/筛选/RM 选择(`rm` 为完整 URL) |
| 网关 | `server/index.js` | `/yarniframe`(同构代理 → RM,支持 `/proxy/{appId}/` 与 `/cluster/app/{appId}`)、`/api/iframe-proxy`(动态 HTML 代理)、`/hadoopapi`(动态 RM 转发) |

## 3. 数据流

```
YarnView → store.fetchApps(GET /api/yarn/apps, 带 X-Resource-Manager)
  → RM ws/v1/cluster/apps(网关转发)
展开行 → 追踪UI:   UrlFrameDialog(/yarniframe/proxy/{appId}/)
         资源管理器: UrlFrameDialog(/yarniframe/cluster/app/{appId} → RM 原生页)
```

## 4. 核心机制

- **iframe 同构代理**:`/yarniframe/*` → RM 原样转发,页面内绝对根路径链接重写为 `/yarniframe/xxx`,子页面与静态资源可跟随;资源管理器/追踪UI 共用 `UrlFrameDialog`
- **状态色**:运行中蓝 `#3b82f6`、成功绿、失败红(StatusBadge 通用)
- 终止应用是真实操作,前端有确认;开发验证用假 appId

## 5. 历史演进(重要)

- 曾实现 **YarnResourceDialog(重建 RM UI 弹窗)+ FlinkUiDialog(5 tab)+ SparkUiDialog(4 tab)** 自建 UI,依赖 `/api/yarn-resource/{proxy,logs,log-content}` REST 转发接口
- **2026-08 已回滚移除**:自建 UI 对复杂 JS 路由页(RM 原生/Spark 时间线)重写脆弱,恢复资源管理器为 **iframe 直开 RM 原生页**;`/api/yarn-resource/*` 三个后端接口与三个组件文件一并删除(git 历史可查)

## 6. 配置依赖

- `config.local.json`: `yarnRmList`(多 RM)、`yarnProxyAllowHosts`
- 部署:客户机需能访问 RM/NM 内网
