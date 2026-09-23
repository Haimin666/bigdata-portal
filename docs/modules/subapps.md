# 模块:子应用 iframe(subapps)

## 1. 职责

外部系统以 iframe 嵌入门户并 tab 化保留状态:海豚调度(DS)、StreamX、JupyterLab、OMD、Stingray、Datadeck Agent 等。

> **多用户体系上线后(2026-08)已移除共享账号自动登录**:原 `/api/login/*` 端点、`config.accounts.*`、前端 `loginToService()` 与菜单 `login` 字段全部删除;iframe 直接挂载,由每个用户用自己在子系统中的账号在页面内登录。门户不再持有/注入任何子系统凭证。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/views/subapp/SubAppView.vue` / `src/layouts/components/SubappTabs.vue` | iframe 池(v-show 保状态,关闭才销毁);Tab 外观按门户统一壳层主题 |
| 配置 | `src/config/menu.ts` | 统一模块注册表;`kind: 'subapp'` 项的 url/iframe 配置同时驱动菜单、路由与 iframe |
| 网关 | `server/routes/subapps-proxy.js` 各子应用代理:DS Web、Jupyter、DolphinScheduler、Stingray、`/dolphinscheduler`(纯代理,无登录注入);`server/routes/assistant.js` Datadeck Agent 同源代理;`server/routes/ws-proxy.js` WebSocket 代理 |

## 3. 子应用代理清单

| 子应用 | 挂载路径 | 说明 |
|---|---|---|
| 海豚调度 | `/dolphinscheduler`、`/apps/dsweb` | HTML 绝对路径重写;配置 DS_TOKEN 时注入 token header(项目列表即 token 用户可见) |
| JupyterLab | `/apps/jupyter` | **必须保留 base_url 前缀**(pathRewrite 加回 `/apps/jupyter/`);cookie 重写种在门户域;首次手动登录一次;jupyter 容器 host 网络监听宿主机 8888 |
| StreamX | `/apps/streamx` | 跨源直连(用户自行登录) |
| OMD | `/omd` | 跨源直连(用户自行登录) |
| Stingray | `/stingray-static`、iframe | 同源代理 + 路由注入(用户在页面内登录,cookie 种在门户域) |
| Datadeck Agent | `/agent` | 页面、`/assets`、`/uploads` 代理到 Datadeck;`/api/*` 仅在请求 Referer 属于 `/agent` 时转发,门户其他接口不变;门户登录及 `devAssistant` 模块权限门禁;沿用 Datadeck GoAI `user_id` 登录 |

## 4. 核心机制

- **iframe 池**:`SubAppView` 常驻 iframe,tab 切换仅显隐,子应用滚动/登录态/未保存内容保留;原生视图由 `active` 属性控制后台轮询。`MainLayout` 使用垂直内容容器，避免顶栏与 iframe 横向挤压。
- **统一模块权限**:菜单/路由由前端用户权限过滤；`/apps/*`、`/dolphinscheduler`、`/api/mail/*` 等代理由网关按同一 `modules` 白名单再次校验，禁止直接 URL 绕过。
- **HTML 重写**:子应用页面内绝对路径资源(`/xxx`)重写为门户代理前缀;cookie `Domain/Path` 重写,保证 iframe 内会话生效
- **base_url 关键点**(Jupyter):express 挂载会剥前缀,必须 `pathRewrite` 加回,否则 Jupyter 收到 `/lab` 返回 404(历史踩坑)
- **Datadeck 同源代理**:其前端使用根路径 `/assets`、`/uploads` 与 `/api`;门户通过 `/agent` 加载页面,并按 iframe Referer 将 Datadeck API 与门户 API 区分,资源文件在门户静态目录未命中时回退到 Datadeck。这样不需要修改/重建 Datadeck,同时避免 HTTPS 页面加载 HTTP 混合内容
- 登录页有"进入系统"引导;新窗口直开内网地址的场景(日志/资源管理器)不在本模块

## 5. 已知限制

- iframe 内复杂 JS 路由(React/Scala 模板页)对代理重写脆弱,优先自建 UI 或新窗口
- Jupyter 无端口映射到宿主机时浏览器不能直连,必须走门户代理
- 子应用各自鉴权(密码/token),门户不统一 SSO;Datadeck Agent 使用 GoAI `user_id` 入口登录,门户代理仍校验门户登录态及 `devAssistant` 模块权限

## 6. 配置

- `config.local.json`: `dsWebUrl`/`dsToken`、`streamxUrl`、`omdUrl`、`stingrayUrl`、`jupyterUrl`(容器 host 地址)、`datadeckUrl`(Datadeck Agent 地址,默认 `http://host.docker.internal:8000`);~~accounts.*~~ 已随自动登录移除
