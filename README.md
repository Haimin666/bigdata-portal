# bigdata-portal 大数据统一门户

基于 **Vue 3 + Vite + TypeScript + Element Plus + Pinia** 的大数据门户,聚合:

- **YARN 监控**、**HDFS 文件浏览** — 原生 Vue 视图(自建 UI)
- **海豚调度 / Stingray / OMD / StreamX** — iframe 嵌入(同源代理或跨源直连)

> 完整架构与开发细节见 [`docs/AGENTS.md`](docs/AGENTS.md)(Agent 开发指南,含全部踩坑记录)。

## 技术栈

- 主应用:Vue 3.5 / Vite 5 / TypeScript / vue-router 4 / Pinia / Element Plus
- 子应用:原生 iframe 嵌入(第三方老系统零改造)
- 网关:Node(Express),静态托管 + 反向代理 + 自动登录 + WebSocket 代理,单进程部署

## 功能模块

| 菜单 | 方式 | 说明 |
|---|---|---|
| YARN 应用 | 原生视图 | 表格/卡片、筛选、自动刷新、kill |
| HDFS | 原生视图 | WebHDFS 文件浏览器:面包屑导航、路径定位、翻页、大小/权限 |
| 数据库查询 `/db-query` | 原生视图 | 多引擎/库选择 + CodeMirror SQL 画布 + 结果表格(排序/CSV 导出)+ **我的目录**(SQL 脚本存储)+ **表目录**(库→表→字段) |
| 海豚调度 `/ds` | 同源 iframe | 网关代理 + 自动登录,免登录进入 |
| 即时查询 `/query` | 同源 iframe | Stingray 代理 + 路由注入,自动登录,SQL 查询(WebSocket 结果推送) |
| 我的数据 `/omd` | 跨源 iframe | OpenMetadata 直连,域内登录 |
| 实时开发 `/streamx` | 跨源 iframe | StreamX 直连,域内登录 |

## 架构

```
浏览器
 ├─ /yarn /hdfs         原生 Vue 视图
 ├─ /ds /query          原生 iframe → 同源代理(网关)
 └─ /omd /streamx       原生 iframe → 跨源直连
        │
        ▼
Vite(3002,ws:true)→ Express 网关(3000)
  /hadoopapi → YARN RM          /webhdfs /static → HDFS
  /apps/dsweb /dolphinscheduler → 海豚
  /apps/stingray /stingray-static /__/stingray(含 WebSocket) → Stingray
  /api/config → 配置下发        /api/login/* → 自动登录
```

## 快速开始

```bash
npm install
npm run dev        # 一键启动:网关(3000)+ 前端(3002),访问 http://localhost:3002
```

分开展:

```bash
npm run dev:gateway   # 网关
npm run dev:vite      # 前端
```

生产:

```bash
npm run build    # 产出 dist/
npm run serve    # 网关托管 dist/ + 代理,端口 3000
```

一键脚本(生产模式,基于 npm):

```bash
scripts/npmctl.sh rebuild   # 重构并重启:stop → npm run build → start(推荐)
scripts/npmctl.sh start     # 后台启动网关(托管 dist/,端口 3000)
scripts/npmctl.sh stop      # 停止网关
scripts/npmctl.sh restart   # 重启(不重新构建)
scripts/npmctl.sh status    # 进程与健康状态
scripts/npmctl.sh build     # 仅构建前端
```

进程信息:`scripts/npmctl.sh` 将主进程 PID 写入项目根 `.portal.pid`,日志在 `.portal.log`;端口可用环境变量 `PORT` 覆盖。

## 环境变量(server/config.js,支持项目根 .env.local)

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 网关端口 |
| `GATEWAY_URL` | `http://localhost:3000` | Vite dev 代理目标 |
| `YARN_RM_LIST` | `http://hadoop-nn-1.bigdata.shiqiao.com:8088` | RM 列表(逗号分隔) |
| `HDFS_URL` | `http://hadoop-nn-1.bigdata.shiqiao.com:9870` | HDFS NameNode |
| `DS_WEB_URL` | `http://olds.bigdata.shiqiao.com/dolphinscheduler` | 海豚 |
| `OMD_URL` | `https://omd.corp.shiqiao.com` | OMD |
| `STINGRAY_URL` | `http://stingray.corp.shiqiao.com` | Stingray |
| `DSWEB_USER/PASS` | — | 海豚自动登录凭证 |
| `DS_TOKEN` | — | 海豚 API token:网关 `/dolphinscheduler` 代理自动注入 `token` header,任务监控项目列表即该 token 用户可见(无无权限项目);换 token 改此项后重启网关 |
| `STINGRAY_USER/PASS` | — | Stingray 自动登录凭证 |
| `OMD_USER/PASS` | — | OMD 凭证(base64 编码发送) |

凭证只放 `.env.local`(gitignore),不入库;前端 localStorage(`dswebUser/dswebPass`、`stingrayUser/stingrayPass`)优先。

## 子应用接入说明

- **同源 iframe**(海豚、Stingray):经网关代理,会话 cookie 种在门户域,进入时自动登录(`/api/login/{ds|stingray}`)免登录;Stingray 经 HTML 注入修正 React 路由。
- **跨源 iframe**(OMD、StreamX):目标系统无 `X-Frame-Options` 限制,直接嵌入,认证在各自域内完成(受同源策略限制,门户无法注入;密码自动填充建议用浏览器密码管理器)。
- **Tab 常驻池**:所有模块(原生视图 YARN/HDFS/任务监控 + 子应用 iframe)访问后均常驻——切走仅隐藏不卸载,状态保留(筛选、翻页、HDFS 路径、子应用页面),回来可接着操作;顶部 Tab 条可切换/关闭,关闭即销毁组件/iframe 释放内存。
- 配置在 `src/config/menu.ts`(`iframe: true` 原生 iframe,`login` 同源自动登录)。

## Docker 部署

```bash
docker build -t bigdata-portal .
docker run -d -p 9910:9910 \
  -e PORT=9910 \
  -e YARN_RM_LIST=http://<rm-host>:8088 \
  -e HDFS_URL=http://<nn-host>:9870 \
  -e DS_WEB_URL=http://<ds-host>/dolphinscheduler \
  -e OMD_URL=https://<omd-host> \
  -e STINGRAY_URL=http://<stingray-host> \
  -e DSWEB_USER=<user> -e DSWEB_PASS=<pass> \
  bigdata-portal
```

一键脚本(docker compose,构建 / 启动 / 停止 / 销毁):

```bash
scripts/dockerctl.sh up        # 构建并启动(推荐;已存在则直接启动)
scripts/dockerctl.sh build     # 仅构建镜像
scripts/dockerctl.sh start     # 启动已构建的容器
scripts/dockerctl.sh stop      # 停止
scripts/dockerctl.sh restart   # 重启
scripts/dockerctl.sh down      # 停止并删除容器(保留镜像)
scripts/dockerctl.sh destroy   # 销毁:删除容器 + 镜像
scripts/dockerctl.sh logs      # 跟随日志
scripts/dockerctl.sh ps        # 查看状态
```

**内网构建**:服务器无法访问 docker.io 时,构建会卡在拉 `node:20-alpine`(connect timeout)。用环境变量指定内部镜像源与 npm 源后重试:

```bash
BASE_IMAGE=<harbor-addr>/library/node:20-alpine \
NPM_REGISTRY=<内网 npm 源,可选> \
scripts/dockerctl.sh up
```

`docker-compose.yml` 已声明健康检查(探测 `/api/config`),凭证与各系统地址由运行时注入项目根 `.env.local`(不影响构建,不进镜像);无需凭证也能启动,仅子系统免登录回退默认值。

### Nginx 前置(可选)

网关已含全部能力,如需 nginx 只做静态与反代:

```nginx
server {
  listen 80;
  root /app/dist;
  location / { try_files $uri /index.html; }
  location /api/  { proxy_pass http://127.0.0.1:3000; }
  location /apps/ { proxy_pass http://127.0.0.1:3000; }
  location /hadoopapi/ { proxy_pass http://127.0.0.1:3000; }
  location /static/ { proxy_pass http://127.0.0.1:3000; }
  location /webhdfs/ { proxy_pass http://127.0.0.1:3000; }
  location /dolphinscheduler/ { proxy_pass http://127.0.0.1:3000; }
  location /stingray-static/ { proxy_pass http://127.0.0.1:3000; }
  location /__/stingray/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;   # WebSocket 必需
    proxy_set_header Connection "upgrade";
  }
}
```

## 内网验证清单

1. `/api/config` 返回各系统地址;`/api/login/ds` 返回 `ok:true` + Set-Cookie
2. `/hdfs` 可列目录、翻页、路径定位
3. `/ds` 海豚免登录进入,资源/API 全通
4. `/query` Stingray 免登录,SQL 查询 WebSocket 正常推送结果
5. `/omd`、`/streamx` 显示对应系统登录页
6. YARN 列表加载、kill 可用
