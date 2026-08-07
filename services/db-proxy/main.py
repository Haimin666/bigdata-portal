"""db-proxy:数据库只读 HTTP 代理服务(客户机侧)。

运行在可直连数据库的客户机上,把"查询"能力以 HTTP API 暴露给平台。
支持 MySQL 与 Oracle(通过 DB_TYPE 切换)。

设计目标:
  - 只读强制(SELECT/SHOW/DESC/EXPLAIN),杜绝写操作
  - 库级 + 表级白名单,防越权访问
  - 强制行数上限,防大结果集拖垮(MySQL 用 LIMIT,Oracle 用 FETCH FIRST)
  - 连接信息只存在于客户机,平台永远不接触数据库密码
  - 可选 AUTH_TOKEN 鉴权,防内网随意调用
  - 执行审计日志

依赖:
  - MySQL:  pymysql(Python 3.7 兼容)
  - Oracle: oracledb>=1.4,<2.0(Python 3.7 兼容,thin 模式无需 Oracle 客户端库)
用法:DB_TYPE=mysql DB_HOST=... DB_USER=... DB_PASS=... python main.py
"""

from __future__ import annotations

import logging
import os
import re
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

# ── 驱动导入(按 DB_TYPE 懒加载,避免未装的驱动阻塞启动)───────────
DB_TYPE = os.getenv("DB_TYPE", "mysql").strip().lower()
if DB_TYPE not in ("mysql", "oracle"):
    raise RuntimeError(f"DB_TYPE must be 'mysql' or 'oracle', got {DB_TYPE!r}")

if DB_TYPE == "mysql":
    import pymysql

    _DB_ERR = pymysql.MySQLError
else:
    import oracledb

    # thin 模式:不依赖 Oracle Instant Client;LOB 直接返回字符串
    try:
        oracledb.defaults.fetch_lobs = False
    except AttributeError:
        pass
    _DB_ERR = oracledb.Error

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("db-proxy")

# ── 配置(环境变量驱动,客户机侧)───────────────────────────────
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = int(os.getenv("DB_PORT", "3306" if DB_TYPE == "mysql" else "1521"))
DB_USER = os.getenv("DB_USER", "root" if DB_TYPE == "mysql" else "")
DB_PASS = os.getenv("DB_PASS", "")
DB_CHARSET = os.getenv("DB_CHARSET", "utf8mb4" if DB_TYPE == "mysql" else "AL32UTF8")
# Oracle 服务名(连接串 service_name),如 ORCLPDB1;MySQL 忽略
ORACLE_SERVICE = os.getenv("ORACLE_SERVICE", "")
# 连接超时(秒),防止远端库不可达时卡死
DB_CONNECT_TIMEOUT = int(os.getenv("DB_CONNECT_TIMEOUT", "5"))

# 允许访问的数据库白名单(逗号分隔),为空 = 允许所有(不推荐)
ALLOWED_DBS = [s.strip() for s in os.getenv("ALLOWED_DBS", "").split(",") if s.strip()]
# 允许访问的表白名单(逗号分隔,库.表 或 表),为空 = 不校验表
ALLOWED_TABLES = [s.strip() for s in os.getenv("ALLOWED_TABLES", "").split(",") if s.strip()]
# 请求鉴权 token:请求头 X-DB-Token 需匹配;为空 = 不鉴权
AUTH_TOKEN = os.getenv("AUTH_TOKEN", "")
# 无 LIMIT 时自动追加的行数
DEFAULT_LIMIT = int(os.getenv("DEFAULT_LIMIT", "100"))
# 硬上限,防止恶意传超大 LIMIT
MAX_LIMIT = int(os.getenv("MAX_LIMIT", "10000"))
# 单查询最大执行时间(秒)
QUERY_TIMEOUT = int(os.getenv("QUERY_TIMEOUT", "60"))
# 监听端口
LISTEN_PORT = int(os.getenv("LISTEN_PORT", "8756"))
LISTEN_HOST = os.getenv("LISTEN_HOST", "0.0.0.0")

# 只读 SQL 前缀白名单(正则)
READ_ONLY_RE = re.compile(
    r"^\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|WITH)\b", re.IGNORECASE
)
# 提取 SQL 中出现的表名(粗略:FROM/JOIN/INTO/UPDATE 后跟的表)
TABLE_RE = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:[\"\[]?)([A-Za-z0-9_$.]+)(?:[\"\]]?)?",
    re.IGNORECASE,
)
# 行数上限检测(MySQL/Oracle 通用):LIMIT n 或 FETCH FIRST n ROWS
LIMIT_RE = re.compile(
    r"\b(?:LIMIT\s+(\d+)|FETCH\s+FIRST\s+(\d+)\s+ROWS)", re.IGNORECASE
)

app = FastAPI(title="db-proxy", version="1.1.0")


# ── 安全工具 ──────────────────────────────────────────────────
def require_auth(x_db_token: Optional[str]) -> None:
    """鉴权:配置了 AUTH_TOKEN 则必须匹配。"""
    if AUTH_TOKEN and x_db_token != AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="unauthorized")


def check_db_allowed(db: str) -> None:
    if ALLOWED_DBS and db not in ALLOWED_DBS:
        raise HTTPException(
            status_code=403, detail=f"database '{db}' not in ALLOWED_DBS"
        )


def check_read_only(sql: str) -> None:
    if not READ_ONLY_RE.match(sql):
        raise HTTPException(
            status_code=403, detail="only SELECT/SHOW/DESC/EXPLAIN allowed (read-only)"
        )


def check_tables_allowed(sql: str) -> None:
    """表级白名单:从 SQL 提取表名,不在白名单拒绝。"""
    if not ALLOWED_TABLES:
        return
    for m in TABLE_RE.finditer(sql):
        table = m.group(1)
        # 支持 "库.表" 完整名或裸表名,任一匹配即通过
        if table in ALLOWED_TABLES or table.split(".", 1)[-1] in ALLOWED_TABLES:
            continue
        raise HTTPException(
            status_code=403,
            detail=f"table '{table}' not in ALLOWED_TABLES",
        )


def enforce_limit(sql: str) -> int:
    """提取行数上限:MySQL 的 LIMIT n 或 Oracle 的 FETCH FIRST n ROWS。"""
    m = LIMIT_RE.search(sql)
    if m:
        limit = int(m.group(1) or m.group(2))
        if limit > MAX_LIMIT:
            raise HTTPException(
                status_code=400, detail=f"row limit exceeds MAX_LIMIT({MAX_LIMIT})"
            )
        return limit
    return DEFAULT_LIMIT


def append_row_limit(sql: str, limit: int) -> str:
    """按数据库类型追加行数限制语法。"""
    if DB_TYPE == "oracle":
        # Oracle 用 FETCH FIRST;若已有 FETCH 子句则不重复(前面已探测过无)
        return f"{sql} FETCH FIRST {limit} ROWS ONLY"
    return f"{sql} LIMIT {limit}"


# ── 数据访问 ──────────────────────────────────────────────────
def _connect(db: str):
    """按 DB_TYPE 建立连接。MySQL 的 db=库名;Oracle 的 db=服务名/schema 标识。"""
    if DB_TYPE == "mysql":
        return pymysql.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASS,
            database=db,
            charset=DB_CHARSET,
            connect_timeout=DB_CONNECT_TIMEOUT,
            read_timeout=QUERY_TIMEOUT,
            write_timeout=QUERY_TIMEOUT,
            cursorclass=pymysql.cursors.DictCursor,
        )
    # Oracle thin 模式
    dsn = f"{DB_HOST}:{DB_PORT}/{ORACLE_SERVICE or db}"
    return oracledb.connect(
        user=DB_USER,
        password=DB_PASS,
        dsn=dsn,
        connect_timeout=DB_CONNECT_TIMEOUT,
    )


def _rows_to_dicts(rows: List[Any], description: List[Any]) -> List[Dict[str, Any]]:
    """统一行格式:list[dict],key 为列名。"""
    if DB_TYPE == "mysql":
        return rows  # DictCursor 已是 dict
    cols = [d[0].lower() for d in description] if description else []
    result = []
    for r in rows:
        result.append({cols[i]: r[i] for i in range(len(cols))})
    return result


def fetch(sql: str, db: str) -> Dict[str, Any]:
    """连接并执行只读查询,返回 {columns, rows, costMs, truncated}。"""
    clean_sql = sql.strip().rstrip(";").strip()
    limit = enforce_limit(clean_sql)
    if not LIMIT_RE.search(clean_sql):
        clean_sql = append_row_limit(clean_sql, limit)

    start = time.time()
    try:
        conn = _connect(db)
    except _DB_ERR as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        cur.execute(clean_sql)
        if DB_TYPE == "mysql":
            rows = cur.fetchall()
            truncated = len(rows) > limit
            rows = rows[:limit]
            columns = list(rows[0].keys()) if rows else []
        else:
            # Oracle:多取 1 行探测截断
            fetched = cur.fetchmany(limit + 1)
            truncated = len(fetched) > limit
            rows = _rows_to_dicts(fetched[:limit], cur.description)
            columns = list(rows[0].keys()) if rows else []
        cur.close()
    except _DB_ERR as e:
        raise HTTPException(status_code=502, detail=f"query failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

    cost_ms = int((time.time() - start) * 1000)
    return {
        "columns": columns,
        "rows": rows,
        "costMs": cost_ms,
        "truncated": truncated,
    }


# ── 接口 ──────────────────────────────────────────────────────
class QueryReq(BaseModel):
    db: str
    sql: str


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"code": 0, "msg": "ok"}


@app.get("/dbs")
def dbs(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if ALLOWED_DBS:
        return {"code": 0, "data": ALLOWED_DBS}
    # 未配置白名单:尝试列真实库(MySQL: SHOW DATABASES;Oracle: 当前数据库名)
    try:
        conn = _connect(ORACLE_SERVICE if DB_TYPE == "oracle" else "")
    except _DB_ERR as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if DB_TYPE == "mysql":
            cur.execute("SHOW DATABASES")
            data = [r["Database"] for r in cur.fetchall()]
        else:
            cur.execute("SELECT name FROM v$database")
            data = [r[0] for r in cur.fetchall()]
        cur.close()
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return {"code": 0, "data": data}


@app.post("/query")
def query(
    req: QueryReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    check_db_allowed(req.db)
    check_read_only(req.sql)
    check_tables_allowed(req.sql)
    result = fetch(req.sql, req.db)
    # 审计日志:时间/库/SQL/行数/耗时
    log.info(
        "query db=%s rows=%d cost=%dms sql=%s",
        req.db,
        len(result["rows"]),
        result["costMs"],
        req.sql[:200],
    )
    return {"code": 0, "data": result}


@app.get("/acl")
def acl(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    """回显当前白名单配置,排查用。"""
    require_auth(x_db_token)
    return {
        "code": 0,
        "data": {
            "dbType": DB_TYPE,
            "allowedDbs": ALLOWED_DBS,
            "allowedTables": ALLOWED_TABLES,
            "defaultLimit": DEFAULT_LIMIT,
            "maxLimit": MAX_LIMIT,
            "queryTimeout": QUERY_TIMEOUT,
            "authEnabled": bool(AUTH_TOKEN),
            "dbHost": DB_HOST,
            "dbPort": DB_PORT,
        },
    }


if __name__ == "__main__":
    import uvicorn

    log.info(
        "db-proxy(%s) listening on %s:%s (dbs=%s tables=%s auth=%s)",
        DB_TYPE,
        LISTEN_HOST,
        LISTEN_PORT,
        ALLOWED_DBS or "ALL",
        ALLOWED_TABLES or "ALL",
        "on" if AUTH_TOKEN else "off",
    )
    uvicorn.run(app, host=LISTEN_HOST, port=LISTEN_PORT, log_level="info")
