# db-proxy:数据库只读 HTTP 代理(客户机侧)

在**可直连数据库的客户机**上运行,把数据库查询能力以 HTTP API 暴露给平台。
平台服务器无需直连数据库,也永远不接触数据库密码。
**支持 MySQL 与 Oracle**(`DB_TYPE` 切换)。

## 架构

```
[平台服务器] --HTTP--> [客户机(本服务)] --MySQL/Oracle--> [数据库]
  /api/db/*            :8756                     (客户机可直连)
```

## 环境要求

- Python 3.7+(老旧机器可用 3.7.6)
- 客户机能直连目标数据库

## 安装

```bash
cd services/db-proxy
python3.7 -m pip install -r requirements.txt
# 或离线安装:将 fastapi/uvicorn/pymysql/oracledb 的 wheel 拷到客户机
#   pip install --no-index --find-links=/path/to/wheels -r requirements.txt
```

> Oracle 模式:oracledb 1.x thin 模式**无需安装 Oracle Instant Client**,
> 纯 Python 实现,老旧机器友好。

## 配置

复制 `env.example` 为 `.env`(或直接 export),关键项:

```bash
export DB_TYPE=mysql            # mysql 或 oracle
export DB_HOST=127.0.0.1        # 客户机可直连的库地址
export DB_PORT=3306             # MySQL 3306 / Oracle 1521
export DB_USER=your_user
export DB_PASS=your_password    # 密码只留在客户机
export ORACLE_SERVICE=ORCLPDB1  # 仅 Oracle:服务名(不填则用请求的 db 参数)
export ALLOWED_DBS=lion_dw,test # 库白名单(逗号分隔)
export ALLOWED_TABLES=          # 表白名单(可选,支持 库.表 或裸表名)
export AUTH_TOKEN=change_me     # 请求鉴权(可选,建议开启)
```

## 启动

```bash
python3.7 main.py
# 或
uvicorn main:app --host 0.0.0.0 --port 8756
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/health` | 探活 |
| GET  | `/dbs`    | 列出可用库(白名单内) |
| POST | `/query`  | 执行只读查询,body `{db, sql}` |
| GET  | `/acl`    | 回显白名单配置(排查) |

鉴权:配置了 `AUTH_TOKEN` 后,请求需带请求头 `X-DB-Token: <token>`。

## 安全约束

1. **只读强制**:SQL 必须以 `SELECT/SHOW/DESC/EXPLAIN` 开头,其余 403
2. **库白名单**:请求的 `db` 必须在 `ALLOWED_DBS`
3. **表白名单**:开启后从 SQL 提取表名校验
4. **强制行数上限**:无限制子句自动加(MySQL `LIMIT 100` / Oracle `FETCH FIRST 100 ROWS ONLY`,可配),硬上限 `MAX_LIMIT`
5. **超时**:连接 5s / 查询 60s(可配),防远端卡死
6. **审计**:每次查询打日志(时间/库/SQL/行数/耗时)

## 平台接入

平台网关 `server/config.js` 配置 `DB_PROXY_URL`(如 `http://10.25.15.106:8756`),
网关 `/api/db/*` 会代理到该地址。

部署时在平台服务器的 `.env.local` 加一行:

```bash
# 客户机 db-proxy 地址(部署 IP 见上;端口与客户机 LISTEN_PORT 一致)
DB_PROXY_URL=http://10.25.15.106:8756
```

前端「即时查询」视图走 `/api/db/query`。

> 提示:客户机防火墙需放行 8756 端口,并确认平台服务器能访问 `10.25.15.106:8756`(可用 `curl http://10.25.15.106:8756/health` 验证)。
