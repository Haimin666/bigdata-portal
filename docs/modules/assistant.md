# 开发助手(DevAssistant)模块

> Web 桌面端使用门户同源 `/agent?user_id=1030437` 嵌入 Datadeck Agent。Android APK 使用专门的移动对话界面，经门户受控 API 代理复用 Datadeck 的 Agent、会话、Run 和 SSE 流。

## 当前入口

- Web 菜单项 `devAssistant` 使用 `kind: 'subapp'` + `iframe: true`,不再渲染门户内置 `DevAssistantView.vue`；APK 有独立原生聊天页面，不嵌套桌面 UI。
- Web 页面用 `user_id=1030437` 完成 Datadeck 登录交换；APK 由门户移动助手代理固定该用户身份进行 token 交换，token 只保存在移动页面内存中，并随后续受限 API 请求发送。
- Web iframe 为同源反向代理,门户控制登录与模块访问;Datadeck 页面负责 Web 端完整会话和消息体验。APK 调用同一 Datadeck 服务端 API,由门户受控代理保护访问,用 Datadeck Run SSE 增量更新手机消息气泡。
- 旧的 `/api/assistant/*` Reasonix 代理、项目文件路由和 `src/views/assistant/DevAssistantView.vue` 暂保留,作为后续切回或适配 Datadeck API 时的代码资产,当前入口不调用。

## 视觉边界

- Web 端 Datadeck Agent 自己管理历史对话、欢迎态、消息流和输入区。
- APK 使用独立移动聊天界面：底部固定输入栏、流式消息、最近会话抽屉、停止/重试和键盘适配；复杂工具审批提示用户转到 Web 助手处理。对话能力调用同一 Datadeck API，不嵌套桌面 UI。

## Android API 代理

`/api/mobile/assistant/*` 只允许门户已登录且有 `devAssistant` 模块权限的用户访问。网关固定映射到 Datadeck GoAI 用户 `1030437`，并对白名单 API 做路径和 HTTP 方法限制：默认 Agent、会话列表/创建、历史、Run 创建/查询/取消和 SSE 事件流。任意管理 API、文件 API 不通过该入口暴露。SSE 响应由代理直接流式转发，移动端解析 `messages` 增量并恢复到当前回答气泡。

## 旧版 Reasonix 代理架构(保留,当前入口未使用)

```
浏览器 ── /api/assistant/* ──▶ 门户网关(Node)
  ├─ 项目/文件/会话绑定 ──▶ 本地处理(assistant-projects.js,写 data/assistant-projects.json + workspace 目录)
  └─ 会话/对话/SSE ──────▶ 代理转发(剥离 /api/assistant 前缀 → 8787,注入 Cookie: reasonix_token=<assistantToken>)
```

- 代理配置:服务器 `server/routes/assistant.js` `app.use('/api/assistant', createProxyMiddleware(...))`
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
| GET | `/api/assistant/projects/:id/file` | `?rel=` | **读文件内容**(文本返回 `content`;二进制返回 `{binary:true,size}`,黑名单扩展名拦截) |
| PATCH | `/api/assistant/projects/:id/file` | `{rel, name, newName}` | **重命名/移动文件**(目标存在返回 409) |
| DELETE | `/api/assistant/projects/:id/file` | `?rel=` | **删除文件或空目录**(非空目录 409) |
| POST | `/api/assistant/projects/:id/dir` | `{rel, name}` | 新建文件夹(已存在 409) |
| POST | `/api/assistant/projects/:id/file` | `{rel, name, content}` | 新建文件(已存在 409;自动递归创建父目录) |
| POST | `/api/assistant/projects/:id/upload` | `{name, contentBase64}` | 上传文件(base64 严格校验,≤10MB,同名 409) |
| PUT | `/api/assistant/projects/session` | `{sessionId, projectId}` | 会话↔项目绑定(`projectId` 空=解绑) |

**鉴权(2026-08 加固)**:`/api/assistant` 已加入 `PROTECTED_PREFIXES`(未登录 401);项目/文件/目录/上传/会话绑定等写操作(POST/PUT/PATCH/DELETE)纳入 `EXEC_GATES`(module `assistant`,viewer 一律 403,配置了模块白名单的用户需含 `assistant`)。所有落盘路径经 `_resolve()` 的 `path.resolve` + `path.relative` 双重校验,项目名 `.`/`..` 直接拒绝,杜绝逃逸 `assistantWorkspace`。

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
