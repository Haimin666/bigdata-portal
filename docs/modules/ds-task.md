# 模块:任务监控(ds-task,海豚调度)

## 1. 职责

DolphinScheduler 工作流实例监控:搜索/筛选、状态色、工作流依赖图(血缘/追踪)、级联重跑、实例操作。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/views/ds/DsTaskMonitor.vue` | 主视图:项目/工作流搜索、实例列表、状态筛选(StateSelect)、行操作(暂停/停止/级联重跑/依赖) |
| 视图 | `src/views/ds/DsDepsDialog.vue` | 依赖弹窗:获取工作流依赖(手动/自动) |
| 视图 | `src/views/ds/DepBranch.vue` | 追踪 UI:依赖树渲染(ECharts tree/链式,节点可拖拽/折叠;支持深链 DS 编辑) |
| API | `src/api/ds.ts` / `src/api/dsDeps.ts` | 实例列表/操作/依赖树 |
| 网关 | `server/index.js` | `/api/ds-*` 转发海豚(dsToken)、`/api/ds-deps`(缓存) |
| 服务 | `server/ds-deps.js` | 依赖树聚合:项目/工作流/最近实例(缓存 `data/ds-deps.json`,默认 1h 刷新) |

## 3. 数据流

```
DsTaskMonitor → GET /api/ds/process-instances(海豚 API, dsToken)
行操作 → POST /api/ds/... (执行/暂停/停止)
依赖 → DsDepsDialog → /api/ds-deps/workflow-tree/:processId(最近一天实例)
     → DepBranch(ECharts 树/链路渲染)
     → 双模式切换:工作流血缘(上游/下游,可级联重跑)/ 任务血缘(工作流内任务 DAG,GET /api/ds-deps/task-graph/:processId,G6 dagre 渲染)
级联重跑 → POST /api/rerun-instances(实例 + 下游级联)
```

## 4. 核心机制

- **状态色**(与 yarn 对齐):运行中/已提交 = 蓝 `#3b82f6`;成功 = 绿;失败 = 红;暂停 = 橙;停止/已终止 = 灰(`StatusBadge`)
- **级联重跑**:按依赖树找下游实例,批量置为重跑;**真实触发是危险操作** —— 开发验证一律用假 `instanceId=999999999`,真实重跑留给用户
- **依赖获取**:`ds-deps.js` 缓存项目/工作流/实例,避免频繁请求海豚;依赖只展示近一天实例
- **追踪 UI**:`DepBranch` 支持拖拽/折叠,节点样式统一;crontab 信息展示

## 5. 安全红线

- 重跑/停止/暂停等真实操作接口:**禁止在测试中传真实 id**,一律假 id 验证参数构造
- 依赖树遍历必须限并发、低频(遵守 api-request-discipline)

## 6. 配置

- `config.local.json`: `dsWebUrl`(海豚地址)、`dsToken`(网关注入,前端不持有 token)
