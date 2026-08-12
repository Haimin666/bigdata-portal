"""db-proxy:数据库只读 HTTP 代理服务(客户机侧)。

运行在可直连数据库的客户机上,把"查询"能力以 HTTP API 暴露给平台。
支持 MySQL 与 Oracle 的**多数据源**(一个服务连多套库,按 db 参数路由)。

**所有配置集中在 datasources.json 一个文件**(代码写死路径,无需其他配置):
  - 服务配置:authToken / listenHost / listenPort / 超时 / 行数限制
  - 白名单:allowedDbs / allowedTables
  - Oracle thick 模式:oracleClientLib
  - 数据源:datasources 数组(每个源独立 type/host/port/账密/service)

设计目标:
  - 只读强制(SELECT/SHOW/DESC/EXPLAIN/WITH),杜绝写操作
  - 库级 + 表级白名单,防越权访问
  - 强制行数上限,防大结果集拖垮(MySQL LIMIT / Oracle 12c+ FETCH / 11g ROWNUM)
  - 连接信息只存在于客户机,平台永远不接触数据库密码
  - AUTH_TOKEN 鉴权,防内网随意调用
  - 执行审计日志

依赖:
  - MySQL:  pymysql(Python 3.7 兼容)
  - Oracle: oracledb>=1.4,<2.2(Python 3.7 兼容,thin 模式无需客户端库;
            连 11g 需配 oracleClientLib 走 thick 模式)
用法:python main.py
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

# ── 配置:全部来自 datasources.json(唯一配置文件)────────────────
CONFIG_FILE = "datasources.json"


def _read_config() -> Dict[str, Any]:
    if not os.path.exists(CONFIG_FILE):
        raise RuntimeError(
            f"config file '{CONFIG_FILE}' not found. "
            "复制 datasources.json.example 为 datasources.json 并填写配置。"
        )
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if "datasources" not in cfg or not isinstance(cfg["datasources"], list):
        raise ValueError("datasources.json must contain a 'datasources' array")
    return cfg


CONFIG = _read_config()

# 服务配置(JSON 顶层,缺失用默认值)
AUTH_TOKEN = str(CONFIG.get("authToken", ""))
LISTEN_HOST = str(CONFIG.get("listenHost", "0.0.0.0"))
LISTEN_PORT = int(CONFIG.get("listenPort", 8756))
DEFAULT_LIMIT = int(CONFIG.get("defaultLimit", 100))
MAX_LIMIT = int(CONFIG.get("maxLimit", 10000))
# SQL 长度上限(字节),防超大 SQL 拖垮客户机/数据库;默认 32KB
MAX_SQL_LEN = int(CONFIG.get("maxSqlLen", 32768))
QUERY_TIMEOUT = int(CONFIG.get("queryTimeout", 60))
DB_CONNECT_TIMEOUT = int(CONFIG.get("connectTimeout", 5))
ALLOWED_DBS = [str(s).strip() for s in CONFIG.get("allowedDbs", []) if str(s).strip()]
ALLOWED_TABLES = [
    str(s).strip() for s in CONFIG.get("allowedTables", []) if str(s).strip()
]
# 可写白名单:格式 "db.table"(单表)或 "db.*"(整库),如 ["finance_order_trade.*", "credzx.audit_log"]
# 命中才允许写操作(INSERT/UPDATE/DELETE),默认只读(不配 = 全只读)
WRITABLE_TABLES = [
    str(s).strip() for s in CONFIG.get("writableTables", []) if str(s).strip()
]
# 可执行过程白名单:格式 "name.procedure"(数据源名.过程名),
# 如 ["credzy.update_balance"]。命中才放行 CALL/BEGIN/EXEC 过程调用;
# 过程内部操作对代理是黑盒,单独授权更清晰。未配 = 禁止执行过程
EXECUTABLE_PROCEDURES = [
    str(s).strip() for s in CONFIG.get("executableProcedures", []) if str(s).strip()
]
# Oracle thick 模式:客户端库目录(含 libclntsh.so),连 11g 必配
ORACLE_CLIENT_LIB = str(CONFIG.get("oracleClientLib", ""))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("db-proxy")

# Spark 引擎配置(顶层 spark 段,缺省 = 禁用;未装 pyspark 不影响 mysql/oracle)
from spark_engine import init_engine  # noqa: E402

SPARK_CFG = CONFIG.get("spark") or {}
SPARK_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SPARK_ENGINE = init_engine(SPARK_CFG, SPARK_BASE_DIR)
if SPARK_ENGINE.enabled:
    log.info("spark engine enabled (master=%s, queue=%s, allowWrite=%s)",
             SPARK_CFG.get("master"), SPARK_CFG.get("queue"), SPARK_CFG.get("allowWrite"))

# Flink 引擎(内嵌 PyFlink,连接常驻 YARN Session;缺省 = 禁用)
from flink_engine import FlinkEngine, _setup_logger as _flink_setup_logger  # noqa: E402

_flink_setup_logger(log)
FLINK_CFG = CONFIG.get("flink") or {}
FLINK_ENGINE = FlinkEngine(FLINK_CFG, os.path.dirname(os.path.abspath(__file__)))
if FLINK_CFG.get("enabled"):
    log.info("flink engine enabled (yarnAppId=%s, allowWrite=%s)",
             FLINK_CFG.get("yarnAppId"), FLINK_CFG.get("allowWrite"))

# 驱动按需导入(未装对应驱动不阻塞另一个类型)
try:
    import pymysql  # type: ignore

    _HAS_MYSQL = True
except ImportError:  # pragma: no cover
    pymysql = None  # type: ignore
    _HAS_MYSQL = False

try:
    import oracledb  # type: ignore

    _HAS_ORACLE = True
    # thick 模式:连 11g 必须用客户端库(thin 不支持 11g)
    if ORACLE_CLIENT_LIB:
        oracledb.init_oracle_client(lib_dir=ORACLE_CLIENT_LIB)
        log.info("oracledb thick mode enabled (lib_dir=%s)", ORACLE_CLIENT_LIB)
    try:
        oracledb.defaults.fetch_lobs = False  # LOB 直接返回字符串
    except AttributeError:
        pass
except ImportError:  # pragma: no cover
    oracledb = None  # type: ignore
    _HAS_ORACLE = False

# 提取 SQL 中出现的表名(粗略:FROM/JOIN/INTO/UPDATE 后跟的表)
TABLE_RE = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:[\"\[]?)([A-Za-z0-9_$.]+)(?:[\"\]]?)?",
    re.IGNORECASE,
)
# 行数上限检测(MySQL/Oracle 通用):LIMIT n 或 FETCH FIRST n ROWS
LIMIT_RE = re.compile(
    r"\b(?:LIMIT\s+(\d+)|FETCH\s+FIRST\s+(\d+)\s+ROWS|ROWNUM\s*(?:<=|<)\s*(\d+))",
    re.IGNORECASE,
)

app = FastAPI(title="db-proxy", version="2.1.0")


# ── 数据源注册表 ──────────────────────────────────────────────
class DataSource:
    """单个数据源配置:name 是请求 db 参数,type 是 mysql/oracle。"""

    def __init__(self, cfg: Dict[str, Any]) -> None:
        self.name: str = str(cfg["name"])
        # 显示别名:下拉/展示用,缺省回退到 name
        self.label: str = str(cfg.get("label", "")).strip() or self.name
        self.type: str = str(cfg.get("type", "mysql")).strip().lower()
        if self.type not in ("mysql", "oracle"):
            raise ValueError(f"datasource '{self.name}' type must be mysql/oracle")
        self.host: str = str(cfg.get("host", "127.0.0.1"))
        self.port: int = int(cfg.get("port", 3306 if self.type == "mysql" else 1521))
        self.user: str = str(cfg.get("user", ""))
        self.password: str = str(cfg.get("password", ""))
        self.charset: str = str(
            cfg.get("charset", "utf8mb4" if self.type == "mysql" else "AL32UTF8")
        )
        # Oracle service_name / MySQL schema(可选,缺省用 name)
        self.service: str = str(cfg.get("service", cfg.get("schema", self.name)))
        # 只读策略(默认 true = 只读,拒绝写操作):
        # 配 readOnly:false 的库放行 INSERT/UPDATE/DELETE 等(预留可写能力)
        self.read_only: bool = bool(cfg.get("readOnly", True))
        # 行数限制语法模式:mysql / fetch(12c+) / rownum(11g)
        # 可选覆盖;不配则 Oracle 连接后自动探测版本(11g→rownum,12c+→fetch)
        self.row_limit: str = str(cfg.get("rowLimit", "")).strip().lower()
        if self.row_limit and self.row_limit not in ("mysql", "fetch", "rownum"):
            raise ValueError(
                f"datasource '{self.name}' rowLimit must be mysql/fetch/rownum"
            )
        # Oracle 主版本缓存(首次连接后探测,-1 表示未知)
        self._oracle_major: int = -1

    def _detect_oracle_version(self, conn) -> int:
        """探测 Oracle 主版本(11.2 → 11,19c → 19)。thin/thick 通用。"""
        try:
            cur = conn.cursor()
            cur.execute("SELECT version FROM v$instance")
            ver = str(cur.fetchone()[0])
            cur.close()
            major = int(ver.split(".")[0])
            return major
        except Exception:
            return -1

    def effective_row_limit(self, conn) -> str:
        """确定实际行数限制模式:配置优先,否则按 Oracle 版本自动推断。"""
        if self.row_limit:
            return self.row_limit
        if self.type == "mysql":
            return "mysql"
        # Oracle:探测主版本,11g(11)用 rownum,12+ 用 fetch
        if self._oracle_major < 0:
            self._oracle_major = self._detect_oracle_version(conn)
        return "rownum" if self._oracle_major <= 11 else "fetch"

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
        # Oracle
        if not _HAS_ORACLE:
            raise RuntimeError("oracledb not installed")
        dsn = f"{self.host}:{self.port}/{self.service}"
        kwargs: Dict[str, Any] = {
            "user": self.user,
            "password": self.password,
            "dsn": dsn,
        }
        # oracledb 1.x 不支持 connect_timeout(2.x 才有),按版本自适应
        try:
            return oracledb.connect(**kwargs, connect_timeout=connect_timeout)
        except TypeError:
            return oracledb.connect(**kwargs)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "label": self.label,
            "type": self.type,
            "host": self.host,
            "port": self.port,
            "user": self.user,
            "rowLimit": self.row_limit,
            "readOnly": self.read_only,
        }


def _load_datasources() -> Dict[str, DataSource]:
    sources: Dict[str, DataSource] = {}
    for cfg in CONFIG["datasources"]:
        ds = DataSource(cfg)
        sources[ds.name] = ds
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
    """鉴权:配置了 authToken 则必须匹配。"""
    if AUTH_TOKEN and x_db_token != AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="unauthorized")


def check_db_allowed(db: str) -> None:
    if ALLOWED_DBS and db not in ALLOWED_DBS:
        raise HTTPException(
            status_code=403, detail=f"database '{db}' not in ALLOWED_DBS"
        )


READ_ONLY_SQL_RE = re.compile(
    r"^\s*(?:--[^\n]*\n\s*|/\*.*?\*/\s*)*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|WITH)\b",
    re.IGNORECASE | re.DOTALL,
)


def check_read_only_sql(sql: str) -> bool:
    """是否为查询类 SQL(SELECT/SHOW/DESC/EXPLAIN/WITH),默认放行。"""
    return bool(READ_ONLY_SQL_RE.match(sql))


def check_single_statement(sql: str) -> None:
    """多语句注入防护:只读库拒绝包含多个分号分隔语句的 SQL。
    允许末尾一个结尾分号(如 'SELECT 1;'),其余分号视为多语句。"""
    s = sql.strip()
    # 去掉末尾分号后,若仍含分号 → 多语句
    body = s.rstrip(";").rstrip()
    if ";" in body:
        raise HTTPException(
            status_code=403,
            detail="multiple statements not allowed (read-only)",
        )


def check_writable(sql: str, db: str) -> None:
    """写操作权限:SQL 涉及的所有表必须命中 WRITABLE_TABLES(name.表 或 name.*)。
    name = 数据源唯一标识(前端请求的 db 参数),多个数据源可指向同一真实库
    (service),权限绑定到数据源而不是库名。SQL 里写真实库名(service)或裸表名
    都会归一化到当前数据源的 name 再匹配。未配置 → 全库只读。"""
    ds = get_datasource(db)
    # 提取写操作涉及的表(INSERT INTO / UPDATE / DELETE FROM)
    tables = [m.group(1) for m in TABLE_RE.finditer(sql)]
    if not tables:
        # 无法识别表名(如 VALUES 常量),保守拒绝
        raise HTTPException(status_code=403, detail="cannot determine target table")
    for t in tables:
        # 归一化为 "name.table":
        # - 裸表名 → 补当前数据源 name
        # - 带前缀且前缀=当前库 service(真实库名)→ 归一化为 name
        # - 其他前缀(跨库引用)→ 按原样
        if "." in t:
            prefix, tbl = t.split(".", 1)
            full = f"{db}.{tbl}" if prefix == ds.service else t
        else:
            full = f"{db}.{t}"
        allowed = False
        for w in WRITABLE_TABLES:
            if w.endswith(".*"):
                # name.* 匹配该数据源所有表
                if full.startswith(w[:-1]):
                    allowed = True
                    break
            elif w == full:
                allowed = True
                break
        if not allowed:
            raise HTTPException(
                status_code=403,
                detail=f"table '{t}' not writable (default read-only)",
            )


def check_executable_procedure(sql: str, db: str) -> None:
    """过程调用校验:提取过程名,命中 EXECUTABLE_PROCEDURES(name.procedure)才放行。
    支持 CALL proc、BEGIN proc; END;、EXEC proc。未配白名单 → 一律拒绝。"""
    s = sql.strip()
    m = re.match(
        r"^(?:CALL|EXEC)\s+([A-Za-z0-9_$.]+)", s, re.IGNORECASE
    ) or re.match(
        r"^BEGIN\s+([A-Za-z0-9_$.]+)\b", s, re.IGNORECASE
    )
    if not m:
        # 非过程语法但也没表名可校验 → 保守拒绝
        raise HTTPException(status_code=403, detail="unsupported statement type")
    proc = m.group(1)
    # 归一化:白名单按 name 配
    # - 裸过程名 "proc" → db.proc
    # - "包.过程" → db.pkg.proc
    # - 已带 db 前缀 "db.proc" / "db.pkg.proc" → 原样
    first = proc.split(".")[0]
    full = proc if first == db or proc.count(".") >= 2 else f"{db}.{proc}"
    if full not in EXECUTABLE_PROCEDURES:
        raise HTTPException(
            status_code=403,
            detail=f"procedure '{proc}' not in executableProcedures",
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
    """提取行数上限:MySQL LIMIT / Oracle FETCH FIRST / Oracle ROWNUM(11g)。"""
    m = LIMIT_RE.search(sql)
    if m:
        limit = int(next(g for g in (m.group(1), m.group(2), m.group(3)) if g is not None))
        if limit > MAX_LIMIT:
            raise HTTPException(
                status_code=400, detail=f"row limit exceeds MAX_LIMIT({MAX_LIMIT})"
            )
        return limit
    return DEFAULT_LIMIT


def append_row_limit(sql: str, limit: int, row_limit: str) -> str:
    """按数据源的行数限制模式追加语法:
    - mysql:  SELECT ... LIMIT n
    - fetch:  SELECT ... FETCH FIRST n ROWS ONLY(12c+)
    - rownum: SELECT * FROM (SELECT ...) WHERE ROWNUM <= n(11g)
    """
    if row_limit == "rownum":
        return f"SELECT * FROM ({sql}) WHERE ROWNUM <= {limit}"
    if row_limit == "fetch":
        return f"{sql} FETCH FIRST {limit} ROWS ONLY"
    return f"{sql} LIMIT {limit}"


# ── 数据访问 ──────────────────────────────────────────────────
def _rows_to_dicts(rows: List[Any], description: List[Any]) -> List[Dict[str, Any]]:
    """统一行格式:list[dict],key 为列名。"""
    cols = [d[0].lower() for d in description] if description else []
    return [{cols[i]: r[i] for i in range(len(cols))} for r in rows]


def fetch(sql: str, db: str) -> Dict[str, Any]:
    """连接并执行 SQL,返回 {columns, rows, costMs, truncated}。
    SELECT 类返回结果集;写语句(INSERT/UPDATE/DELETE)返回受影响行数。"""
    ds = get_datasource(db)
    clean_sql = sql.strip().rstrip(";").strip()
    # 查询类(可追加行数限制)vs 写语句
    is_select = bool(READ_ONLY_SQL_RE.match(clean_sql))
    limit = enforce_limit(clean_sql)

    start = time.time()
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, QUERY_TIMEOUT)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        # 查询类:追加行数限制并取结果集;写语句:直接执行取受影响行数
        if is_select:
            row_mode = ds.effective_row_limit(conn)
            if not LIMIT_RE.search(clean_sql):
                clean_sql = append_row_limit(clean_sql, limit, row_mode)
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
        else:
            # 写语句(INSERT/UPDATE/DELETE):执行并返回受影响行数
            cur = conn.cursor()
            affected = cur.execute(clean_sql)
            conn.commit()
            cur.close()
            return {
                "columns": ["affected_rows"],
                "rows": [{"affected_rows": affected}],
                "costMs": int((time.time() - start) * 1000),
                "truncated": False,
            }
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
    names = sorted(DATASOURCES.keys())
    if ALLOWED_DBS:
        names = [n for n in names if n in ALLOWED_DBS]
    return {"code": 0, "data": names}


@app.post("/query")
def query(
    req: QueryReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    # SQL 长度上限(防超大 SQL)
    if len(req.sql) > MAX_SQL_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"SQL too long: {len(req.sql)} > MAX_SQL_LEN({MAX_SQL_LEN})",
        )
    check_db_allowed(req.db)
    ds = get_datasource(req.db)
    # 查询类(SELECT/SHOW/DESC/EXPLAIN/WITH):默认放行,仅防多语句注入
    if check_read_only_sql(req.sql):
        check_single_statement(req.sql)
    else:
        # 过程调用(CALL/BEGIN/EXEC)→ 单独过程白名单,块内多分号属正常语法
        if re.match(r"^\s*(?:CALL|EXEC|BEGIN)\b", req.sql, re.IGNORECASE):
            check_executable_procedure(req.sql, req.db)
        else:
            check_single_statement(req.sql)
            check_writable(req.sql, req.db)
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
            "allowedDbs": ALLOWED_DBS or sorted(DATASOURCES.keys()),
            "allowedTables": ALLOWED_TABLES,
            "writableTables": WRITABLE_TABLES,
            "executableProcedures": EXECUTABLE_PROCEDURES,
            "defaultLimit": DEFAULT_LIMIT,
            "maxLimit": MAX_LIMIT,
            "maxSqlLen": MAX_SQL_LEN,
            "queryTimeout": QUERY_TIMEOUT,
            "authEnabled": bool(AUTH_TOKEN),
            "oracleThick": bool(ORACLE_CLIENT_LIB),
            "spark": SPARK_ENGINE.status(),
            "flink": FLINK_ENGINE.status(),
        },
    }


# ── Spark 引擎(集成:常驻 client session + SQL/PySpark + 日志透传)────
class SparkQueryReq(BaseModel):
    kind: str = "sql"  # "sql" | "pyspark"
    sql: Optional[str] = None
    code: Optional[str] = None
    writeUnlocked: bool = False
    timeoutMs: int = 600000


@app.post("/spark/query")
def spark_query(
    req: SparkQueryReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not SPARK_ENGINE.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    try:
        if req.kind == "pyspark":
            if not req.code:
                raise HTTPException(status_code=400, detail="code required for pyspark")
            result = SPARK_ENGINE.execute_code(req.code, req.timeoutMs, req.writeUnlocked)
        else:
            if not req.sql:
                raise HTTPException(status_code=400, detail="sql required")
            result = SPARK_ENGINE.execute_sql(req.sql, req.writeUnlocked, req.timeoutMs)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:  # 兜底:任何异常都透传可读信息,避免 500 Internal Server Error
        raise HTTPException(status_code=502, detail=str(e)[:1000])
    return {"code": 0, "data": result}


@app.get("/spark/logs")
def spark_logs(
    jvm: int = 0, audit: int = 0, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not SPARK_ENGINE.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    return {"code": 0, "data": SPARK_ENGINE.read_logs({"jvm": jvm, "audit": audit})}


@app.get("/spark/status")
def spark_status(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not SPARK_ENGINE.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    return {"code": 0, "data": SPARK_ENGINE.status()}


@app.post("/spark/cancel")
def spark_cancel(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    """取消当前正在执行的 spark 查询/代码(手动停止或超时均走此逻辑)。"""
    require_auth(x_db_token)
    if not SPARK_ENGINE.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    cancelled = SPARK_ENGINE.cancel()
    return {"code": 0, "data": {"cancelled": cancelled}}


# ── Flink 引擎(PyFlink 内嵌,连接常驻 YARN Session)──
class FlinkQueryReq(BaseModel):
    sql: str
    limit: Optional[int] = None
    timeoutMs: int = 600000


@app.post("/flink/query")
def flink_query(
    req: FlinkQueryReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    try:
        result = FLINK_ENGINE.execute_sql(req.sql, req.limit or 0)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)[:1000])
    return {"code": 0, "data": result}


@app.post("/flink/cancel")
def flink_cancel(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    cancelled = FLINK_ENGINE.cancel()
    return {"code": 0, "data": {"cancelled": cancelled}}


@app.get("/flink/status")
def flink_status(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    return {"code": 0, "data": FLINK_ENGINE.status()}


# ── 脚本存储(我的目录:保存 SQL 脚本)────────────────────────────
# 目录树元数据:scripts/tree.json;文件内容:scripts/files/<id>.sql
# 可用环境变量 DB_SCRIPTS_DIR 覆盖(docker 挂载建议挂此目录)
SCRIPTS_DIR = os.environ.get("DB_SCRIPTS_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
TREE_FILE = os.path.join(SCRIPTS_DIR, "tree.json")
FILES_DIR = os.path.join(SCRIPTS_DIR, "files")
_TABLE_NAME_RE = re.compile(r"^[A-Za-z0-9_$#.\- ]+$")


def _ensure_scripts() -> None:
    os.makedirs(FILES_DIR, exist_ok=True)
    if not os.path.exists(TREE_FILE):
        with open(TREE_FILE, "w", encoding="utf-8") as f:
            json.dump({"my": []}, f, ensure_ascii=False, indent=2)


def _load_tree() -> Dict[str, Any]:
    _ensure_scripts()
    try:
        with open(TREE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"my": []}


def _save_tree(tree: Dict[str, Any]) -> None:
    _ensure_scripts()
    with open(TREE_FILE, "w", encoding="utf-8") as f:
        json.dump(tree, f, ensure_ascii=False, indent=2)


def _find_node(nodes: List[Dict[str, Any]], nid: str):
    """在树中按 id 找节点(深度优先),返回 (节点, 父列表)。"""
    for i, n in enumerate(nodes):
        if n.get("id") == nid:
            return n, nodes
        if n.get("type") == "dir" and n.get("children"):
            found = _find_node(n["children"], nid)
            if found:
                return found
    return None


def _insert_node(parent: Optional[Dict[str, Any]], node: Dict[str, Any]) -> None:
    if parent is None:
        return
    parent.setdefault("children", []).append(node)


def _validate_name(name: str) -> str:
    name = (name or "").strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="非法名称")
    return name


@app.get("/scripts/tree")
def scripts_tree(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    return {"code": 0, "data": _load_tree()}


class ScriptNewReq(BaseModel):
    parentId: Optional[str] = None  # 空 = 根目录
    name: str
    kind: str  # "dir" | "file"


@app.post("/scripts/new")
def scripts_new(
    req: ScriptNewReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    if req.kind not in ("dir", "file"):
        raise HTTPException(status_code=400, detail="kind must be dir|file")
    name = _validate_name(req.name)
    tree = _load_tree()
    my = tree["my"]
    parent = _find_node(my, req.parentId)[0] if req.parentId else None
    if req.parentId and (not parent or parent.get("type") != "dir"):
        raise HTTPException(status_code=404, detail="父目录不存在")
    node = {"id": uuid.uuid4().hex[:12], "name": name, "type": req.kind}
    if req.kind == "dir":
        node["children"] = []
    _insert_node(parent, node)
    _save_tree(tree)
    return {"code": 0, "data": node}


class ScriptRenameReq(BaseModel):
    id: str
    name: str


@app.post("/scripts/rename")
def scripts_rename(
    req: ScriptRenameReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    name = _validate_name(req.name)
    tree = _load_tree()
    found = _find_node(tree["my"], req.id)
    if not found:
        raise HTTPException(status_code=404, detail="节点不存在")
    node = found[0]
    if node.get("type") == "file" and not name.endswith(".sql"):
        name += ".sql"
    node["name"] = name
    _save_tree(tree)
    return {"code": 0, "data": node}


class ScriptDeleteReq(BaseModel):
    id: str


def _collect_file_ids(nodes: List[Dict[str, Any]], out: List[str]) -> None:
    for n in nodes:
        if n.get("type") == "file":
            out.append(n["id"])
        elif n.get("type") == "dir" and n.get("children"):
            _collect_file_ids(n["children"], out)


@app.post("/scripts/delete")
def scripts_delete(
    req: ScriptDeleteReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    tree = _load_tree()
    found = _find_node(tree["my"], req.id)
    if not found:
        raise HTTPException(status_code=404, detail="节点不存在")
    node, parent = found
    file_ids: List[str] = []
    _collect_file_ids([node], file_ids)
    parent.remove(node)
    for fid in file_ids:
        fp = os.path.join(FILES_DIR, f"{fid}.sql")
        if os.path.exists(fp):
            os.remove(fp)
    _save_tree(tree)
    return {"code": 0, "msg": "deleted"}


class ScriptSaveReq(BaseModel):
    id: str
    content: str


@app.post("/scripts/save")
def scripts_save(
    req: ScriptSaveReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    tree = _load_tree()
    found = _find_node(tree["my"], req.id)
    if not found or found[0].get("type") != "file":
        raise HTTPException(status_code=404, detail="文件不存在")
    _ensure_scripts()
    with open(os.path.join(FILES_DIR, f"{req.id}.sql"), "w", encoding="utf-8") as f:
        f.write(req.content)
    return {"code": 0, "msg": "saved"}


@app.get("/scripts/get")
def scripts_get(
    id: str, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    tree = _load_tree()
    found = _find_node(tree["my"], id)
    if not found or found[0].get("type") != "file":
        raise HTTPException(status_code=404, detail="文件不存在")
    fp = os.path.join(FILES_DIR, f"{id}.sql")
    content = ""
    if os.path.exists(fp):
        with open(fp, "r", encoding="utf-8") as f:
            content = f.read()
    return {"code": 0, "data": {"id": id, "content": content}}


# ── 表目录(库→表→字段,只读元数据)────────────────────────────
@app.get("/tables")
def tables(db: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    check_db_allowed(db)
    ds = get_datasource(db)
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, QUERY_TIMEOUT)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            cur.execute("SHOW TABLES")
            rows = cur.fetchall()
            names = [list(r.values())[0] for r in rows]
        else:
            cur.execute("SELECT table_name FROM user_tables ORDER BY table_name")
            rows = cur.fetchall()
            names = [r[0] for r in rows]
        cur.close()
    finally:
        conn.close()
    return {"code": 0, "data": names}


@app.get("/fields")
def fields(
    db: str, table: str, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    check_db_allowed(db)
    if not _TABLE_NAME_RE.match(table or ""):
        raise HTTPException(status_code=400, detail="非法表名")
    ds = get_datasource(db)
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, QUERY_TIMEOUT)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            cur.execute(f"DESC `{table}`")
            rows = cur.fetchall()
            cols = [
                {"name": list(r.values())[0], "type": list(r.values())[1]}
                for r in rows
            ]
        else:
            cur.execute(
                "SELECT column_name, data_type FROM user_tab_columns "
                "WHERE table_name = :t ORDER BY column_id",
                {"t": table.upper()},
            )
            rows = cur.fetchall()
            cols = [{"name": r[0], "type": r[1]} for r in rows]
        cur.close()
    finally:
        conn.close()
    return {"code": 0, "data": cols}


if __name__ == "__main__":
    import uvicorn

    log.info(
        "db-proxy listening on %s:%s (%d datasource(s), auth=%s, oracleThick=%s)",
        LISTEN_HOST,
        LISTEN_PORT,
        len(DATASOURCES),
        "on" if AUTH_TOKEN else "off",
        "on" if ORACLE_CLIENT_LIB else "off",
    )
    uvicorn.run(app, host=LISTEN_HOST, port=LISTEN_PORT, log_level="info")
