# 模块:认证 / 用户管理(admin-auth)

## 1. 职责

平台自身账号体系(不打通子应用 SSO):登录/初始化、用户 CRUD + 角色授权。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 服务 | `server/auth.js` | 会话(portal_session cookie, 12h)、login/logout/me/init、角色守卫(requireAuth/requireAdmin)、登录 IP 限速 |
| 服务 | `server/users.js` | UserStore:`data/users.json`(scrypt 加盐哈希)、角色 admin/dev/viewer、CRUD、唯一 admin 保护 |
| 视图 | `src/views/LoginView.vue` | 登录/初始化双态(默认浅色,可切深色) |
| 视图 | `src/views/admin/UserManageView.vue` | 用户 CRUD + 模块授权 + 角色 |
| Store | `src/store/auth.ts` | 会话状态/角色/模块权限(登录后菜单按角色过滤) |
| 工具 | `src/utils/theme.ts` | 深浅色切换(`getTheme/applyTheme/toggleTheme/initTheme`,html.dark class + localStorage) |
| 路由 | `src/router/index.ts` | `/users`(meta adminOnly) |

## 3. 认证流程

```
未初始化 → /api/auth/init 创建首个 admin(同时签发会话)
登录 → POST /api/auth/login(限速 10 次/60s/IP)→ 签发 cookie
守卫 → PROTECTED_PREFIXES 内未登录 401;adminOnly 页面校验角色
```

## 5. 安全要点

- 密码 scrypt 加盐,不存明文;登录限速;弱密码校验
- 深浅色切换存 localStorage(html.dark class),默认浅色
- 会话 cookie httpOnly + sameSite=lax + 动态 secure(跟随 X-Forwarded-Proto)

## 6. 配置

- `config.local.json`: `auth.enabled`(默认 true)、`auth.sessionHours`(12);env 可用 `AUTH_ENABLED`(按布尔解析,`false` 即关闭登录门禁)
- `data/users.json` 不入 git
