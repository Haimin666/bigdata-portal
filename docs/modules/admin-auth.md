# 模块:认证 / 用户管理 / 主题设置(admin-auth)

## 1. 职责

平台自身账号体系(不打通子应用 SSO):登录/初始化、用户 CRUD + 角色授权、管理端全局主题设置(字体/颜色)。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 服务 | `server/auth.js` | 会话(portal_session cookie, 12h)、login/logout/me/init、角色守卫(requireAuth/requireAdmin)、登录 IP 限速、**主题路由 /api/theme(GET 登录 / PUT admin)** |
| 服务 | `server/users.js` | UserStore:`data/users.json`(scrypt 加盐哈希)、角色 admin/dev/viewer、CRUD、唯一 admin 保护 |
| 视图 | `src/views/LoginView.vue` | 登录/初始化双态(默认浅色,可切深色) |
| 视图 | `src/views/admin/UserManageView.vue` | 用户 CRUD + 模块授权 + 角色 |
| 视图 | `src/views/admin/ThemeSettingsView.vue` | **主题设置(admin)**:字体栈 + 浅/深各 7 色,实时预览工作台,重置按钮在深浅色块内部 |
| Store | `src/store/auth.ts` | 会话状态/角色/模块权限(登录后菜单按角色过滤) |
| 工具 | `src/utils/theme.ts` | 主题切换 + 管理端覆盖注入(`readCssVarSet` 读真实默认 / `applyThemeOverrides` 注入 style / `clearThemeOverrides`) |
| 路由 | `src/router/index.ts` | `/users`、`/theme`(meta adminOnly) |

## 3. 认证流程

```
未初始化 → /api/auth/init 创建首个 admin(同时签发会话)
登录 → POST /api/auth/login(限速 10 次/60s/IP)→ 签发 cookie
守卫 → PROTECTED_PREFIXES 内未登录 401;adminOnly 页面校验角色
```

## 4. 主题体系(重点)

- **默认值**:`variables.scss` `:root`(浅)/`html.dark`(深)两套 `--bd-*` 变量;`readCssVarSet` 从 getComputedStyle 读**真实默认**(含 rgba border)
- **管理端覆盖**:`data/theme.json`(PUT 仅 admin,font/color 消毒:font 白名单字符、color 正则 `#hex|rgba`),启动时 `loadThemeOverrides` 注入 `<style id="bd-theme-overrides">`,空字段不注入 = 用 scss 默认
- **重置**:浅/深色块内各自"重置 X 色"= 读真实默认回填 + 预览(保存后生效);无 theme.json 时页面展示的就是真实默认
- **放大按钮**:弹窗全屏按钮 `DialogMaxBtn`(自绘 SVG,主题化,保证任意主题可见)

## 5. 安全要点

- 密码 scrypt 加盐,不存明文;登录限速;弱密码校验
- 主题 PUT 仅 admin;CSS 变量注入值已消毒(防 CSS 注入)
- 会话 cookie httpOnly + sameSite=lax + 动态 secure(跟随 X-Forwarded-Proto)

## 6. 配置

- `config.local.json`: `auth.enabled`(默认 true)、`auth.sessionHours`(12)
- `data/users.json` 不入 git
