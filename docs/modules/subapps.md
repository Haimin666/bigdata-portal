# 模块:子应用 iframe(subapps)

## 1. 职责

外部系统以 iframe 嵌入门户并 tab 化保留状态:海豚调度(DS)、StreamX、JupyterLab、OMD、Stingray 等;以及登录态透传(账号密码网关注入)。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/layouts/components/SubAppView.vue` / `SubappTabs.vue` | iframe 池(v-show 保状态,关闭才销毁) |
| 配置 | `src/config/menu.ts` | `kind: 'subapp'` 菜单项(url/iframe 配置)驱动路由与 iframe |
| 网关 | `server/index.js` | 各子应用代理:DS Web、Jupyter、StreamX、OMD、Stingray、`/dolphinscheduler` |
| 网关 | `server/config.js` | `accounts.*`(子应用账号密码,网关注入) |

## 3. 子应用代理清单

| 子应用 | 挂载路径 | 说明 |
|---|---|---|
| 海豚调度 | `/dolphinscheduler`、`/apps/dsweb` | HTML 绝对路径重写;配置 DS_TOKEN 时注入 token header(项目列表即 token 用户可见) |
| JupyterLab | `/apps/jupyter` | **必须保留 base_url 前缀**(pathRewrite 加回 `/apps/jupyter/`);cookie 重写种在门户域;首次手动登录一次;jupyter 容器 host 网络监听宿主机 8888 |
| StreamX | `/apps/streamx` | 账号密码网关注入登录 |
| OMD | `/omd` | 账号密码注入 |
| Stingray | `/stingray-static`、iframe | 账号密码注入 |

## 4. 核心机制

- **iframe 池**:`SubAppView` 常驻 iframe,tab 切换仅显隐,子应用滚动/登录态/未保存内容保留
- **HTML 重写**:子应用页面内绝对路径资源(`/xxx`)重写为门户代理前缀;cookie `Domain/Path` 重写,保证 iframe 内会话生效
- **base_url 关键点**(Jupyter):express 挂载会剥前缀,必须 `pathRewrite` 加回,否则 Jupyter 收到 `/lab` 返回 404(历史踩坑)
- 登录页有"进入系统"引导;新窗口直开内网地址的场景(日志/资源管理器)不在本模块

## 5. 已知限制

- iframe 内复杂 JS 路由(React/Scala 模板页)对代理重写脆弱,优先自建 UI 或新窗口
- Jupyter 无端口映射到宿主机时浏览器不能直连,必须走门户代理
- 子应用各自鉴权(密码/token),门户不统一 SSO

## 6. 配置

- `config.local.json`: `dsWebUrl`/`dsToken`、`streamxUrl`/`accounts.streamx`、`omdUrl`/`accounts.omd`、`stingrayUrl`/`accounts.stingray`、`jupyterUrl`(容器 host 地址)
