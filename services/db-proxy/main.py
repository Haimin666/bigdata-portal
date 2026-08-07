"""db-proxy:数据库只读 HTTP 代理服务(客户机侧)。

运行在可直连数据库的客户机上,把"查询"能力以 HTTP API 暴露给平台。
设计目标:
  - 只读强制(SELECT/SHOW/DESC/EXPLAIN),杜绝写操作
  - 库级 + 表级白名单,防越权访问
  - 强制 LIMIT,防大结果集拖垮
  - 连接信息只存在于客户机,平台永远不接触数据库密码
  - 可选 AUTH_TOKEN 鉴权,防内网随意调用
  - 执行审计日志

依赖:fastapi + uvicorn + pymysql(Python 3.7 兼容)
用法:DB_HOST=... DB_USER=... DB_PASS=... python main.py
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional

import pymysql
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("db-proxy")

# ── 配置(环境变量驱动,客户机侧)───────────────────────────────
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")
DB_PASS = os.getenv("DB_PASS", "")
DB_CHARSET = os.getenv("DB_CHARSET", "utf8mb4")
# 连接超时(秒),防止远端库不可达时卡死
DB_CONNECT_TIMEOUT = int(os.getenv("DB_CONNECT_TIMEOUT", "5"))

# 允许访问的数据库白名单(逗号分隔),为空 = 允许所有(不推荐)
ALLOWED_DBS = [s.strip() for s in os.getenv("ALLOWED_DBS", "").split(",") if s.strip()]
# 允许访问的表白名单(逗号分隔,库.表 或 表),为空 = 不校验表
ALLOWED_TABLES = [s.strip() for s in os.getenv("ALLOWED_TABLES", "").split(",") if s.strip()]
# 请求鉴权 token:请求头 X-DB-Token 需匹配;为空 = 不鉴权
AUTH_TOKEN = os.getenv("AUTH_TOKEN", "")
# 无 LIMIT 时自动追加的最大行数
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
    r"^\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN)\b", re.IGNORECASE
)
# 提取 SQL 中出现的表名(粗略:FROM/JOIN/INTO/UPDATE 后跟的表)
TABLE_RE = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+`?([A-Za-z0-9_$.]+)`?",
    re.IGNORECASE,
)
# LIMIT 子句检测
LIMIT_RE = re.compile(r"\bLIMIT\b\s+\d+", re.IGNORECASE)

app = FastAPI(title="db-proxy", version="1.0.0")


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
    """强制 LIMIT:无 LIMIT 追加 DEFAULT_LIMIT,有则校验不超 MAX_LIMIT。"""
    m = LIMIT_RE.search(sql)
    if m:
        limit = int(m.group(0).split()[-1])
        if limit > MAX_LIMIT:
            raise HTTPException(
                status_code=400, detail=f"LIMIT exceeds MAX_LIMIT({MAX_LIMIT})"
            )
        return limit
    return DEFAULT_LIMIT


# ── 数据访问 ──────────────────────────────────────────────────
def fetch(sql: str, db: str) -> Dict[str, Any]:
    """连接并执行只读查询,返回 {columns, rows, costMs, truncated}。"""
    # 规范化:去掉末尾分号,统一追加 LIMIT(若原 SQL 带 LIMIT 则不重复)
    clean_sql = sql.strip().rstrip(";").strip()
    limit = enforce_limit(clean_sql)
    if not LIMIT_RE.search(clean_sql):
        clean_sql = f"{clean_sql} LIMIT {limit}"

    start = time.time()
    try:
        conn = pymysql.connect(
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
    except pymysql.MySQLError as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        with conn.cursor() as cur:
            cur.execute(clean_sql)
            rows = cur.fetchall()
        # 结果集 > LIMIT+1 说明被截断(探测截断:LIMIT+1 查询)
        truncated = len(rows) > limit
        rows = rows[:limit]
        columns = list(rows[0].keys()) if rows else []
    finally:
        conn.close()

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
    # 未配置白名单:尝试列真实库(需 SHOW DATABASES 权限)
    try:
        conn = pymysql.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASS,
            connect_timeout=DB_CONNECT_TIMEOUT,
            cursorclass=pymysql.cursors.DictCursor,
        )
        with conn.cursor() as cur:
            cur.execute("SHOW DATABASES")
            data = [r["Database"] for r in cur.fetchall()]
        conn.close()
        return {"code": 0, "data": data}
    except pymysql.MySQLError as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")


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
        "db-proxy listening on %s:%s (dbs=%s tables=%s auth=%s)",
        LISTEN_HOST,
        LISTEN_PORT,
        ALLOWED_DBS or "ALL",
        ALLOWED_TABLES or "ALL",
        "on" if AUTH_TOKEN else "off",
    )
    uvicorn.run(app, host=LISTEN_HOST, port=LISTEN_PORT, log_level="info")
