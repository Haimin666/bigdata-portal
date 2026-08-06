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
| `STINGRAY_USER/PASS` | — | Stingray 自动登录凭证 |
| `OMD_USER/PASS` | — | OMD 凭证(base64 编码发送) |

凭证只放 `.env.local`(gitignore),不入库;前端 localStorage(`dswebUser/dswebPass`、`stingrayUser/stingrayPass`)优先。

## 子应用接入说明

- **同源 iframe**(海豚、Stingray):经网关代理,会话 cookie 种在门户域,进入时自动登录(`/api/login/{ds|stingray}`)免登录;Stingray 经 HTML 注入修正 React 路由。
- **跨源 iframe**(OMD、StreamX):目标系统无 `X-Frame-Options` 限制,直接嵌入,认证在各自域内完成(受同源策略限制,门户无法注入;密码自动填充建议用浏览器密码管理器)。
- 配置在 `src/config/menu.ts`(`iframe: true` 原生 iframe,`login` 同源自动登录)。

## Docker 部署

```bash
docker build -t bigdata-portal .
docker run -d -p 3000:3000 \
  -e YARN_RM_LIST=http://<rm-host>:8088 \
  -e HDFS_URL=http://<nn-host>:9870 \
  -e DS_WEB_URL=http://<ds-host>/dolphinscheduler \
  -e OMD_URL=https://<omd-host> \
  -e STINGRAY_URL=http://<stingray-host> \
  -e DSWEB_USER=<user> -e DSWEB_PASS=<pass> \
  bigdata-portal
```

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
