# 模块：Android 移动端（mobile）

## 1. 定位

`mobile/` 是大数据门户的独立移动端子工程，首期服务于 Android。它复用现有 Express 网关、用户权限和集群 API，不直连 YARN、DolphinScheduler、HDFS 或 db-proxy，也不在安装包中保存任何集群凭证。

首期聚焦两个高频场景：

- YARN：总览、应用筛选、详情与终止操作。
- 离线开发：项目、工作流、工作流详情、近两天工作流/任务实例的移动只读浏览，以及工作流发布/启动、定时上下线、实例停止/重跑和任务日志；完整 DolphinScheduler 页面仍可通过全屏 WebView 入口访问。

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
- DolphinScheduler API 读取允许具有 `dsTask` 或 `ds` 任一模块权限的已登录用户访问；完整页面入口仍归 `ds` 模块。门户不保存或注入用户密码。

## 4. 页面与操作边界

| 页面 | 首期能力 |
|---|---|
| 首页 | YARN 与当日任务摘要、失败/运行状态、快捷入口 |
| YARN | RM 选择、状态筛选、搜索、刷新、应用详情、终止应用 |
| 离线开发 | 仅保留项目、工作流两个一级 tab；工作流行内展开近两天工作流实例和任务实例；工作流上线/下线和手动启动；定时列表及上下线；实例停止/重跑；任务日志分页查看/刷新/复制；打开完整 DolphinScheduler |
| 我的 | 当前用户、角色、授权模块、门户连接信息、退出登录 |

危险操作（终止 YARN 应用、工作流/定时上下线、启动工作流、停止/重跑实例）必须满足：

1. 按现有模块权限和角色由网关再次校验，不能只依赖前端隐藏按钮。
2. 操作前展示目标名称和不可逆影响，并要求用户显式确认。
3. 提交期间按钮防重复点击；成功后刷新目标列表。
4. 开发和自动化验证只能使用假 ID，不得触发真实集群操作。

DolphinScheduler 写操作沿用 `/dolphinscheduler/...` 代理，但网关执行门禁必须覆盖 `process/release`、`executors/start-process-instance`、`schedule/online|offline` 和 `executors/execute`：viewer 禁止操作，dev/admin 还需 `dsTask` 模块权限。移动端不得绕过该门禁直连 DolphinScheduler。所有写操作均使用二次确认并在请求期间禁用重复提交。

离线开发默认查询当前时间向前两天的闭区间。进入离线开发时优先恢复上次项目并直接展示工作流列表，减少先选项目再进列表的重复操作。离线开发只保留“项目 / 工作流”两个一级 tab；近两天工作流实例、任务实例、实例停止/重跑和任务日志都收敛在工作流卡片展开区内。项目和工作流列表允许搜索；工作流列表的每一行提供显式的“近 2 天任务”展开入口、详情、工作流上下线、启动和定时上下线入口，不能只依赖点击标题展开。定时上下线必须选择具体 schedule 后再确认，不能对多个定时做无提示批量切换。展开工作流时加载近两天该工作流实例下的任务实例，允许直接查看任务日志。工作流详情展示发布状态、负责人、更新时间、DAG 节点摘要和定时列表。移动端不提供工作流/节点编辑、删除或新建定时，复杂配置继续进入完整 DolphinScheduler。

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

## 7. 主题与移动浮层

移动端支持浅色、深色和跟随系统三种主题，偏好保存在设备 `localStorage`。主题通过根节点 `ion-palette-dark` 类和语义CSS变量切换；状态色含义在两种主题下保持一致。

Ionic的Action Sheet、Alert、Modal等overlay挂载在应用根层，不继承页面卡片的局部背景。`mobile.css`必须显式提供overlay背景、文字、分隔线和backdrop变量，项目/RM/任务节点筛选不得出现透明背景。新增overlay组件时需要同时在深浅主题下检查。
