"""db-proxy:数据库只读 HTTP 代理服务(客户机侧)。

运行在可直连数据库的客户机上,把"查询"能力以 HTTP API 暴露给平台。
支持 MySQL 与 Oracle 的**多数据源**(一个服务连多套库,按 db 参数路由)。

设计目标:
  - 只读强制(SELECT/SHOW/DESC/EXPLAIN/WITH),杜绝写操作
  - 多数据源:JSON 配置,每个源独立 type/host/port/账密/schema
  - 库级 + 表级白名单,防越权访问
  - 强制行数上限,防大结果集拖垮(MySQL 用 LIMIT,Oracle 用 FETCH FIRST)
  - 连接信息只存在于客户机,平台永远不接触数据库密码
  - 可选 AUTH_TOKEN 鉴权,防内网随意调用
  - 执行审计日志

依赖:
  - MySQL:  pymysql(Python 3.7 兼容)
  - Oracle: oracledb>=1.4,<2.0(Python 3.7 兼容,thin 模式无需 Oracle 客户端库)
用法:DATASOURCES=datasources.json AUTH_TOKEN=... python main.py
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

# 驱动按需导入(避免未使用的驱动阻塞启动)
try:
    import pymysql  # type: ignore

    _HAS_MYSQL = True
except ImportError:  # pragma: no cover
    pymysql = None  # type: ignore
    _HAS_MYSQL = False

try:
    import oracledb  # type: ignore

    _HAS_ORACLE = True
    try:
        oracledb.defaults.fetch_lobs = False  # LOB 直接返回字符串
    except AttributeError:
        pass
except ImportError:  # pragma: no cover
    oracledb = None  # type: ignore
    _HAS_ORACLE = False

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("db-proxy")

# ── 配置(环境变量驱动,客户机侧)───────────────────────────────
# 多数据源配置文件路径(JSON)
DATASOURCES_FILE = os.getenv("DATASOURCES", "datasources.json")
# 兼容旧的单源 env(未配置 DATASOURCES 时使用;datasources.json 不存在时回退)
DB_TYPE = os.getenv("DB_TYPE", "mysql").strip().lower()
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")
DB_PASS = os.getenv("DB_PASS", "")
DB_CHARSET = os.getenv("DB_CHARSET", "utf8mb4")
ORACLE_SERVICE = os.getenv("ORACLE_SERVICE", "")
# 连接超时(秒),防止远端库不可达时卡死
DB_CONNECT_TIMEOUT = int(os.getenv("DB_CONNECT_TIMEOUT", "5"))
# 查询超时(秒)
QUERY_TIMEOUT = int(os.getenv("QUERY_TIMEOUT", "60"))

# 允许访问的数据库白名单(逗号分隔),为空 = 允许所有已配置数据源
ALLOWED_DBS = [s.strip() for s in os.getenv("ALLOWED_DBS", "").split(",") if s.strip()]
# 允许访问的表白名单(逗号分隔,库.表 或 表),为空 = 不校验表
ALLOWED_TABLES = [s.strip() for s in os.getenv("ALLOWED_TABLES", "").split(",") if s.strip()]
# 请求鉴权 token:请求头 X-DB-Token 需匹配;为空 = 不鉴权
AUTH_TOKEN = os.getenv("AUTH_TOKEN", "")
# 无 LIMIT 时自动追加的行数
DEFAULT_LIMIT = int(os.getenv("DEFAULT_LIMIT", "100"))
# 硬上限,防止恶意传超大 LIMIT
MAX_LIMIT = int(os.getenv("MAX_LIMIT", "10000"))
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

app = FastAPI(title="db-proxy", version="2.0.0")


# ── 数据源注册表 ──────────────────────────────────────────────
class DataSource:
    """单个数据源配置:name 是请求 db 参数,type 是 mysql/oracle。"""

    def __init__(self, cfg: Dict[str, Any]) -> None:
        self.name: str = str(cfg["name"])
        self.type: str = str(cfg.get("type", "mysql")).strip().lower()
        if self.type not in ("mysql", "oracle"):
            raise ValueError(f"datasource '{self.name}' type must be mysql/oracle")
        self.host: str = str(cfg.get("host", "127.0.0.1"))
        self.port: int = int(cfg.get("port", 3306 if self.type == "mysql" else 1521))
        self.user: str = str(cfg.get("user", ""))
        self.password: str = str(cfg.get("password", ""))
        self.charset: str = str(cfg.get("charset", "utf8mb4" if self.type == "mysql" else "AL32UTF8"))
        # Oracle service_name / MySQL schema(可选,缺省用 name)
        self.service: str = str(cfg.get("service", cfg.get("schema", self.name)))

    def connect(self, connect_timeout: int, query_timeout: int):
        if self.type == "mysql":
            if not _HAS_MYSQL:
                raise RuntimeError("pymysql not installed")
            return pymysql.connect(
                host=self.host,
                port=self.port,
                user=self.user,
                password=self.password,
                database=self.service,
                charset=self.charset,
                connect_timeout=connect_timeout,
                read_timeout=query_timeout,
                write_timeout=query_timeout,
                cursorclass=pymysql.cursors.DictCursor,
            )
        # Oracle thin 模式
        if not _HAS_ORACLE:
            raise RuntimeError("oracledb not installed")
        dsn = f"{self.host}:{self.port}/{self.service}"
        return oracledb.connect(
            user=self.user,
            password=self.password,
            dsn=dsn,
            connect_timeout=connect_timeout,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "type": self.type,
            "host": self.host,
            "port": self.port,
            "user": self.user,
        }


def _load_datasources() -> Dict[str, DataSource]:
    """加载数据源配置:优先 datasources.json,兼容旧单源 env。"""
    sources: Dict[str, DataSource] = {}
    if os.path.exists(DATASOURCES_FILE):
        with open(DATASOURCES_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f)
        items = raw.get("datasources", raw if isinstance(raw, list) else [])
        for cfg in items:
            ds = DataSource(cfg)
            sources[ds.name] = ds
        log.info("loaded %d datasource(s) from %s", len(sources), DATASOURCES_FILE)
        return sources
    # 回退:旧单源 env
    if DB_TYPE in ("mysql", "oracle"):
        ds = DataSource(
            {
                "name": ORACLE_SERVICE if DB_TYPE == "oracle" else "default",
                "type": DB_TYPE,
                "host": DB_HOST,
                "port": DB_PORT,
                "user": DB_USER,
                "password": DB_PASS,
                "service": ORACLE_SERVICE or "default",
            }
        )
        sources[ds.name] = ds
        log.info("no %s, fallback to single env datasource '%s'", DATASOURCES_FILE, ds.name)
    return sources


DATASOURCES = _load_datasources()


def get_datasource(db: str) -> DataSource:
    ds = DATASOURCES.get(db)
    if not ds:
        raise HTTPException(
            status_code=404, detail=f"datasource '{db}' not configured"
        )
    return ds


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


def append_row_limit(sql: str, limit: int, ds_type: str) -> str:
    """按数据库类型追加行数限制语法。"""
    if ds_type == "oracle":
        return f"{sql} FETCH FIRST {limit} ROWS ONLY"
    return f"{sql} LIMIT {limit}"


# ── 数据访问 ──────────────────────────────────────────────────
def _rows_to_dicts(rows: List[Any], description: List[Any]) -> List[Dict[str, Any]]:
    """统一行格式:list[dict],key 为列名。"""
    cols = [d[0].lower() for d in description] if description else []
    return [{cols[i]: r[i] for i in range(len(cols))} for r in rows]


def fetch(sql: str, db: str) -> Dict[str, Any]:
    """连接并执行只读查询,返回 {columns, rows, costMs, truncated}。"""
    ds = get_datasource(db)
    clean_sql = sql.strip().rstrip(";").strip()
    limit = enforce_limit(clean_sql)
    if not LIMIT_RE.search(clean_sql):
        clean_sql = append_row_limit(clean_sql, limit, ds.type)

    start = time.time()
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, QUERY_TIMEOUT)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        cur.execute(clean_sql)
        if ds.type == "mysql":
            rows = cur.fetchall()  # DictCursor → list[dict]
            truncated = len(rows) > limit
            rows = rows[:limit]
            columns = list(rows[0].keys()) if rows else []
        else:
            fetched = cur.fetchmany(limit + 1)
            truncated = len(fetched) > limit
            rows = _rows_to_dicts(fetched[:limit], cur.description)
            columns = list(rows[0].keys()) if rows else []
        cur.close()
    except Exception as e:
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
    # 已配置数据源(白名单过滤后)直接返回
    names = sorted(DATASOURCES.keys())
    if ALLOWED_DBS:
        names = [n for n in names if n in ALLOWED_DBS]
    return {"code": 0, "data": names}


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
    """回显当前配置(脱敏),排查用。"""
    require_auth(x_db_token)
    return {
        "code": 0,
        "data": {
            "datasources": [ds.to_dict() for ds in DATASOURCES.values()],
            "allowedDbs": ALLOWED_DBS or [d for d in DATASOURCES],
            "allowedTables": ALLOWED_TABLES,
            "defaultLimit": DEFAULT_LIMIT,
            "maxLimit": MAX_LIMIT,
            "queryTimeout": QUERY_TIMEOUT,
            "authEnabled": bool(AUTH_TOKEN),
        },
    }


if __name__ == "__main__":
    import uvicorn

    log.info(
        "db-proxy listening on %s:%s (%d datasource(s), auth=%s)",
        LISTEN_HOST,
        LISTEN_PORT,
        len(DATASOURCES),
        "on" if AUTH_TOKEN else "off",
    )
    uvicorn.run(app, host=LISTEN_HOST, port=LISTEN_PORT, log_level="info")
