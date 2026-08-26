# 开发流程规范(文档驱动 + 子代理模式)

> 本文件是**开发契约**:后续任何开发,必须先维护文档,再指导开发。

## 1. 为什么这样干

- 项目模块多(10+ 视图、3 层服务、多集群对接),上下文分散;主 agent 每次全量读代码会爆上下文
- 子代理(explore / 开发子代理)**没有当前对话上下文**,需要一份"该模块上下文"作为输入
- 文档 = 权威上下文载体;代码 = 事实来源。两者冲突时,**代码优先,但必须回写修正文档**

## 2. 铁律(每次开发都执行)

1. **先文档后代码**:动手前先读 `docs/modules/<模块>.md`;任何结构/API/数据流变化,**先更新文档再改代码**(提交时文档与代码同 commit)
2. **模块隔离**:开发哪个模块,只读哪个模块的文档 + 该模块涉及的代码文件,不全局扫
3. **子代理模式**:大改动用子代理 —— 父 agent 把模块文档摘要 + 具体任务交给子代理,子代理读代码产出,父 agent 收口集成、跑校验
4. **校验门槛**:改后端 `node --check`;改前端 `npx vue-tsc --noEmit` + `npm run build`;改 db-proxy `python3 -m py_compile`
5. **纪律**(详见本文 §6 协作规则):
   - 集群 API 先查文档、限并发、低频,不反复 curl 探测
   - 真实操作类接口验证一律用假 id(如 `instanceId=999999999`),绝不触发生产任务
   - 安装/权限问题不绕道,把命令整理给用户执行
6. **敏感信息**:`config.local.json`、`datasources.json`、`data/users.json` 等含真实密码,不入 git;文档只写字段语义,不写真实值

## 3. 文档目录

```
docs/
├── ARCHITECTURE.md      # 总体架构(三层/前端/网关/db-proxy/数据流/配置/部署)
├── DEVELOPMENT.md       # 本文档(流程契约+协作规则)
├── GUIDE.md             # 上手指南(架构速览/启动/代理清单/踩坑记录/验证清单;原 docs/AGENTS.md)
└── modules/
    ├── yarn.md          # YARN 应用监控(列表/资源管理器重建/Flink UI/Spark UI)
    ├── db-query.md      # 数据库查询(db-proxy/Spark/Flink/编辑器/结果多 tab)
    ├── ds-task.md       # 任务监控(海豚实例/依赖/级联重跑/追踪)
    ├── hdfs.md          # HDFS 磁盘监控
    ├── admin-auth.md    # 认证/用户管理/主题设置
    ├── subapps.md       # 子应用 iframe(DS/StreamX/Jupyter/OMD/Stingray)
    ├── dataleap.md      # DataLeap 元数据/血缘实验
    └── spark-flink.md   # Spark/Flink 网关与写操作防线
```

### 3.1 模块归属表(并行开发边界契约)

> 每个模块由专人负责,**只能修改本模块白名单内的文件**;跨模块需求找对应负责人或走平台行登记。
> "负责人"列由项目负责人填写后生效。

| 模块(菜单 name) | 前端独占 | 后端独占 | 模块文档 | 负责人 |
|---|---|---|---|---|
| platform(平台层) | `src/main.ts`、`src/App.vue`、`src/router/index.ts`、`src/config/menu.ts`、`src/layouts/`、`src/components/`、`src/utils/theme.ts`、`src/styles/`、`src/types/` | `server/index.js`、`server/config.js`、`server/util.js`、`server/routes/proxy.js` | `ARCHITECTURE.md` | _(填)_ |
| yarn | `src/views/yarn/`、`src/api/yarn.ts`、`src/store/yarn.ts` | —(RM 页面代理归 platform) | `modules/yarn.md` | _(填)_ |
| db-query(dbQuery) | `src/views/db/`、`src/api/db/` | `server/routes/db.js`、`server/db-scripts.js`、`server/db-permissions.js`、`server/spark-gateway.js`、`server/flink-gateway.js` | `modules/db-query.md`、`modules/spark-flink.md` | _(填)_ |
| ds-task(dsTask) | `src/views/ds/`、`src/api/ds.ts`、`src/api/dsDeps.ts` | `server/ds-deps.js` | `modules/ds-task.md` | _(填)_ |
| hdfs | `src/views/hdfs/`、`src/api/hdfs.ts` | — | `modules/hdfs.md` | _(填)_ |
| admin-auth(userManage) | `src/views/admin/`、`src/views/LoginView.vue`、`src/views/DeniedView.vue`、`src/store/auth.ts` | `server/auth.js`、`server/users.js` | `modules/admin-auth.md` | _(填)_ |
| subapps(stingray/ds/streamx/jupyter/omd) | `src/views/subapp/` | —(iframe 代理归 platform) | `modules/subapps.md` | _(填)_ |
| assistant(devAssistant) | `src/views/assistant/`、`src/api/assistant.ts` | `server/assistant-projects.js` | _(待补)_ | _(填)_ |
| dataleap | `src/views/dataleap/`、`src/api/dataleap.ts` | `server/dataleap.js` | `modules/dataleap.md` | _(填)_ |

### 3.2 文件白名单规则

1. **独占文件**自由提交,commit message 必须带模块名(`feat(yarn): ...` / `fix(db): ...`)
2. **共享文件**(上表 platform 行 + `package.json` + `docs/DEVELOPMENT.md`)变更纪律:
   - 动手前在群内声明改动意图与预计影响面;先 `git pull --rebase` 再改,缩短占用窗口
   - 改 `server/index.js` 仅限"挂载/卸载自己的路由"这类单行级变更;逻辑一律写进自己的模块文件
   - 改 `src/router/index.ts` / `src/config/menu.ts` 仅限注册自己的视图/菜单项
3. **新增 API** 一律落在 `server/routes/<module>.js`(Express Router),由 platform 在 `index.js` 挂载;不得再往 `index.js` 堆业务路由
4. **冲突处理**:同文件冲突时,以模块边界为准协商 rebase,禁止互相覆盖对方逻辑

## 4. 子代理开发操作模板

### 4.1 调研型(explore,只读)

```
任务:阅读 docs/modules/<模块>.md 摘要 + src/views/<模块> 代码,
回答:xxx 功能如何实现?数据从哪来?涉及哪些文件?
要求:给出 file:line 引用,不要改代码。
```

### 4.2 开发型(子代理带 write_paths)

```
任务:基于 docs/modules/<模块>.md 的上下文,实现 xxx:
- 涉及文件:<具体清单>(write_paths 声明)
- 约束:<模块文档中的关键机制/纪律>
- 完成后:node --check / vue-tsc / build 校验
父 agent 收口:审查 diff → 集成验证 → 更新文档 → 提交
```

### 4.3 改动模块后必做

1. 更新 `docs/modules/<模块>.md`(结构/API/数据流变化点)
2. 若影响全局(配置/认证/主题/路由)→ 同步更新 `docs/ARCHITECTURE.md`
3. commit message 引用模块名,如 `feat(yarn): ...`

### 4.4 并行开发流程(多人/多代理同时开工)

1. **领任务**:从归属表(§3.1)认领模块 → 只读该模块文档 + 白名单文件,不读无关模块
2. **开工前**:`git pull --rebase`;在群里声明"我要改 <模块>:<文件清单>"
3. **开发中**:新 API 落 `server/routes/<module>.js`(Express Router)+ `src/api/<module>/`(或单文件);
   需要挂载/注册时改 `server/index.js` / `router` / `menu.ts`,只加自己那一行
4. **验证口径**(每模块提交前必跑):
   - 后端:`node --check server/index.js server/routes/*.js` + `PORT=5199 node server/index.js` 冒烟(curl `/api/auth/config` 200)
   - 前端:`npm run type-check`(vue-tsc 全绿)+ 改了视图再跑 `npm run build`
   - 涉及集群的接口用假 id 验证(如 `jobId=999999999`),绝不触发真实任务
5. **提交**:模块名前缀 commit;共享文件改动单独一个 commit(方便冲突定位)
6. **收尾**:更新本模块文档;若动了白名单边界(新增共享文件),同步改 §3.1 归属表

## 5. 当前已知技术债(开发时注意)

- YARN iframe 代理对复杂 JS 路由页(Spark UI 时间线等)重写脆弱,自建 UI 弹窗优先
- Flink 1.13(StreamX 旧作业)与 1.17(本地)并存,`/jobs/:jid` 结构有差异,前端已兼容
- Spark UI 的 SQL/时间线/日志无 REST,只能跳原生页或 iframe
- db-proxy `datasources.json` 启动时加载,改配置必须重启
- 生产 docker 必须 `docker compose up -d --build`(dist 不入 git,restart 跑旧镜像)

## 6. Agent 协作规则(自根目录 AGENTS.md 并入,2026-08)

> 原 Reasonix 桌面端工作区规则文件已并入本节并删除,开发相关规则全部收拢在 docs/ 下。

### 6.1 视觉 / 附件处理(必须遵守)

Reasonix 主模型(DeepSeek)**不支持视觉**:用户直接发送图片会触发 provider 400
(`unknown variant image_url`)。桌面端已配置 `UserPromptSubmit` hook
(`.reasonix/hooks/vision-gate.cjs`)自动拦截**仅图片**消息:图片被登记到
`.reasonix/hooks/pending_vision.json`,本轮被阻断(不报 400),等待下一轮处理。
**非图片附件(pdf/docx/xlsx/zip 等)不触发 hook**——先按"纯文本类文件"直接读内容处理,必要时才走豆包。

**每轮开始必查** `.reasonix/hooks/pending_vision.json`:

- 不存在 → 正常处理本条消息。
- 存在且 `consumed == false`:
  1. 读取 `images` 列表(图片绝对路径)。
  2. **先把 `consumed` 置为 `true` 写回文件**(防重复处理)。
  3. 优先调用 **doubao MCP 工具** `mcp__doubao__doubao_vision`
     (`{images: [...], prompt: "请分析这些图片"}`,路径用绝对路径);
     若 MCP 不可用,降级 `run_skill({name: "doubao-chat"})` 走 playwright-cli 手动流程
     (`attach_chat.sh` → fill → `run-code setInputFiles` → Enter → 等「朗读」按钮出现 → 提取豆包回答)。
  4. **审查/交叉验证**豆包结论(可能不准确/编造),整合后回答用户,回答开头注明"已由豆包识别"。
  5. 处理完成:**把 `consumed` 置为 `true` 写回,保留 `pending_vision.json` 文件**。
     不要删除该文件——删除后 120 秒窗口内该附件会再次触发 hook 阻断,
     导致"回复继续"又被拦下。保留 `consumed=true` 记录即可让 hook 放行后续消息。
- 存在但 `consumed == true` → 图片已被处理过,**正常处理本条消息**(不要删除文件,不要重复调豆包)。

**其他**:
- 绝不把图片字节/附件内容作为消息直接发给不支持视觉的模型。
- 非图片附件(txt/csv/md/json/log/pdf/docx 等):先直接读文件内容处理;内容是图像/扫描件时才走豆包识别。
- 豆包输出仅作参考,涉及事实/数据需 Reasonix 交叉验证后呈现。

### 6.2 文档驱动开发铁律

(即本文 §2 铁律与 §3/§4 全部内容——原根 AGENTS.md 的该章节与本文重复,现以本文为准;
 原文要点:先读文档再动手、先改文档后改代码且同 commit、大改动用子代理、
 冲突时代码优先但必须回写文档。)
