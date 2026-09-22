# 模块:数据同步代码生成(sync)

## 1. 职责

输入源数据库名和表名，调用网关生成 db2hive SQL 与 JSON 配置，并支持复制。

## 2. 涉及文件

| 层 | 文件 | 说明 |
|---|---|---|
| 视图 | `src/views/sync/SyncCodeView.vue` | 输入表单、SQL/JSON 结果面板与复制操作 |
| 路由 | `src/config/menu.ts` | `/sync` 原生模块入口，受 `enabledModules`/用户模块权限控制 |
| 网关 | `/api/sync/db2hive` | 接收 `db_name`、`table_name` 并返回 SQL/JSON 代码 |

## 3. 响应式布局

- 桌面端表单为源库名、表名和生成操作的单行布局，生成结果为 SQL/JSON 双栏。
- ≤640px 时两个输入控件各占半行并允许收缩，生成按钮占满一行；代码面板改为纵向排列，长 SQL/JSON 在面板内滚动。
- 页面级别不得产生横向溢出，结果代码允许在各自代码框内横向滚动。

## 4. 权限与测试限制

- 模块是否可访问由门户统一模块白名单决定，不通过临时放开路由或伪造权限进行视觉测试。
- 浏览器请求使用 `portal_session` 且要求 `sync` 模块权限；配置 `syncApiToken` 后，机器调用可用 `X-API-Token` 访问 `/api/sync/*`，无需 Cookie。无效 Token 不旁路登录门禁。
- 若本地 `enabledModules` 未包含 `sync`，窄屏验证改为静态检查与构建校验，并注明无法执行页面级浏览器回归。
