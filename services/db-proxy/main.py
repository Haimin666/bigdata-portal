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
import secrets
import collections
import threading
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
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
# 可写白名单 / 过程白名单已移除:权限管控收口到门户网关(密码解锁),db-proxy 仅保留
# 鉴权 + 库/表白名单 + 资源护栏(多语句/行数/长度/超时)
# Oracle thick 模式:客户端库目录(含 libclntsh.so),连 11g 必配
ORACLE_CLIENT_LIB = str(CONFIG.get("oracleClientLib", ""))

# 服务端资源护栏:同时执行上限 + 请求限速(防批量请求刷爆数据库连接/拖垮库)
MAX_CONCURRENT = int(CONFIG.get("maxConcurrent", 5))
MAX_QPS = int(CONFIG.get("maxQps", 10))
_query_semaphore = threading.Semaphore(MAX_CONCURRENT)
_qps_lock = threading.Lock()
_qps_window = collections.deque()

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
from flink_connectors import FlinkConnectors, _setup_logger as _flink_conn_setup_logger  # noqa: E402
from flink_prejob import FlinkPreJobManager, _setup_logger as _flink_prejob_setup_logger  # noqa: E402

_flink_setup_logger(log)
_flink_conn_setup_logger(log)
_flink_prejob_setup_logger(log)
FLINK_CFG = CONFIG.get("flink") or {}
FLINK_ENGINE = FlinkEngine(FLINK_CFG, os.path.dirname(os.path.abspath(__file__)))
FLINK_CONNECTORS = FlinkConnectors(FLINK_CFG, os.path.dirname(os.path.abspath(__file__)))
FLINK_PREJOB = FlinkPreJobManager(
    FLINK_CFG.get("prejob") or {},
    os.path.dirname(os.path.abspath(__file__)),
    fallback=FLINK_CFG,
)
if FLINK_CFG.get("enabled"):
    log.info("flink engine enabled (yarnAppId=%s, allowWrite=%s)",
             FLINK_CFG.get("yarnAppId"), FLINK_CFG.get("allowWrite"))
if FLINK_PREJOB.enabled:
    log.info("flink prejob enabled (mode=yarn-per-job, queue=%s, flinkHome=%s)",
             FLINK_PREJOB.status().get("queue"), FLINK_PREJOB.status().get("flinkHome"))

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

# 提取 SQL 中出现的表名(粗略:FROM/JOIN/INTO/UPDATE/TABLE 后跟的表)。
# 支持 MySQL 反引号完整标识符 `db`.`tbl` 与单段 `tbl`;普通名可带 "库.表"
# (点号后必须跟名字段,避免 `db.` 尾点误提取)。
TABLE_RE = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+"
    r"(?:`([^`]+)`\.`([^`]+)`|`([^`]+)`|[\"\[(]?([A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*)[\"\]]?)",
    re.IGNORECASE,
)
# 反引号混合形态补充:`db`.tbl、db.`tbl`(限定表关键字后,避免命中字符串字面量)
BACKTICK_TABLE_RE = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+"
    r"(?:`([^`]+)`\s*\.\s*([A-Za-z0-9_$]+)|([A-Za-z0-9_$]+)\s*\.\s*(`[^`]+`))",
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
        # 只读策略(默认 false = 写操作放行,权限收口到门户网关密码解锁):
        # 配 readOnly:true 的数据源强制只读(纵深保护,如只读账号/敏感库),拒绝一切非查询 SQL
        self.read_only: bool = bool(cfg.get("readOnly", False))
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
    """是否为查询类 SQL(SELECT/SHOW/DESC/EXPLAIN/WITH),用于区分查询/写执行路径。"""
    return bool(READ_ONLY_SQL_RE.match(sql))


def _strip_sql_literals(sql: str) -> str:
    """剥离注释与字符串字面量,用于语句/表名检查(避免字符串里的 FROM/JOIN/分号被误判)。"""
    s = re.sub(r"--[^\n]*|/\*[\s\S]*?\*/", "", sql)
    s = re.sub(r"'[^']*'", "''", s)
    s = re.sub(r'"[^"]*"', '""', s)
    return s


def check_single_statement(sql: str) -> None:
    """多语句注入防护:拒绝包含多个分号分隔语句的 SQL。
    允许末尾一个结尾分号(如 'SELECT 1;'),其余分号视为多语句。
    先剥离字符串/注释,避免 'SELECT \'a;b\'' 被误判。"""
    s = _strip_sql_literals(sql).strip()
    # 去掉末尾分号后,若仍含分号 → 多语句
    body = s.rstrip(";").rstrip()
    if ";" in body:
        raise HTTPException(
            status_code=403,
            detail="multiple statements not allowed",
        )


def check_tables_allowed(sql: str) -> None:
    """表级白名单:从 SQL 提取表名,不在白名单拒绝。"""
    if not ALLOWED_TABLES:
        return
    # 提取用剥离字符串/注释后的 SQL,避免 'from xxx' 字符串被误提取
    clean = _strip_sql_literals(sql)
    names: List[str] = []
    seen = set()

    def _add(n: Optional[str]) -> None:
        n = (n or "").replace("`", "").strip()
        if not n or n in seen:
            return
        seen.add(n)
        names.append(n)

    for m in TABLE_RE.finditer(clean):
        # 反引号双段 `db`.`tbl` → 拼完整名;单段/普通名取对应组
        if m.group(1) and m.group(2):
            _add(f"{m.group(1)}.{m.group(2)}")
        else:
            _add(m.group(3) or m.group(4))
    for m in BACKTICK_TABLE_RE.finditer(clean):
        if m.group(1) and m.group(2):
            _add(f"{m.group(1)}.{m.group(2)}")
        elif m.group(3) and m.group(4):
            _add(f"{m.group(3)}.{m.group(4)}")
    # 完整名(含 .)优先判定;裸名中若是某个完整名的库前缀,不单独判定(避免误拒)
    full_names = [t for t in names if "." in t]
    db_prefixes = {f.split(".", 1)[0] for f in full_names}
    bare_extra = [t for t in names if "." not in t and t not in db_prefixes]
    for table in full_names + bare_extra:
        bare = table.split(".", 1)[-1]
        # 支持 "库.表" 完整名或裸表名,任一匹配即通过
        if table in ALLOWED_TABLES or bare in ALLOWED_TABLES:
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


class DbError(Exception):
    """数据库执行错误(结构化,类似 SQL 客户端:类型 + 错误码)。"""

    def __init__(self, engine: str, error_type: str, error_code, message: str):
        super().__init__(message)
        self.engine = engine
        self.error_type = error_type
        self.error_code = error_code
        self.message = message


_MYSQL_ERROR_TYPES = {
    1045: "AccessDenied", 1049: "UnknownDatabase", 1054: "ColumnNotFound",
    1062: "DuplicateEntry", 1064: "SyntaxError", 1142: "TableAccessDenied",
    1146: "TableNotFound", 1205: "LockWaitTimeout", 1213: "Deadlock",
    1364: "FieldNotDefault", 1406: "DataTooLong",
    1451: "ForeignKeyViolation", 1452: "ForeignKeyViolation",
    2002: "ConnectError", 2003: "ConnectError", 2006: "ConnectError", 2013: "ConnectError",
}

_ORACLE_ERROR_TYPES = {
    "ORA-00001": "DuplicateEntry", "ORA-00900": "SyntaxError",
    "ORA-00904": "ColumnNotFound", "ORA-00933": "SyntaxError",
    "ORA-00942": "TableNotFound", "ORA-01017": "AccessDenied",
    "ORA-01400": "FieldNotDefault", "ORA-01401": "DataTooLong",
    "ORA-12154": "ConnectError", "ORA-12541": "ConnectError",
    "ORA-12560": "ConnectError", "ORA-00060": "Deadlock",
}


def _extract_sql_error(e: Exception, engine: str) -> DbError:
    """从数据库驱动异常提取结构化错误(类型 + 错误码 + 消息)。

    - MySQL(pymysql):异常 args[0] 为 errno(如 1064),args[1] 为消息
    - Oracle(oracledb):e.full_code(ORA-xxxxx)/e.code/e.message
    """
    msg = str(e)
    if engine == "mysql":
        code = None
        args = getattr(e, "args", ())
        if args and isinstance(args[0], int):
            code = args[0]
            if len(args) > 1:
                msg = str(args[1])
        etype = _MYSQL_ERROR_TYPES.get(code, "DatabaseError")
        return DbError(engine, etype, code, msg)
    if engine == "oracle":
        full = getattr(e, "full_code", None) or ""
        code = full or getattr(e, "code", None)
        etype = "DatabaseError"
        if full:
            etype = _ORACLE_ERROR_TYPES.get(full, "DatabaseError")
        m = getattr(e, "message", None) or msg
        return DbError(engine, etype, code, m)
    return DbError(engine, "DatabaseError", None, msg)


def fetch(sql: str, db: str) -> Dict[str, Any]:
    """连接并执行 SQL,返回 {columns, rows, costMs, truncated}。
    SELECT 类返回结果集;写语句(INSERT/UPDATE/DELETE)返回受影响行数。"""
    ds = get_datasource(db)
    clean_sql = sql.strip().rstrip(";").strip()
    # 查询类(可追加行数限制)vs 写语句
    is_select = bool(READ_ONLY_SQL_RE.match(clean_sql))
    # WITH 前缀的 CTE-DML(WITH cte AS (...) INSERT/UPDATE/DELETE ...)不是只读,防绕过只读保护。
    # 判定用「去注释后」的 SQL:/* */ 或 -- 注释前缀不应掩盖 WITH 前缀
    no_comments = re.sub(r"--[^\n]*|/\*[\s\S]*?\*/", "", clean_sql).strip()
    # 与网关 isSparkWriteSql 对齐:可执行注释(/*! /*M!)与 SELECT 走私(INTO OUTFILE/DUMPFILE、
    # LOAD_FILE())一律视为非查询(仅用于类型判定/只读保护,不影响执行)
    if re.search(r"\*[Mm]?!", clean_sql) or re.search(
        r"\bINTO\s+(OUTFILE|DUMPFILE)\b|\bLOAD_FILE\s*\(", clean_sql, re.IGNORECASE
    ):
        is_select = False
    if is_select and re.match(r"^\s*WITH\b", no_comments, re.IGNORECASE):
        if re.search(
            r"\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b",
            no_comments,
            re.IGNORECASE,
        ):
            is_select = False
    # 数据源级只读:显式 readOnly:true 的库拒绝一切非查询 SQL(纵深保护)
    if ds.read_only and not is_select:
        raise HTTPException(
            status_code=403,
            detail=f"datasource '{ds.name}' is read-only (readOnly:true), write SQL not allowed",
        )
    limit = enforce_limit(clean_sql)

    start = time.time()
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, QUERY_TIMEOUT)
    except Exception as e:
        de = _extract_sql_error(e, ds.type)
        if de.error_type == "DatabaseError":
            de = DbError(ds.type, "ConnectError", de.error_code, de.message)
        raise DbError(ds.type, de.error_type, de.error_code, f"connect failed: {de.message}")
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
        de = _extract_sql_error(e, ds.type)
        raise DbError(ds.type, de.error_type, de.error_code, f"query failed: {de.message}")
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
    # 并发上限:超过同时执行数直接拒绝(防打爆数据库连接)
    if not _query_semaphore.acquire(blocking=False):
        raise HTTPException(
            status_code=429, detail=f"too many concurrent queries (max={MAX_CONCURRENT})"
        )
    try:
        _check_qps()
        # SQL 长度上限(防超大 SQL)
        if len(req.sql) > MAX_SQL_LEN:
            raise HTTPException(
                status_code=400,
                detail=f"SQL too long: {len(req.sql)} > MAX_SQL_LEN({MAX_SQL_LEN})",
            )
        check_db_allowed(req.db)
        ds = get_datasource(req.db)
        # 权限管控已收口到门户网关(密码解锁);此处仅保留资源护栏:
        # 1) 多语句防护(防注入走私) 2) 表级白名单(如配置) 3) 行数/长度/超时
        if re.match(r"^\s*(?:CALL|EXEC|BEGIN)\b", req.sql, re.IGNORECASE):
            pass  # 过程块内多分号属正常语法,放行
        else:
            check_single_statement(req.sql)
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
    except DbError as e:
        # 结构化 SQL 错误(类似 SQL 客户端:类型 + 错误码)
        return JSONResponse(
            status_code=502,
            content={
                "code": 502,
                "errorType": e.error_type,
                "errorCode": e.error_code,
                "detail": "%s %s%s: %s" % (
                    e.engine,
                    e.error_type,
                    (" [%s]" % e.error_code) if e.error_code is not None else "",
                    e.message,
                )[:500],
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        log.exception("query unexpected error: %.300s", str(e))
        raise HTTPException(status_code=500, detail=str(e)[:500])
    finally:
        _query_semaphore.release()


def _check_qps() -> None:
    """滑动窗口限速:1 秒窗口内超过 MAX_QPS 拒绝。"""
    now = time.time()
    with _qps_lock:
        _qps_window.append(now)
        while _qps_window and now - _qps_window[0] > 1.0:
            _qps_window.popleft()
        if len(_qps_window) > MAX_QPS:
            raise HTTPException(
                status_code=429, detail=f"too many requests (max {MAX_QPS} qps)"
            )


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
            "defaultLimit": DEFAULT_LIMIT,
            "maxLimit": MAX_LIMIT,
            "maxSqlLen": MAX_SQL_LEN,
            "maxConcurrent": MAX_CONCURRENT,
            "maxQps": MAX_QPS,
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
    timeoutMs: int = 120000  # 与门户/前端默认 120s 对齐;超时自动 cancelJobGroup 释放锁


def _check_spark_write_creds(write_unlocked: bool, req_token: Optional[str]) -> None:
    """写解锁凭证服务端校验(S1):
    writeUnlocked=true 必须携带与配置一致的 X-Spark-Write 头(共享密钥,
    仅门户网关持有,与 datasources.json spark.writeToken 一致)。
    堵死直连 db-proxy 的调用者伪造 writeUnlocked 绕过门户鉴权。
    未配置 writeToken → 一律拒绝写(安全默认)。
    """
    if not write_unlocked:
        return
    cfg_token = str(SPARK_CFG.get("writeToken", "") or "")
    if not cfg_token:
        raise HTTPException(
            status_code=403,
            detail="spark write disabled on db-proxy (datasources.json spark.writeToken 未配置)",
        )
    if not req_token or not secrets.compare_digest(cfg_token, req_token):
        raise HTTPException(
            status_code=403, detail="spark write token mismatch (无法自行解锁写权限)"
        )


@app.post("/spark/query")
def spark_query(
    req: SparkQueryReq,
    x_db_token: Optional[str] = Header(default=None),
    x_spark_write: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not SPARK_ENGINE.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    try:
        # 写解锁凭证校验:writeUnlocked=true 必须经门户携带共享密钥,防直连伪造
        _check_spark_write_creds(req.writeUnlocked, x_spark_write)
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
    mode: str = "batch"  # batch=即席查询(秒回) / stream=流式任务(后台常驻)
    writeUnlocked: bool = False  # 与 spark 同语义:写语句需门户解锁后置位(服务端校验 X-Spark-Write)


class FlinkDdlReq(BaseModel):
    tableName: str
    connector: str
    params: Dict[str, Any] = {}
    fields: List[Dict[str, Any]] = []


@app.post("/flink/query")
def flink_query(
    req: FlinkQueryReq,
    x_db_token: Optional[str] = Header(default=None),
    x_spark_write: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    mode = req.mode if req.mode in ("batch", "stream") else "batch"
    try:
        # 写解锁凭证校验:与 spark 同密钥体系,防直连伪造 writeUnlocked 绕过
        _check_spark_write_creds(req.writeUnlocked, x_spark_write)
        result = FLINK_ENGINE.execute_script(
            req.sql, req.limit or 0, mode=mode, write_unlocked=req.writeUnlocked
        )
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        if log:
            log.exception("flink query failed: %.200s", str(e))
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


# ── Flink 连接器与 DDL 生成 ───────────────────────────────
@app.get("/flink/connectors")
def flink_connectors(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    return {"code": 0, "data": {"connectors": FLINK_CONNECTORS.list_connectors()}}


class FlinkProbeReq(BaseModel):
    params: Dict[str, Any] = {}


@app.post("/flink/connectors/{conn_name}/probe")
def flink_connector_probe(
    conn_name: str, req: FlinkProbeReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    try:
        result = FLINK_CONNECTORS.probe_schema(conn_name, req.params)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except NotImplementedError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)[:1000])
    return {"code": 0, "data": result}


@app.post("/flink/ddl/generate")
def flink_ddl_generate(req: FlinkDdlReq, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    try:
        ddl = FLINK_CONNECTORS.generate_ddl(req.tableName, req.connector, req.params, req.fields)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"code": 0, "data": {"ddl": ddl}}


# ── Flink 流式任务管理 ────────────────────────────────────
@app.get("/flink/jobs")
def flink_jobs(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    return {"code": 0, "data": {"jobs": FLINK_ENGINE.list_jobs()}}


@app.get("/flink/jobs/{job_id}")
def flink_job_status(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    try:
        return {"code": 0, "data": FLINK_ENGINE.job_status(job_id)}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/flink/jobs/{job_id}/stop")
def flink_job_stop(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    try:
        stopped = FLINK_ENGINE.stop_job(job_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"code": 0, "data": {"stopped": stopped}}


# ── Flink PreJob 提交(yarn-per-job 独立作业,与交互会话隔离)──
class FlinkPreJobReq(BaseModel):
    name: str = ""
    sql: str
    queue: Optional[str] = None
    writeUnlocked: bool = False  # 写类 prejob 需门户解锁后置位(服务端校验 X-Spark-Write)


def _prejob_guard() -> None:
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    if not FLINK_PREJOB.enabled:
        raise HTTPException(
            status_code=503, detail="flink prejob disabled (datasources.json flink.prejob.enabled=false)"
        )


@app.get("/flink/prejob/config")
def flink_prejob_config(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    return {"code": 0, "data": FLINK_PREJOB.status()}


@app.post("/flink/prejob/jobs")
def flink_prejob_submit(
    req: FlinkPreJobReq,
    x_db_token: Optional[str] = Header(default=None),
    x_spark_write: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    try:
        # 写凭证校验:与 spark/flink 交互同密钥体系,防直连伪造 writeUnlocked 向 YARN 提交写作业
        _check_spark_write_creds(req.writeUnlocked, x_spark_write)
        return {"code": 0, "data": FLINK_PREJOB.submit(
            req.name, req.sql, queue=req.queue, write_unlocked=req.writeUnlocked
        )}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.exception("flink prejob submit failed: %.200s", str(e))
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/flink/prejob/jobs")
def flink_prejob_jobs(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    return {"code": 0, "data": {"jobs": FLINK_PREJOB.list_jobs()}}


@app.get("/flink/prejob/jobs/{job_id}")
def flink_prejob_status(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    try:
        return {"code": 0, "data": FLINK_PREJOB.job_status(job_id)}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/flink/prejob/jobs/{job_id}/logs")
def flink_prejob_logs(job_id: str, tail: int = 200, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    try:
        return {"code": 0, "data": FLINK_PREJOB.logs(job_id, tail=tail)}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/flink/prejob/jobs/{job_id}/cancel")
def flink_prejob_cancel(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    try:
        cancelled = FLINK_PREJOB.cancel(job_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"code": 0, "data": {"cancelled": cancelled}}


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
