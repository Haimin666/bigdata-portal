# bigdata-portal Agent 开发指南

> 给 AI agent / 新开发者的完整上手文档:架构、启动、代理链路、历史踩坑、配合规则。
> 开发前必读第 6、7、8 节,踩过的坑不要重复踩。

## 1. 项目概览

大数据统一门户:聚合 **YARN 监控**、**HDFS 文件浏览**(原生 Vue 视图)与 **海豚调度 / Stingray / OMD / StreamX**(iframe 嵌入)四个子系统。

- 主应用:Vue 3 + Vite 5 + TypeScript + Element Plus + Pinia + vue-router
- 网关:Node(Express),静态托管 + 反向代理,单进程部署(端口 3000);子应用自动登录已随多用户体系移除(2026-08)
- 前端 dev:Vite,端口 3002,代理到网关

## 2. 架构

```
浏览器
 ├─ /yarn、/hdfs      → 原生 Vue 视图(自建 UI,调网关 API)
 ├─ /ds(海豚)         → 原生 iframe → 同源代理 /apps/dsweb + /dolphinscheduler
 ├─ /query(Stingray)  → 原生 iframe → 同源代理 /apps/stingray(+ 路由注入)
 ├─ /omd              → 原生 iframe → 跨源直连 https://omd.corp.shiqiao.com
 └─ /streamx          → 原生 iframe → 跨源直连 https://streamx.corp.shiqiao.com
       │
       ▼
Vite(3002,ws:true 代理)→ Express 网关(3000)
       ├─ /hadoopapi       → YARN RM(按 X-Resource-Manager 请求头动态代理)
       ├─ /webhdfs         → HDFS NameNode(WebHDFS REST API)
       ├─ /static          → HDFS 静态资源
       ├─ /apps/dsweb      → 海豚(HTML 代理)
       ├─ /dolphinscheduler→ 海豚资源/API 绝对路径代理
       ├─ /apps/stingray   → Stingray HTML(重写 /static/ + 路由注入)
       ├─ /stingray-static → Stingray 静态资源
       ├─ /__/stingray     → Stingray API + WebSocket(查询日志实时推送)
       ├─ /api/config      → 配置下发(RM/HDFS/DS/OMD/Stingray 地址;原 /api/login/* 已移除)
       └─ 静态托管 dist/
```

**不再使用 wujie**(已移除):老系统统一用原生 iframe(见第 6 节与第 8 节踩坑记录)。

## 3. 目录结构

```
bigdata-portal/
├── src/
│   ├── main.ts / App.vue / index.html
│   ├── router/index.ts          # 菜单表驱动路由(native + subapp)
│   ├── config/
│   │   ├── menu.ts              # 菜单 + 子应用适配(url/iframe/login/icon)
│   │   └── yarn.ts              # YARN 常量
│   ├── layouts/MainLayout.vue   # 侧栏 + 顶栏(刷新/全屏)
│   ├── views/
│   │   ├── yarn/                # YARN 原生视图
│   │   ├── hdfs/HdfsView.vue    # HDFS 文件浏览器(WebHDFS)
│   │   └── subapp/              # Tab 常驻池相关(原生视图 + 子应用共用)
│   │       ├── SubAppView.vue   # iframe 内容组件(原生 iframe 直挂,常驻不卸载;自动登录已移除)
│   │       └── SubappTabs.vue   # 顶部 Tab 条(切换/关闭,关闭即销毁组件/iframe)
│   ├── api/yarn.ts / hdfs.ts / auth.ts
│   ├── store/yarn.ts
│   └── types/ utils/ styles/
├── server/
│   ├── index.js                 # Express 网关(代理/登录/config/WebSocket)
│   ├── config.js                # 读 server/config.local.json(唯一配置源)
│   ├── config.local.example.json# 配置模板(复制为 config.local.json 使用)
│   ├── config.local.json        # 实际配置(gitignore 不入库,含账号/令牌)
├── scripts/dev.mjs              # 一键启动:网关 + Vite
├── vite.config.ts               # dev 代理(ws:true)
├── package.json / tsconfig.json / Dockerfile
└── docs/AGENTS.md               # 本文档
```

## 4. 启动与开发

```bash
npm install          # 首次(注意 package.json 已移除 wujie-vue3)
npm run dev          # 一键:网关(3000)+ Vite(3002)
# 或分开:
npm run dev:gateway  # 网关
npm run dev:vite     # 前端
```

- 访问 http://localhost:3002
- 修改 `server/*.js`、`vite.config.ts` 需重启网关(`npm run dev` 的网关进程不会热重载,杀掉重跑)
- 修改 `src/*` 由 Vite HMR 热更新;改 `src/config/menu.ts` 会整页 reload
- 提交前必须:`npx vue-tsc --noEmit` 与 `npm run build`

## 5. 配置与凭证

**配置唯一来源:`server/config.local.json`**(已 gitignore,不入库)。启动时优先读该 JSON,缺省字段回退环境变量/默认值;已不读取 `.env.local`。

| JSON 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | `3000` | 网关端口(显式环境变量 `PORT` 优先) |
| `yarnRmList` | `http://hadoop-nn-1...:8088` | RM 列表(逗号分隔) |
| `hdfsUrl` | `http://hadoop-nn-1...:9870` | HDFS NameNode |
| `dsWebUrl` | `http://olds.../dolphinscheduler` | 海豚 |
| `omdUrl` | `https://omd.corp.shiqiao.com` | OMD |
| `stingrayUrl` | `http://stingray.corp.shiqiao.com` | Stingray |
| `accounts.dsWeb.user/pass` | — | ~~海豚自动登录凭证~~ 已移除 |
| `dsToken` | — | 海豚 API token:网关 `/dolphinscheduler` 代理自动注入 `token` header,项目列表即该 token 用户可见;任务监控/海豚 UI 免登录均依赖它 |
| `accounts.stingray.user/pass` | — | ~~Stingray 自动登录凭证~~ 已移除 |
| `OMD_USER/PASS` | — | ~~OMD 凭证~~ 已移除 |

**凭证规则**:
- 敏感凭证只放 `server/config.local.json`,**禁止写死进代码/提交 git**(gitignore 已忽略)
- 多用户体系上线后,门户不再持有任何子系统凭证;各用户在子系统页面内自行登录

## 6. 子应用接入方式

`src/config/menu.ts` 的 MenuItem 字段:`kind`('native'|'subapp')、`url`、`iframe`(原生 iframe)、`icon`(原 `login` 字段已随自动登录移除)。

| 菜单 | 方式 | url | 说明 |
|---|---|---|---|
| YARN | native | /yarn | 原生视图 |
| HDFS | native | /hdfs | 自建 WebHDFS 文件浏览器 |
| 海豚 ds | iframe 同源 | /apps/dsweb/ui/#/home | 网关代理,用户在页面内登录 |
| Stingray query | iframe 同源 | /apps/stingray/login | 网关代理 + 路由注入 + ws,用户在页面内登录 |
| OMD | iframe 跨源 | https://omd.corp.shiqiao.com/ | 直接嵌入,用户域内登录 |
| StreamX | iframe 跨源 | https://streamx.../#/login?... | 直接嵌入 |

- **同源 iframe**:url 为代理路径(/apps/... 等),iframe 同源读取门户域 cookie;不再自动登录
- **跨源 iframe**:url 为绝对 https 地址,用户在 iframe 内登录;跨源 iframe **无法被门户注入任何脚本**(同源策略)

## 7. 网关代理清单(server/index.js)

| 前缀 | 目标 | 要点 |
|---|---|---|
| /hadoopapi | RM(动态) | 需 `X-Resource-Manager` header,pathRewrite 去前缀 |
| /webhdfs | HDFS | **pathRewrite `^/` → `/webhdfs/`**(express 剥前缀后加回) |
| /static | HDFS | 静态资源 |
| /apps/dsweb | 海豚 | iframeProxy |
| /dolphinscheduler | 海豚 | **target 用 dsWebUrl 的 origin + pathRewrite 加回**(海豚资源/API 绝对路径) |
| /apps/stingray | Stingray | HTML 重写 `/static/`→`/stingray-static/static/` + **React 路由注入** |
| /stingray-static | Stingray | 静态资源 |
| /__/stingray | Stingray | API + **WebSocket**(server.on('upgrade') 手动代理) |
| /api/config | 本地 | 配置下发 |
| /api/login/{ds,stingray,omd} | 各系统 | createLoginEndpoint(transport: form/query/json + passwordEncode) |

**所有 `createProxyMiddleware` 必须用 `on: { proxyRes }` 写法**(v3 不再支持顶层 `onProxyRes`)。
**代理路径不经过 `express.json()`**(见踩坑 #2)。

## 8. 开发踩坑记录(必读,每条都是血泪)

1. **http-proxy-middleware v3 的 `onProxyRes` 顶层选项废弃**
   必须 `on: { proxyRes: fn }`。旧写法静默失效 → cookie 重写/x-frame 删除/location 重写全部不生效。`onProxyRes` 回调里 `delete proxyRes.headers['x-frame-options']` 才能删除 iframe 嵌入限制。

2. **`express.json()` 消费请求体 → 代理 POST/PUT 挂起超时**
   `app.use(express.json())` 读空请求流后,http-proxy-middleware 转发时 Content-Length 与实际数据不匹配,下游等 body 永远等不到。**修复**:代理前缀(PROXY_PATHS)跳过 body 解析,仅 /api 本地端点解析。

3. **`SameSite=None` 必须配 `Secure`,否则浏览器拒绝整个 cookie**
   曾把自动登录 cookie 重写为 `SameSite=None` 又删掉 Secure → Chrome 直接丢弃 Set-Cookie → 所有自动登录"看似成功实则没种上" → 子系统误判未登录白屏。**同源代理场景保持默认 SameSite 即可,不要画蛇添足。**

4. **老系统前端靠 JS 读 cookie(HttpOnly 读不到)**
   海豚前端用 js-cookie 读 `sessionId` 放请求头。cookie 必须去 HttpOnly 且同源可见。wujie 沙箱 iframe 读不到主应用 cookie → 白屏(见 #6)。

5. **express 挂载中间件会剥掉挂载前缀**
   `app.use('/webhdfs', proxy)` 后 `req.url` 已无 /webhdfs。**需要 `pathRewrite: { '^/': '/webhdfs/' }` 加回**,否则 HDFS 收到 /v1/... 404。同理 /dolphinscheduler(/apps/dsweb 是 target 自带前缀所以碰巧正确)。

6. **wujie 已弃用,原因**:wujie 沙箱 iframe 读不到主应用 cookie → 海豚/Stingray 白屏;degrade 模式又不注入 `__WUJIE` → wujie-vue3 `syncUrlToWindow` 崩溃。**老系统一律原生 iframe。**

7. **React Router `basename="/"` 与代理前缀冲突 → 白屏**
   Stingray 经 /apps/stingray 代理后 pathname 不匹配路由 → catch-all 404 白屏。**修复**:网关在 HTML 注入 `history.replaceState(history.state,'',pathname去掉前缀)`,React 加载前执行。

8. **WebSocket 代理双监听 → Invalid frame header**
   http-proxy-middleware 开 `ws:true` 会自动订阅 server 'upgrade',再加手动 `server.on('upgrade')` 会**双转发污染帧数据**。**修复**:http-proxy-middleware 一律不开 ws,用底层 `http-proxy` 库显式处理 upgrade;vite 代理需 `ws: true`。

9. **双前缀 bug(createLoginEndpoint)**
   `target + loginPath` 拼接,海豚 target 已含 `/dolphinscheduler`,loginPath 只写 `/login`(勿再带前缀)。曾导致 /api/login/ds 请求到 `.../dolphinscheduler/dolphinscheduler/login` → parse error。

10. **各系统登录格式各不相同**
    - 海豚:`POST /dolphinscheduler/login`,**form 格式**(userName/userPassword)
    - Stingray:`POST /__/stingray/authc/login?username=&password=`(**query 参数** + 必须带 `Content-Type: application/json;charset=UTF-8` header,否则"处理失败")
    - OMD(OpenMetadata):`POST /api/v1/users/login`,body `{email, password: base64(密码)}`(密码需 base64 编码,否则 400)
    - Stingray 密码实际带句点:`Hedge654123.`(用户最初给的不带点导致登录失败)

11. **OMD 跨源 iframe 无法注入表单**(同源策略);同源代理也不可行:OMD webpack `publicPath` 硬编码 `/`,344 个 chunk 根路径加载,与门户路径全面冲突。**如需 OMD 自动填充只能靠浏览器密码管理器。**

12. **OMD 登录有风控**:连续失败触发锁定(`Failed Login Attempts Exceeded`),调试最多试 3 次,不通询问用户(见记忆 omd-login-risk-control)。

13. **配置唯一来源 `server/config.local.json`**(server/config.js 启动时读取,已不再加载 .env.local)。改配置后需重启网关(dev 一键脚本里网关是独立进程,不会自动重启)。

14. **Node 24 的噪音警告处理**:`util._extend` 来自 http-proxy@1.18.1(已停维护),启动参数加 `--no-deprecation` 抑制;`MaxListenersExceededWarning` 由 http-proxy-middleware v3 每个代理实例注册 close 监听导致,`EventEmitter.defaultMaxListeners = 20` 放宽。

15. **iframe 状态保留不能靠 `<KeepAlive>`**:KeepAlive 缓存组件时会 detach DOM,iframe 一旦脱离文档即被浏览器销毁,切回照样重载。子应用状态保留必须让 iframe 常驻挂载,用 `v-show`(display:none)隐藏非激活项;关闭 tab 时才真正卸载释放。子应用路由组件因此改为空壳(`render: () => null`)。原生视图(YARN/HDFS/任务监控)也统一进 Tab 常驻池(组件常驻 `v-show` 切换,`refreshKey` 供顶栏刷新重建),MainLayout 不再用 router-view 渲染内容。

## 9. 与开发人员的配合规则

1. **凭证安全**:密码只写 `server/config.local.json`(gitignore),绝不硬编码进源码或提交;查看/修改凭证前先确认不泄露。
2. **OMD 登录调试**:最多 3 次,3 次不通停止,用 ask 询问用户(风控会锁账号)。
3. **内网系统验证**:YARN/HDFS/海豚/Stingray/OMD 均为内网,改动代理后必须重启网关并用 curl 实测链路(资源 200、登录 API 行为),不能只改代码不验证。
4. **服务运行**:开发调试时保持 `npm run dev` 后台运行(bash background job),修改 server 代码后重启网关进程再验证。
5. **不要引入新依赖**(除非必要):项目零依赖实现 .env 加载、WebSocket 代理等,保持可离线构建。
6. **提交前**:`npx vue-tsc --noEmit` + `npm run build` 必须通过。
7. **文档同步**:新增/修改代理、菜单、接入方式后,同步更新 README 与本文档。
8. **回归检查**:改完一个子系统,确认其它子系统/页面不回归(全链路资源可达 + 登录可用)。

## 10. 验证清单(内网)

1. `/api/config` 返回各系统地址;`/api/login/ds` 返回 ok:true + Set-Cookie(无 HttpOnly)
2. `/apps/dsweb/ui/` 与 `/dolphinscheduler/ui/css/...` 200;带 sessionId 请求海豚 API 过认证
3. `/apps/stingray/login` 200(含路由注入脚本);`/stingray-static/static/...` 200
4. Stingray ws:`ws://localhost:3002/__/stingray/log/xxx` 能 OPEN(提交 SQL 查询)
5. `/webhdfs/v1/?op=LISTSTATUS` 返回 JSON;HDFS 页面可列目录/翻页/路径定位
6. YARN `/hadoopapi/ws/v1/cluster/apps`(带 X-Resource-Manager)返回列表,kill 可 PUT
7. `/omd`、`/streamx` iframe 加载对应系统登录页
