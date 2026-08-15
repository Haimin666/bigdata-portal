# 开发助手(DevAssistant)模块

> 位置:`src/views/assistant/DevAssistantView.vue` + `src/api/assistant.ts`
> 网关:`server/index.js`(项目/文件路由 + 8787 转发代理)+ `server/assistant-projects.js`(项目存储)
> 后端:`Reasonix serve`(8787,`assistantUrl` 配置)

## 架构

```
浏览器 ── /api/assistant/* ──▶ 门户网关(Node)
  ├─ 项目/文件/会话绑定 ──▶ 本地处理(assistant-projects.js,写 data/assistant-projects.json + workspace 目录)
  └─ 会话/对话/SSE ──────▶ 代理转发(剥离 /api/assistant 前缀 → 8787,注入 Cookie: reasonix_token=<assistantToken>)
```

- 代理配置:服务器 `server/index.js` `app.use('/api/assistant', createProxyMiddleware(...))`
  - `pathRewrite: { '^/api/assistant': '' }` —— `/api/assistant/submit` → 8787 `/submit`
  - `assistantToken` 非空时注入 `Cookie: reasonix_token=<token>`(8787 token 鉴权模式)
  - 代理**不**覆盖 `/api/assistant/projects*`(项目路由先挂载,精确前缀命中后不再进代理)
- 存储:`data/assistant-projects.json`(`projects` 数组 + `sessionProjects` 会话→项目映射)
- workspace:项目目录 `projects/<项目dir>/` 落在 `assistantWorkspace`(见下)

## 配置(config.local.json)

| 键 | 说明 |
|---|---|
| `assistantUrl` | 8787 地址。生产容器:`http://host.docker.internal:8787`;本地 node:`http://127.0.0.1:8787` |
| `assistantToken` | 与 8787 的 `REASONIX_SERVE_TOKEN` 一致(取 token 后直接当 cookie 注入) |
| `assistantWorkspace` | 项目文件落盘根目录。**生产**:门户容器挂载 8787 的 workspace 卷(见 docker-compose `${ASSISTANT_WORKSPACE}`)后填容器内路径 `/app/assistant-workspace`;**本地 node**:填 8787 挂载的宿主目录(注意 mac 沙箱只能写工作区内,本地联调可指向 `data/assistant-workspace`) |

## API 清单

### A. 会话 / 对话(代理 → 8787)

| 方法 | 门户路径 | 8787 路径 | 说明 |
|---|---|---|---|
| GET | `/api/assistant/sessions` | `/sessions` | 会话列表(含 current) |
| POST | `/api/assistant/submit` | `/submit` | body `{input}`;发送消息 / 斜杠命令(`/new` 新建会话、压缩、回退、分支、模型切换) |
| POST | `/api/assistant/resume` | `/resume` | body `{path}` 切换当前会话 |
| GET | `/api/assistant/history` | `/history` | 当前会话历史(user/assistant/reasoning/toolCalls) |
| POST | `/api/assistant/cancel` | `/cancel` | 中止当前生成 |
| GET | `/api/assistant/branches` | `/branches` | 分支列表/树 |
| GET | `/api/assistant/models` | `/models` | 模型列表/当前模型 |
| GET | `/api/assistant/status` | `/status` | 状态(标签/cwd/token 用量/缓存/余额) |
| POST | `/api/assistant/approve` | `/approve` | 工具审批 `{id, allow, session, persist, scope}` |
| POST | `/api/assistant/delete-session` | `/delete-session` | body `{name}` |
| GET | `/api/assistant/events` | `/events` | SSE 事件流(见下) |

SSE 事件 `kind`:`turn_started` / `reasoning` / `text` / `message` / `turn_done` / `notice` / `tool_dispatch` / `tool_result` / `tool_progress` / `approval_request`

### B. 项目 / 文件(门户本地路由,不代理)

| 方法 | 路径 | body / 参数 | 说明 |
|---|---|---|---|
| GET | `/api/assistant/projects` | — | `{projects[], sessionProjects{}}` |
| POST | `/api/assistant/projects` | `{name}` | 建项目,自动在 workspace 建目录(`dirCreated` 标记是否成功) |
| DELETE | `/api/assistant/projects/:id` | — | 删项目(保留文件) |
| GET | `/api/assistant/projects/:id/files` | `?rel=` | 列目录(文件/文件夹条目) |
| POST | `/api/assistant/projects/:id/dir` | `{rel, name}` | 新建文件夹 |
| POST | `/api/assistant/projects/:id/file` | `{rel, name, content}` | 新建文件 |
| POST | `/api/assistant/projects/:id/upload` | `{name, contentBase64}` | 上传文件(limit 20mb) |
| PUT | `/api/assistant/projects/session` | `{sessionId, projectId}` | 会话↔项目绑定(`projectId` 空=解绑) |

**已知缺口**:
- 无 `GET /api/assistant/projects/:id/file?rel=`(读文件内容)——前端文件面板只有列表/新建/上传,**不能打开文件查看内容**;如需查看需补该路由 + `readFile()` 方法(注意路径穿越防护,复用 `_safeRel`/`_base`)
- 无文件/文件夹**删除与重命名**(用户此前提过诉求,未做)

### C. 错误码约定

| 状态 | 含义 |
|---|---|
| 400 | 名称/路径非法(空名、路径穿越) |
| 404 | 项目不存在 |
| 503 | `assistantWorkspace` 未配置或无写权限(EPERM/EACCES 时提示"生产需挂载同一 workspace 卷,或让 agent 创建") |
| 500 | 其余文件系统异常 |

## 部署注意

1. 生产门户容器必须与 8787 **共享同一 workspace 卷**,否则门户建的项目目录 agent 不可见:
   `docker-compose.yml` 已有 `${ASSISTANT_WORKSPACE:-/root/whm/DeepSeek-Reasonix/deploy/workspace}:/app/assistant-workspace`;改卷后必须 `docker compose up -d --force-recreate`(restart 不生效)
2. `config.local.json` 的 `assistantWorkspace` 填**容器内**路径 `/app/assistant-workspace`
3. 改 `assistant-projects.js`/`index.js` 项目路由后无需重启容器(代码进镜像,需重新 build);改配置/卷必须 recreate
