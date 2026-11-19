# 模块:认证 / 用户管理(admin-auth)

## 1. 职责

平台自身账号体系(不打通子应用 SSO):登录/初始化、用户 CRUD + 角色授权。

模块权限由用户管理页统一配置：用户的 `modules` 非空时覆盖角色模块列表，
为空时继承角色；前端菜单/路由与网关代理/API 使用同一份模块白名单。
认证关闭时不读取用户权限，前端仅使用服务端 `enabledModules` 配置；服务端为空表示全部模块。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 服务 | `server/auth.js` | 会话(portal_session cookie, 12h)、login/logout/me/init、角色守卫(requireAuth/requireAdmin)、登录 IP 限速 |
| 服务 | `server/users.js` | UserStore:`data/users.json`(scrypt 加盐哈希)、角色 admin/dev/viewer、CRUD、唯一 admin 保护 |
| 视图 | `src/views/LoginView.vue` | 登录/初始化双态(默认浅色,可切深色) |
| 视图 | `src/views/admin/UserManageView.vue` | 统一桌面壳层的用户管理工作台:用户 CRUD、模块授权、数据权限和数据库连接管理标签；表体在固定内容区内滚动 |
| 视图/API | `src/views/admin/DbConnectionView.vue`、`src/api/db-connections.ts` | MySQL/Oracle/Doris 连接 CRUD 与测试；浏览器只访问门户 API |
| 网关 | `server/routes/db-config.js` | admin-only；服务端注入独立 `dbProxyAdminToken`，转发到 db-proxy 管理 API |
| Store | `src/store/auth.ts` | 会话状态/角色/模块权限(登录后菜单按角色过滤) |
| 工具 | `src/utils/theme.ts` | 深浅色切换(`getTheme/applyTheme/toggleTheme/initTheme`,html.dark class + localStorage) |
| 前端模块 | `src/config/menu.ts` | 菜单、路由、组件与子应用地址的统一注册表 |
| 路由 | `src/router/index.ts` | `/users`(meta adminOnly) |

## 3. 认证流程

```
未初始化 → /api/auth/init 创建首个 admin(同时签发会话)
登录 → POST /api/auth/login(限速 10 次/60s/IP)→ 签发 cookie
守卫 → PROTECTED_PREFIXES 内未登录 401;adminOnly 页面校验角色；模块代理/API 同时校验模块白名单
```

## 5. 安全要点

- 密码 scrypt 加盐,不存明文;登录限速;弱密码校验
- 模块权限由用户管理页统一维护；后端对执行接口、HTTP 子应用代理及 Stingray/Jupyter WebSocket 再次校验，不能仅依赖前端隐藏菜单。DolphinScheduler 完整 UI 要求 `ds`，移动 API 读取允许 `dsTask` 或 `ds`。
- 深浅色切换存 localStorage(html.dark class),默认浅色
- 用户管理与数据库权限矩阵的表体独立滚动，工具栏/Tab 保持固定，避免大数据量把整页向下撑开
- 用户管理页与数据权限页复用 `TableToolbar` 的刷新/密度交互、主题 token 和 loading 状态；错误保留页内重试入口，不用整页遮罩
- 数据库连接管理位于用户管理页，仅管理员可用；此 API 在门户认证关闭时也 fail-closed。门户后端代理到 db-proxy；密码不回显，修改时密码留空表示保留。连接测试由 db-proxy 主机执行，只读探测 MySQL/Doris `SELECT 1` 或 Oracle `SELECT 1 FROM dual`。
- db-proxy 管理凭证 `dbProxyAdminToken` 与查询凭证 `dbProxyToken` 分开保存在服务端配置，不下发浏览器；数据源修改落到 db-proxy `datasources.json` 并热重载。CSV 只用于显式首次导入。
- 会话 cookie httpOnly + sameSite=lax + 动态 secure(跟随 X-Forwarded-Proto)

## 6. 配置

- `config.local.json`: `auth.enabled`(默认 true)、`auth.sessionHours`(12);env 可用 `AUTH_ENABLED`(按布尔解析,`false` 即关闭登录门禁)
- `data/users.json` 不入 git
