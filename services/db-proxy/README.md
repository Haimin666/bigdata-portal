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
| GET  | `/scripts/tree` | 我的目录:SQL 脚本目录树 |
| POST | `/scripts/new`  | 新建目录/文件,body `{parentId, name, kind}`(kind=dir\|file) |
| POST | `/scripts/rename`| 重命名,body `{id, name}` |
| POST | `/scripts/delete`| 删除(目录递归),body `{id}` |
| POST | `/scripts/save`  | 保存 SQL 内容,body `{id, content}`(存 `scripts/files/<id>.sql`) |
| GET  | `/scripts/get`  | 读取 SQL 内容,`?id=` |
| GET  | `/tables` | 表目录:某库的表列表,`?db=`(MySQL `SHOW TABLES`/Oracle `user_tables`) |
| GET  | `/fields` | 表目录:某表的字段列表,`?db=&table=`(MySQL `DESC`/Oracle `user_tab_columns`) |

鉴权:配置了 `authToken` 后,请求需带请求头 `X-DB-Token: <token>`。

脚本存储:目录树元数据在 `scripts/tree.json`,SQL 内容在 `scripts/files/<id>.sql`;
可用环境变量 `DB_SCRIPTS_DIR` 覆盖存储目录(docker 部署建议挂载此目录持久化)。

## 安全约束

1. **默认只读**:所有库默认只读——SQL 必须以 `SELECT/SHOW/DESC/EXPLAIN/WITH` 开头,`INSERT/UPDATE/DELETE/DROP` 等一律 403
2. **可写白名单(后台配置)**:`writableTables` 支持 `"name.*"`(该数据源全表可写)/ `"name.table"`(单表可写),**name = 数据源唯一标识**(前端请求的 db 参数,多个数据源可指向同一真实库)。SQL 里写真实库名或裸表名都会归一化到当前数据源 name 再匹配;未配 = 全只读
3. **过程白名单(单独配置)**:`executableProcedures` 格式 `"name.procedure"`(或 `"name.pkg.proc"` 包过程),如 `["credzy.update_balance"]`。`CALL/BEGIN/EXEC` 调用命中才放行;过程内部操作对代理是黑盒,未配 = 禁止执行过程
4. **多语句防护**:拒绝分号分隔的多语句(`SELECT 1; DELETE ...` 403),末尾结尾分号允许(过程 BEGIN...END 块除外)
5. **库白名单**:请求的 `db` 必须在 `allowedDbs`(且是已配置数据源)
6. **表白名单**:`allowedTables` 开启后从 SQL 提取表名校验
7. **强制行数上限**:无限制子句自动加(MySQL `LIMIT` / Oracle 12c+ `FETCH FIRST` / Oracle 11g `ROWNUM`),硬上限 `maxLimit`
8. **SQL 长度上限**:超过 `maxSqlLen`(默认 32768 字节)拒绝,防超大 SQL
9. **超时**:连接/查询超时可配,防远端卡死
10. **审计**:每次查询打日志(时间/库/SQL/行数/耗时)

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
