# 模块：Android 移动端（mobile）

## 1. 定位

`mobile/` 是大数据门户的独立移动端子工程，首期服务于 Android。它复用现有 Express 网关、用户权限和集群 API，不直连 YARN、DolphinScheduler、HDFS 或 db-proxy，也不在安装包中保存任何集群凭证。

首期聚焦两个高频场景：

- YARN：总览、应用筛选、详情与终止操作。
- 离线开发：任务实例查看及暂停/停止/重跑；完整 DolphinScheduler 页面通过全屏 WebView 入口访问。

## 2. 技术与目录

- Vue 3 + TypeScript + Pinia
- Ionic Vue：移动端页面、导航与交互组件
- Capacitor：Android 工程与原生容器
- Vite：开发和构建
- Node.js 22+：Capacitor CLI 8 的构建要求；Docker基础镜像不得降回Node 20

```text
mobile/
├── src/
│   ├── api/          # 复用现有网关契约的移动端请求封装
│   ├── components/   # 移动端通用状态和操作组件
│   ├── pages/        # 登录、首页、YARN、离线开发、我的
│   ├── stores/       # 登录态与页面状态
│   └── theme/        # 独立移动主题
├── android/          # Capacitor 生成的 Android 工程
└── capacitor.config.ts
```

移动页面不直接复用桌面端 Element Plus 组件。允许复用纯 TypeScript 类型、格式化函数和 API 契约，但不得让移动构建引入 Monaco、G6 或桌面 iframe 池。

## 3. 访问与认证

- 本地开发：Vite 将 `/api`、`/hadoopapi`、`/apps`、`/dolphinscheduler` 等路径代理到现有网关，沿用 `portal_session` Cookie。
- Android 生产地址固定为 `https://bigdata-portal.corp.shiqiao.com/mobile/`。用户先连接企业 VPN/零信任，Android 容器再加载该同源 HTTPS 页面；`/api`、`/hadoopapi`、`/dolphinscheduler` 与移动页面共享门户域和 `portal_session` Cookie。VPN 未连接时直接显示网络不可达，不回退公网地址，也不关闭 TLS 校验。
- 首期沿用现有 Cookie 会话，不新增或复制子系统账号。后续若引入移动 Token，网关必须将 Cookie/Bearer 统一归一为同一个调用用户与模块权限上下文。
- DolphinScheduler 完整页面仍由用户使用自己的子系统账号登录；门户不保存或注入用户密码。

## 4. 页面与操作边界

| 页面 | 首期能力 |
|---|---|
| 首页 | YARN 与当日任务摘要、失败/运行状态、快捷入口 |
| YARN | RM 选择、状态筛选、搜索、刷新、应用详情、终止应用 |
| 离线开发 | 当日实例筛选、任务节点日志分页查看/刷新/复制、暂停、停止、重跑、打开完整 DolphinScheduler |
| 我的 | 当前用户、角色、授权模块、门户连接信息、退出登录 |

危险操作（终止 YARN 应用、暂停/停止/重跑实例）必须满足：

1. 按现有模块权限和角色由网关再次校验，不能只依赖前端隐藏按钮。
2. 操作前展示目标名称和不可逆影响，并要求用户显式确认。
3. 提交期间按钮防重复点击；成功后刷新目标列表。
4. 开发和自动化验证只能使用假 ID，不得触发真实集群操作。

DolphinScheduler 实例操作虽然沿用 `/dolphinscheduler/.../executors/execute`，但必须由网关执行门禁补充拦截：viewer 禁止操作，dev/admin 还需 `dsTask` 模块权限。移动端不得绕过该门禁直连 DolphinScheduler。

## 5. 完整离线开发

完整 DolphinScheduler 使用门户现有 `/apps/dsweb/ui/#/home` 代理入口。移动端以全屏容器打开，保留 Cookie、页面历史和横屏能力；返回键优先处理页面历史，再退出完整开发页面。

首期不在移动端重写 DAG 编辑器、复杂节点配置或 DolphinScheduler 登录流程。手机竖屏主要用于查看和实例操作，DAG 编辑建议横屏。

### 实例日志

实例卡片的“查看日志”先调用 `task-list-by-process-id` 获取该工作流实例的任务节点，默认选择失败节点（没有失败节点时选择最后一个节点），再调用 `/dolphinscheduler/log/detail` 按每页 500 行读取任务实例日志。日志弹层支持切换节点、刷新、加载更多和复制全文；关闭弹层时清理日志内容，避免多个大日志长期占用手机内存。日志查看是只读能力，viewer 也允许使用。

## 6. 校验

移动端变更至少执行：

```bash
cd mobile
npm run type-check
npm run build
npx cap sync android
```

涉及危险操作时，只校验请求构造与确认流程，不使用真实应用或实例 ID。

生产 Docker 构建同时生成桌面 `dist/` 与移动 `mobile/dist/`；网关只在 `/mobile/` 托管后者，原 Web 入口 `/` 保持不变。移动 Vite 的资源基路径必须保持 `/mobile/`，否则资源会与桌面端 `/assets` 冲突。
