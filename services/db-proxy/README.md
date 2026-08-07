# db-proxy:数据库只读 HTTP 代理(客户机侧)

在**可直连数据库的客户机**上运行,把数据库查询能力以 HTTP API 暴露给平台。
平台服务器无需直连数据库,也永远不接触数据库密码。
**支持 MySQL 与 Oracle 多数据源**(一个服务连多套库,按 `db` 参数路由)。

**所有配置集中在一个文件 `datasources.json`**,代码写死路径,无需其他配置。

## 架构

```
[平台服务器] --HTTP--> [客户机(本服务)] --MySQL/Oracle--> [数据库们]
  /api/db/*            :8756                     (客户机可直连)
```

## 环境要求

- Python 3.7+(老旧机器可用 3.7.6)
- 客户机能直连目标数据库

## 安装

```bash
cd services/db-proxy
python3.7 -m pip install -r requirements.txt
```

## 配置(只需 datasources.json)

复制 `datasources.json.example` 为 `datasources.json`,填写真实配置:

```json
{
  "authToken": "你的访问token",                    // 请求鉴权(X-DB-Token),留空=不鉴权
  "listenHost": "0.0.0.0",
  "listenPort": 8756,
  "defaultLimit": 100,                            // 无限制子句时默认行数
  "maxLimit": 10000,                              // 行数硬上限
  "queryTimeout": 60,
  "connectTimeout": 5,
  "allowedDbs": ["credzy", "credzx", "finance_order_trade"],  // 库白名单
  "allowedTables": [],                            // 表白名单(可选)
  "oracleClientLib": "/usr/lib/oracle/19.19/client64/lib",  // Oracle 客户端库目录(连 11g 必配)
  "datasources": [
    { "name": "credzy", "type": "oracle", "host": "...", "port": 1521,
      "user": "...", "password": "...", "service": "credzy", "rowLimit": "rownum" },
    { "name": "finance_order_trade", "type": "mysql", "host": "...", "port": 3343,
      "user": "...", "password": "...", "schema": "finance_order_trade" }
  ]
}
```

数据源字段:
- `name` = 前端请求的 `db` 参数
- `type`: `mysql` / `oracle`
- Oracle 用 `service`(服务名);MySQL 用 `schema`(库名)
- `rowLimit`(可选,Oracle 用):`fetch`(默认,12c+)/ `rownum`(11g);MySQL 无需配
- 数据库密码**只存在客户机**,平台不接触

## 启动

```bash
python3.7 main.py
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/health` | 探活 |
| GET  | `/dbs`    | 列出可用数据源(白名单过滤) |
| POST | `/query`  | 执行只读查询,body `{db, sql}`(db=数据源 name) |
| GET  | `/acl`    | 回显配置(脱敏,排查) |

鉴权:配置了 `authToken` 后,请求需带请求头 `X-DB-Token: <token>`。

## 安全约束

1. **只读强制**:SQL 必须以 `SELECT/SHOW/DESC/EXPLAIN/WITH` 开头,其余 403
2. **库白名单**:请求的 `db` 必须在 `allowedDbs`(且是已配置数据源)
3. **表白名单**:`allowedTables` 开启后从 SQL 提取表名校验
4. **强制行数上限**:无限制子句自动加(MySQL `LIMIT` / Oracle 12c+ `FETCH FIRST` / Oracle 11g `ROWNUM`),硬上限 `maxLimit`
5. **超时**:连接/查询超时可配,防远端卡死
6. **审计**:每次查询打日志(时间/库/SQL/行数/耗时)

## Oracle 11g 说明

- **必须配 `oracleClientLib`** 指向客户端库目录(含 `libclntsh.so`),走 thick 模式
  (thin 模式不支持 11g)
- **必须配 `rowLimit: "rownum"`**(11g 无 `FETCH FIRST` 语法,用 ROWNUM 包装)

## 平台接入

平台网关 `server/config.js` 配置 `DB_PROXY_URL`(如 `http://10.25.15.106:8756`),
网关 `/api/db/*` 会代理到该地址。平台服务器 `.env.local` 加:

```bash
DB_PROXY_URL=http://10.25.15.106:8756
```

> 提示:客户机防火墙需放行 8756 端口,并确认平台服务器能访问
> `10.25.15.106:8756`(可用 `curl http://10.25.15.106:8756/health` 验证)。
