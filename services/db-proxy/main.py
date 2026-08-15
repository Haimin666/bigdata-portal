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
import datetime
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
    from spark_engine import SparkJobManager
    SPARK_JOBS = SparkJobManager(SPARK_ENGINE)
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


# ── 写操作审计(MySQL/Oracle/Doris 写 SQL 执行审计,JSON Lines)────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
AUDIT_DIR = os.path.join(BASE_DIR, "audit")
AUDIT_LOG_FILE = os.path.join(AUDIT_DIR, "audit-db.log")
_audit_lock = threading.Lock()


def _is_write_sql(sql: str) -> bool:
    """写语句判定:非 SELECT/EXPLAIN/SHOW/DESC/DESCRIBE 开头即视为写
    (INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/DROP/TRUNCATE/GRANT/REVOKE/COMMENT/SET 等)。
    与 READ_ONLY_SQL_RE 对齐:注释前缀先剥,末尾分号不影响判定。"""
    if not sql or not sql.strip():
        return False
    return not bool(READ_ONLY_SQL_RE.match(sql))


def _write_audit(
    db: str,
    engine: str,
    sql: str,
    affected: Optional[int],
    cost_ms: float,
    source: str,
    blocked: bool = False,
) -> None:
    """追加一条写操作审计到 audit/audit-db.log(线程安全,独立锁)。
    sql 截断 500;审计写失败只记 warning,绝不干扰查询主流程。"""
    try:
        os.makedirs(AUDIT_DIR, mode=0o700, exist_ok=True)
        rec: Dict[str, Any] = {
            "ts": datetime.datetime.now().isoformat(sep="T"),
            "db": db,
            "engine": engine,
            "sql": (sql or "")[:500],
            "affected": affected,
            "costMs": int(cost_ms or 0),
            "source": source,
        }
        if blocked:
            rec["blocked"] = True
        line = json.dumps(rec, ensure_ascii=False)
        with _audit_lock:
            with open(AUDIT_LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
            # 审计日志含完整 SQL,收紧权限:文件 0600(目录已在 makedirs 时 0700)
            try:
                os.chmod(AUDIT_LOG_FILE, 0o600)
            except Exception:
                pass
    except Exception as e:  # 审计失败不影响查询结果
        log.warning("audit write failed: %s", e)


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


def _prepare_query(sql: str, db: str, timeout_ms: Optional[int] = None, source: str = "sync"):
    """解析/校验 SQL,返回 (ds, clean_sql, is_select, limit, q_timeout, start)。
    供 fetch(同步)与 DbJobManager(异步,需持有连接才能取消)共用。"""
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
        # 写尝试即使未执行也要审计(affected=null, blocked=true)
        _write_audit(db, ds.type, clean_sql, None, 0.0, source, blocked=True)
        raise HTTPException(
            status_code=403,
            detail=f"datasource '{ds.name}' is read-only (readOnly:true), write SQL not allowed",
        )
    # 与同步 /query 对齐:异步任务路径(/jobs)此前缺失多语句走私防护与表级白名单,
    # 必须在此补齐(网关 /api/db/jobs 已做写解锁校验,此处为第二道防线)
    if re.match(r"^\s*(?:CALL|EXEC|BEGIN)\b", clean_sql, re.IGNORECASE):
        pass  # 过程块内多分号属正常语法,放行
    else:
        check_single_statement(clean_sql)
    check_tables_allowed(clean_sql)
    limit = enforce_limit(clean_sql)
    q_timeout = int(timeout_ms / 1000) if timeout_ms else QUERY_TIMEOUT
    return ds, clean_sql, is_select, limit, q_timeout, time.time()


def _execute_query(ds: Any, conn: Any, clean_sql: str, is_select: bool, limit: int, start: float) -> Dict[str, Any]:
    """在已建立的连接上执行(连接由调用方管理,以便异步 job 取消时 close 中断)。"""
    if is_select:
        # 查询类:追加行数限制并取结果集
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
        return {
            "columns": columns,
            "rows": rows,
            "costMs": int((time.time() - start) * 1000),
            "truncated": truncated,
        }
    # 写语句(INSERT/UPDATE/DELETE):执行并返回受影响行数
    # 注意:pymysql 的 execute() 返回受影响行数,但 python-oracledb 返回 None,
    # 统一用 cursor.rowcount(commit 前有效,此处顺序正确),修复 Oracle 审计 affected 恒 null。
    cur = conn.cursor()
    cur.execute(clean_sql)
    affected = cur.rowcount
    conn.commit()
    cur.close()
    return {
        "columns": ["affected_rows"],
        "rows": [{"affected_rows": affected}],
        "costMs": int((time.time() - start) * 1000),
        "truncated": False,
    }


def fetch(sql: str, db: str, timeout_ms: Optional[int] = None, source: str = "sync") -> Dict[str, Any]:
    """连接并执行 SQL,返回 {columns, rows, costMs, truncated}。
    SELECT 类返回结果集;写语句(INSERT/UPDATE/DELETE)返回受影响行数。
    timeout_ms:覆盖默认查询超时(异步 job 用,大查询可传更长,不撞网关 60s)。
    写语句执行(成功/失败/连接失败)后追加一条审计日志(source='sync'|'async')。"""
    ds, clean_sql, is_select, limit, q_timeout, start = _prepare_query(
        sql, db, timeout_ms, source=source
    )
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        de = _extract_sql_error(e, ds.type)
        if de.error_type == "DatabaseError":
            de = DbError(ds.type, "ConnectError", de.error_code, de.message)
        if not is_select:
            _write_audit(db, ds.type, clean_sql, None, (time.time() - start) * 1000, source)
        raise DbError(ds.type, de.error_type, de.error_code, f"connect failed: {de.message}")
    try:
        result = _execute_query(ds, conn, clean_sql, is_select, limit, start)
        if not is_select:
            affected = (
                result["rows"][0].get("affected_rows") if result.get("rows") else None
            )
            _write_audit(db, ds.type, clean_sql, affected, result["costMs"], source)
        return result
    except Exception as e:
        if not is_select:
            _write_audit(db, ds.type, clean_sql, None, (time.time() - start) * 1000, source)
        de = _extract_sql_error(e, ds.type)
        raise DbError(ds.type, de.error_type, de.error_code, f"query failed: {de.message}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ── 接口 ──────────────────────────────────────────────────────
class QueryReq(BaseModel):
    db: str
    sql: str
    timeoutMs: int = 0  # 异步 job 用(毫秒,0=默认 1 小时);同步 /query 忽略


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


class DbJobManager:
    """通用数据库异步任务(mysql/oracle):提交即返回 jobId,后台线程执行。

    动机:公司网关固定 60s 读超时,mysql/oracle 慢查询/大查询同步挂起
    会被掐断 504;异步化后提交/查状态/取消均为秒级往返。
    前端体验保持不变:持续 loading,直到完成/失败/手动停止。
    """

    def __init__(self, max_jobs: int = 200, ttl: int = 3600) -> None:
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._seq = 0
        self._max_jobs = max_jobs
        self._ttl = ttl

    def submit(self, db: str, sql: str, timeout_ms: int = 3600000) -> str:
        # 与同步 /query 共享并发信号量 + QPS 限制,防止异步 job 无限并发打爆数据库连接
        if not _query_semaphore.acquire(blocking=False):
            raise HTTPException(
                status_code=429, detail=f"too many concurrent queries (max={MAX_CONCURRENT})"
            )
        _check_qps()
        try:
            with self._lock:
                self._seq += 1
                job_id = "dbj_%d_%04d" % (int(time.time()), self._seq)
                self._jobs[job_id] = {
                    "id": job_id, "state": "queued", "db": db, "sql": sql,
                    "timeout_ms": timeout_ms, "created_at": time.time(),
                    "started_at": None, "finished_at": None,
                    "result": None, "error": None, "conn": None, "cancel_requested": False,
                }
            threading.Thread(target=self._run, args=(job_id,), daemon=True, name="db-job-%s" % job_id).start()
            return job_id
        except Exception:
            _query_semaphore.release()
            raise

    def _run(self, job_id: str) -> None:
        try:
            self._run_inner(job_id)
        finally:
            # 无论成功/失败/取消,释放并发信号量(submit 已 acquire)
            _query_semaphore.release()

    def _run_inner(self, job_id: str) -> None:
        j = self._jobs.get(job_id)
        if not j:
            return
        if j.get("cancel_requested"):  # 提交后未开始即被取消
            j["state"] = "cancelled"
            j["finished_at"] = time.time()
            return
        j["state"] = "running"
        j["started_at"] = time.time()
        conn = None
        clean_sql = ""
        is_select = False
        start = time.time()
        try:
            # 异步 job 用更长查询超时(默认 1 小时,可配置),不再受网关 60s 限制
            ds, clean_sql, is_select, limit, q_timeout, start = _prepare_query(j["sql"], j["db"], j["timeout_ms"], source="async")
            conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
            j["conn"] = conn  # 持有连接:取消时 close 中断底层查询(真停止)
            try:
                result = _execute_query(ds, conn, clean_sql, is_select, limit, start)
            finally:
                j["conn"] = None
                try:
                    conn.close()
                except Exception:
                    pass
            if not is_select:
                # 异步写执行成功:审计(source='async')
                affected = (
                    result["rows"][0].get("affected_rows") if result.get("rows") else None
                )
                _write_audit(j["db"], ds.type, clean_sql, affected, result["costMs"], "async")
            j["result"] = result
            j["state"] = "done"
        except Exception as e:
            if j.get("cancel_requested") or (conn is not None and str(e).find("closed") >= 0):
                # 取消导致连接关闭抛异常 → 视为用户主动停止
                j["state"] = "cancelled"
            else:
                # 写语句执行失败也审计(仅当 _prepare_query 已通过,避免 readOnly 等前置拦截重复记录)
                if not is_select and clean_sql:
                    _write_audit(j["db"], ds.type, clean_sql, None, (time.time() - start) * 1000, "async")
                j["error"] = str(e)[:2000]
                j["state"] = "failed"
        finally:
            j["finished_at"] = time.time()
            self._gc()

    def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            j = self._jobs.get(job_id)
            if not j:
                return None
            return {
                "id": j["id"], "state": j["state"], "db": j["db"], "sql": j["sql"][:500],
                "createdAt": j["created_at"], "startedAt": j["started_at"],
                "finishedAt": j["finished_at"], "result": j["result"], "error": j["error"],
            }

    def cancel(self, job_id: str) -> bool:
        """取消 queued/running 的 job:标记 cancelled 并关闭底层连接中断查询(真停止)。

        pymysql/oracledb 连接可在其他线程 close,执行线程的 read/execute 会抛异常,
        _run 捕获后判定为 cancelled(用户主动停止),而非 failed。"""
        with self._lock:
            j = self._jobs.get(job_id)
            if not j or j["state"] not in ("queued", "running"):
                return False
            j["cancel_requested"] = True
            conn = j.get("conn")
        if conn is not None:
            try:
                conn.close()  # 中断正在执行的查询
            except Exception:
                pass
        return True

    def _gc(self) -> None:
        with self._lock:
            now = time.time()
            stale = [
                i for i, j in self._jobs.items()
                if j["state"] in ("done", "failed", "cancelled")
                and (now - (j["finished_at"] or 0)) > self._ttl
            ]
            for i in stale:
                del self._jobs[i]
            done_ids = [i for i, j in self._jobs.items() if j["state"] in ("done", "failed", "cancelled")]
            overflow = len(done_ids) - self._max_jobs
            if overflow > 0:
                for i in sorted(done_ids, key=lambda x: self._jobs[x]["finished_at"] or 0)[:overflow]:
                    del self._jobs[i]


DB_JOBS = DbJobManager()


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


@app.post("/jobs")
def db_job_submit(
    req: QueryReq,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """异步提交 mysql/oracle 查询:立即返回 jobId,后台执行(网关 60s 超时安全)。"""
    require_auth(x_db_token)
    if not req.sql or not req.sql.strip():
        raise HTTPException(status_code=400, detail="sql is required")
    timeout_ms = req.timeoutMs or 3600000
    job_id = DB_JOBS.submit(req.db, req.sql, timeout_ms)
    log.info("db job submitted: %s db=%s", job_id, req.db)
    return {"code": 0, "data": {"jobId": job_id}}


@app.get("/jobs/{job_id}")
def db_job_status(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    j = DB_JOBS.get(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="job not found: %s" % job_id)
    return {"code": 0, "data": j}


@app.post("/jobs/{job_id}/cancel")
def db_job_cancel(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not DB_JOBS.cancel(job_id):
        raise HTTPException(status_code=404, detail="job not found or already finished: %s" % job_id)
    return {"code": 0, "data": {"cancelled": True}}


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


class SparkJobSubmitReq(BaseModel):
    sql: str = ""
    code: str = ""  # kind=pyspark 用
    kind: str = "sql"
    writeUnlocked: bool = False
    timeoutMs: int = 600000  # 异步任务默认 10 分钟(大查询可传更久,不撞网关超时)


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


@app.get("/spark/stages")
def spark_stages(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not SPARK_ENGINE.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    return {"code": 0, "data": SPARK_ENGINE.stages_status()}


@app.post("/spark/jobs")
def spark_job_submit(
    req: SparkJobSubmitReq,
    x_db_token: Optional[str] = Header(default=None),
    x_spark_write: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """异步提交 spark 任务:立即返回 jobId,后台线程执行(网关 60s 超时安全)。"""
    require_auth(x_db_token)
    if not SPARK_ENGINE.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    kind = "pyspark" if req.kind == "pyspark" else "sql"
    _check_spark_write_creds(req.writeUnlocked, x_spark_write)
    sql = req.code if kind == "pyspark" else req.sql
    if not sql or not str(sql).strip():
        raise HTTPException(status_code=400, detail="sql is required")
    job_id = SPARK_JOBS.submit(str(sql), kind, req.writeUnlocked, req.timeoutMs)
    log.info("spark job submitted: %s kind=%s", job_id, kind)
    return {"code": 0, "data": {"jobId": job_id}}


@app.get("/spark/jobs/{job_id}")
def spark_job_status(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    j = SPARK_JOBS.get(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="job not found: %s" % job_id)
    return {"code": 0, "data": j}


@app.post("/spark/jobs/{job_id}/cancel")
def spark_job_cancel(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not SPARK_JOBS.cancel(job_id):
        raise HTTPException(status_code=404, detail="job not found or already finished: %s" % job_id)
    return {"code": 0, "data": {"cancelled": True}}


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
def tables(
    db: str,
    detail: int = 0,
    timeoutMs: int = 0,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """表列表。detail=1 时返回 [{name, comment}](含表注释),否则保持 string[] 兼容旧调用。"""
    require_auth(x_db_token)
    check_db_allowed(db)
    ds = get_datasource(db)
    q_timeout = int(timeoutMs / 1000) if timeoutMs else QUERY_TIMEOUT
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            cur.execute("SHOW TABLE STATUS")
            rows = cur.fetchall()
            items = [
                {
                    "name": str(d.get("Name", list(d.values())[0])),
                    "comment": str(d.get("Comment", "") or ""),
                }
                for d in rows
            ]
        else:
            # 当前用户 schema 下表 + 注释(Oracle 注释可为 NULL → 空串)
            cur.execute(
                "SELECT t.table_name, c.comments FROM user_tables t "
                "LEFT JOIN user_tab_comments c ON t.table_name = c.table_name "
                "ORDER BY t.table_name"
            )
            rows = cur.fetchall()
            items = [{"name": r[0], "comment": str(r[1] or "")} for r in rows]
        cur.close()
    finally:
        conn.close()
    if detail:
        return {"code": 0, "data": items}
    return {"code": 0, "data": [i["name"] for i in items]}


@app.get("/fields")
def fields(
    db: str,
    table: str,
    detail: int = 0,
    timeoutMs: int = 0,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """字段列表。detail=1 时返回完整元数据 [{name,type,comment,nullable,key}],
    否则保持 [{name,type}] 兼容旧调用。
    注意:Oracle 列默认值 data_default 是 LONG 类型,驱动读取有风险,P0 不取。"""
    require_auth(x_db_token)
    check_db_allowed(db)
    if not _TABLE_NAME_RE.match(table or ""):
        raise HTTPException(status_code=400, detail="非法表名")
    ds = get_datasource(db)
    q_timeout = int(timeoutMs / 1000) if timeoutMs else QUERY_TIMEOUT
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            cur.execute(f"SHOW FULL COLUMNS FROM `{table}`")
            rows = cur.fetchall()
            cols = []
            for r in rows:
                d = r if hasattr(r, "items") else {}
                base = {"name": d.get("Field"), "type": d.get("Type")}
                if detail:
                    base.update(
                        {
                            "comment": str(d.get("Comment", "") or ""),
                            "nullable": str(d.get("Null", "")).upper() == "YES",
                            "key": str(d.get("Key", "") or ""),
                            "default": d.get("Default"),
                        }
                    )
                cols.append(base)
        else:
            # 主键列集合(约束型 P)
            pk_set = set()
            cur.execute(
                "SELECT cc.column_name FROM user_cons_columns cc "
                "JOIN user_constraints c ON cc.constraint_name = c.constraint_name "
                "WHERE c.constraint_type = 'P' AND c.table_name = :t",
                {"t": table.upper()},
            )
            for r in cur.fetchall():
                pk_set.add(str(r[0]).upper())
            cur.execute(
                "SELECT column_name, data_type, nullable FROM user_tab_columns "
                "WHERE table_name = :t ORDER BY column_id",
                {"t": table.upper()},
            )
            rows = cur.fetchall()
            col_meta = {r[0]: (r[1], r[2]) for r in rows}
            cur.execute(
                "SELECT column_name, comments FROM user_col_comments WHERE table_name = :t",
                {"t": table.upper()},
            )
            comments = {r[0]: str(r[1] or "") for r in cur.fetchall()}
            cols = []
            for name, (data_type, nullable) in col_meta.items():
                base = {"name": name, "type": data_type}
                if detail:
                    base.update(
                        {
                            "comment": comments.get(name, ""),
                            "nullable": str(nullable).upper() == "Y",
                            "key": "PRI" if str(name).upper() in pk_set else "",
                        }
                    )
                cols.append(base)
        cur.close()
    finally:
        conn.close()
    return {"code": 0, "data": cols}


@app.get("/ddl")
def ddl(
    db: str,
    table: str,
    timeoutMs: int = 0,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """生成建表 DDL:MySQL SHOW CREATE TABLE / Oracle DBMS_METADATA.GET_DDL。
    需数据源账号具备读取 DDL 的权限(SHOW VIEW / EXECUTE_CATALOG_ROLE),失败返回友好错误。"""
    require_auth(x_db_token)
    check_db_allowed(db)
    if not _TABLE_NAME_RE.match(table or ""):
        raise HTTPException(status_code=400, detail="非法表名")
    ds = get_datasource(db)
    q_timeout = int(timeoutMs / 1000) if timeoutMs else QUERY_TIMEOUT
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            cur.execute(f"SHOW CREATE TABLE `{table}`")
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"table '{table}' not found")
            d = {k: v for k, v in row.items()} if hasattr(row, "items") else {}
            ddl_text = str(d.get("Create Table") or (row[1] if len(row) > 1 else "") or "")
        else:
            cur.execute(
                "SELECT DBMS_METADATA.GET_DDL('TABLE', :t) FROM dual",
                {"t": table.upper()},
            )
            row = cur.fetchone()
            ddl_text = str(row[0]) if row and row[0] else ""
        cur.close()
    except HTTPException:
        raise
    except Exception as e:
        de = _extract_sql_error(e, ds.type)
        raise HTTPException(
            status_code=502,
            detail=f"failed to generate DDL (需要账号有 SHOW VIEW / EXECUTE_CATALOG_ROLE 权限): {de.message}",
        )
    finally:
        conn.close()
    return {"code": 0, "data": {"name": table, "ddl": ddl_text}}


# ── Schema 补全(/schema:全量表+字段扁平元数据)────────────────
SCHEMA_MAX_TABLES = 800


@app.get("/schema")
def schema(
    db: str,
    timeoutMs: int = 30000,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """一次性返回该数据源全部表+字段的扁平元数据(供前端 SQL 编辑器补全)。

    - MySQL/Doris(走 mysql 协议):information_schema.tables/columns;table_schema 取
      连接库(ds.service,与 /tables 的 SHOW TABLE STATUS 一致),而非请求参数 db
    - Oracle:all_tables(OWNER=当前用户)+ all_tab_comments + all_tab_columns
    表数 > 800 只返回前 800 张并在 data.truncated=true。"""
    require_auth(x_db_token)
    check_db_allowed(db)
    ds = get_datasource(db)
    q_timeout = max(1, int(timeoutMs / 1000)) if timeoutMs else QUERY_TIMEOUT
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            # Doris 通过 mysql 协议直连,information_schema 一致
            cur.execute(
                "SELECT table_name, table_comment FROM information_schema.tables "
                "WHERE table_schema = %s ORDER BY table_name",
                (ds.service,),
            )
            table_rows = cur.fetchall()
            cur.execute(
                "SELECT table_name, column_name, column_type FROM information_schema.columns "
                "WHERE table_schema = %s ORDER BY table_name, ordinal_position",
                (ds.service,),
            )
            col_rows = cur.fetchall()
            tables: List[Dict[str, Any]] = []
            for t in table_rows:
                d = t if hasattr(t, "items") else {"table_name": t[0], "table_comment": t[1] if len(t) > 1 else None}
                tables.append(
                    {
                        "name": str(d.get("table_name") or ""),
                        "comment": str(d.get("table_comment") or ""),
                        "columns": [],
                    }
                )
            by_name = {t["name"]: t for t in tables}
            for c in col_rows:
                d = c if hasattr(c, "items") else {"table_name": c[0], "column_name": c[1], "column_type": c[2] if len(c) > 2 else ""}
                t = by_name.get(str(d.get("table_name") or ""))
                if t is not None:
                    t["columns"].append(
                        {"name": str(d.get("column_name") or ""), "type": str(d.get("column_type") or "")}
                    )
        else:
            cur.execute(
                "SELECT t.table_name, c.comments FROM all_tables t "
                "LEFT JOIN all_tab_comments c ON t.owner = c.owner AND t.table_name = c.table_name "
                "WHERE t.owner = (SELECT user FROM dual) ORDER BY t.table_name"
            )
            table_rows = cur.fetchall()
            cur.execute(
                "SELECT table_name, column_name, data_type FROM all_tab_columns "
                "WHERE owner = (SELECT user FROM dual) ORDER BY table_name, column_id"
            )
            col_rows = cur.fetchall()
            tables = [{"name": str(r[0] or ""), "comment": str(r[1] or ""), "columns": []} for r in table_rows]
            by_name = {t["name"]: t for t in tables}
            for c in col_rows:
                t = by_name.get(str(c[0] or ""))
                if t is not None:
                    t["columns"].append({"name": str(c[1] or ""), "type": str(c[2] or "")})
        cur.close()
    except HTTPException:
        raise
    except Exception as e:
        de = _extract_sql_error(e, ds.type)
        raise HTTPException(status_code=502, detail=f"failed to load schema: {de.message}")
    finally:
        conn.close()
    truncated = len(tables) > SCHEMA_MAX_TABLES
    if truncated:
        tables = tables[:SCHEMA_MAX_TABLES]
    return {"code": 0, "data": {"tables": tables, "truncated": truncated, "engine": ds.type}}


# ── EXPLAIN 可视化(/explain)────────────────────────────────
_EXPLAIN_OP_KEYS = (
    "query_block",
    "ordering_operation",
    "grouping_operation",
    "duplicates_removal",
    "table",
    "union_result",
    "materialized_from_subquery",
    "windowing",
    "partition",
    "aggregate",
    "first_row",
    "second_row",
    "insert_from_query",
    "update",
    "insert",
    "delete",
    "replace",
    "updating_table",
    "inserting_table",
    "deleting_table",
)


def _mysql_explain_cost(inner: Dict[str, Any]) -> Optional[Any]:
    """从 cost_info 提取成本:total_cost 优先(任务要求),MySQL 真实输出中
    table 节点只有 prefix_cost / query_block 只有 query_cost,依次回退。"""
    ci = inner.get("cost_info")
    if not isinstance(ci, dict):
        return None
    return ci.get("total_cost") or ci.get("prefix_cost") or ci.get("query_cost")


def _mysql_explain_operation(inner: Dict[str, Any]) -> Dict[str, Any]:
    """非 table 的操作节点(ordering/grouping/windowing 等):保留 operation readable 文本。"""
    node: Dict[str, Any] = {
        "operation": inner.get("readable") or inner.get("operation") or "",
        "rows": inner.get("rows"),
        "cost": _mysql_explain_cost(inner),
    }
    extra = []
    if inner.get("using_filesort"):
        extra.append("filesort")
    if inner.get("using_temporary_table"):
        extra.append("temporary table")
    node["extra"] = "; ".join(extra) or None
    return node


def _mysql_explain_table(inner: Dict[str, Any]) -> Dict[str, Any]:
    """table 节点:name/access_type/rows/filtered/cost/extra + readable 作为 operation。"""
    node: Dict[str, Any] = {
        "name": str(inner.get("table_name") or ""),
        "access_type": inner.get("access_type"),
        "rows": inner.get("rows"),
        "filtered": inner.get("filtered"),
        "cost": _mysql_explain_cost(inner),
        "operation": inner.get("readable") or "",
    }
    extra = []
    pk = inner.get("possible_keys")
    if pk:
        extra.append("possible_keys: " + (", ".join(pk) if isinstance(pk, list) else str(pk)))
    if inner.get("key"):
        extra.append("key: " + str(inner.get("key")))
    if inner.get("ref"):
        extra.append("ref: " + str(inner.get("ref")))
    if inner.get("attached_condition"):
        extra.append("attached_condition: " + str(inner.get("attached_condition")))
    uc = inner.get("used_columns")
    if uc:
        extra.append("used_columns: " + (", ".join(uc) if isinstance(uc, list) else str(uc)))
    node["extra"] = "; ".join(extra) or None
    return node


def _mysql_explain_node(data: Any) -> Dict[str, Any]:
    """把 EXPLAIN FORMAT=JSON 的一段递归成 {name, operation, rows, cost, children} 树。
    query_block 的 nested_loop 展开为 children;子查询(attached_subqueries)也挂为 children。"""
    if not isinstance(data, dict):
        return {"name": str(data)[:200], "children": []}
    op_keys = [k for k in data if k in _EXPLAIN_OP_KEYS]
    if not op_keys:
        return {"name": "node", "children": []}
    if len(op_keys) == 1:
        k = op_keys[0]
        inner = data[k]
        node: Dict[str, Any] = {"name": k, "children": []}
        if k == "table" and isinstance(inner, dict):
            node.update(_mysql_explain_table(inner))
            node["children"] = [_mysql_explain_node(x) for x in (inner.get("attached_subqueries") or [])]
        elif isinstance(inner, dict):
            node.update(_mysql_explain_operation(inner))
            children = [_mysql_explain_node(x) for x in (inner.get("nested_loop") or [])]
            children.extend(_mysql_explain_node(x) for x in (inner.get("attached_subqueries") or []))
            node["children"] = children
        else:
            node["operation"] = str(inner)[:200]
        return node
    # 同一层出现多个操作键(罕见):并列展开
    children = [_mysql_explain_node({k: data[k]}) for k in op_keys]
    return {"name": "query_block", "children": children}


def _build_explain_tree(data: Any) -> Dict[str, Any]:
    return _mysql_explain_node(data)


def _to_int(s: Any) -> Optional[int]:
    if s is None:
        return None
    try:
        return int(str(s).split()[0].replace(",", ""))
    except (ValueError, IndexError):
        return None


def _build_oracle_tree(rows: List[Any]) -> Optional[Dict[str, Any]]:
    """PLAN_TABLE 行 → 按 parent_id 递归成 {id, operation, object_name, rows, cost, children} 树。"""
    nodes: Dict[int, Dict[str, Any]] = {}
    for r in rows:
        try:
            rid = int(r[0])
        except (TypeError, ValueError):
            continue
        operation = str(r[2] or "")
        options = str(r[3] or "")
        if options and options.lower() != "null":
            operation = (operation + " " + options).strip()
        nodes[rid] = {
            "id": rid,
            "parent_id": int(r[1]) if r[1] is not None else None,
            "operation": operation,
            "object_name": str(r[4] or ""),
            "rows": _to_int(r[5]),
            "cost": _to_int(r[6]),
            "children": [],
        }
    if not nodes:
        return None
    roots: List[Dict[str, Any]] = []
    for node in nodes.values():
        parent = nodes.get(node["parent_id"])
        if parent is not None:
            parent["children"].append(node)
        else:
            roots.append(node)
    if len(roots) == 1:
        return roots[0]
    return {
        "id": 0,
        "operation": "STATEMENT",
        "object_name": "",
        "rows": None,
        "cost": None,
        "children": roots,
    }


_PLAN_ROW_RE = re.compile(r"^\|\s*\*?\s*(\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|")


def _parse_dbms_xplan_tree(lines: List[str]) -> Optional[Dict[str, Any]]:
    """解析 DBMS_XPLAN.DISPLAY 文本(无 parent_id 列,退化为链式树);解析失败返回 None。"""
    nodes: Dict[int, Dict[str, Any]] = {}
    for ln in lines:
        m = _PLAN_ROW_RE.match(ln)
        if not m:
            continue
        try:
            rid = int(m.group(1))
        except ValueError:
            continue
        nodes[rid] = {
            "id": rid,
            "operation": (m.group(2) or "").strip() or None,
            "object_name": (m.group(3) or "").strip() or None,
            "rows": _to_int(m.group(4)),
            "cost": _to_int(m.group(5)),
            "children": [],
        }
    if not nodes:
        return None
    ids = sorted(nodes)
    for i, rid in enumerate(ids[1:], start=1):
        nodes[ids[i - 1]]["children"].append(nodes[rid])
    return nodes[ids[0]]


class ExplainReq(BaseModel):
    db: str
    sql: str
    engine: Optional[str] = None  # 可选:不传按数据源推断


@app.post("/explain")
def explain(
    req: ExplainReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    """执行计划可视化(只读,写语句 400)。

    - MySQL/Doris:优先 EXPLAIN FORMAT=JSON → {kind:'tree', root};老版本/失败时
      回退普通 EXPLAIN → {kind:'table', columns, rows}
    - Oracle:EXPLAIN PLAN FOR 后查 PLAN_TABLE(按 parent_id 建树);不可用则
      DBMS_XPLAN.DISPLAY 文本解析;再失败 → {kind:'table', rows: 原始行}"""
    require_auth(x_db_token)
    check_db_allowed(req.db)
    raw = (req.sql or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="sql is required")
    # 复用 /query 同一套校验:走私检测(INTO OUTFILE/DUMPFILE、LOAD_FILE、可执行注释)、
    # CTE-DML、单语句、表白名单、read_only 拦截;EXPLAIN 只读,非 SELECT 一律 400
    # (MySQL 5.x 的 EXPLAIN 对 DML 会实际执行,必须在此挡住)。
    ds, clean, is_select, _limit, q_timeout, _start = _prepare_query(raw, req.db)
    if not is_select:
        raise HTTPException(status_code=400, detail="explain only supports read-only SQL")
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            try:
                # EXPLAIN FORMAT=JSON:老版本 MySQL 不支持会语法报错 → 回退普通 EXPLAIN
                cur.execute("EXPLAIN FORMAT=JSON " + clean)
                row = cur.fetchone()
                raw = None
                if row:
                    raw = next(iter(row.values())) if hasattr(row, "items") else row[0]
                data = json.loads(raw) if isinstance(raw, str) else raw
                if not isinstance(data, dict):
                    raise ValueError("unexpected explain json shape")
                root = _build_explain_tree(data)
                return {"code": 0, "data": {"kind": "tree", "root": root}}
            except Exception:
                cur.execute("EXPLAIN " + clean)
                rows = cur.fetchall()
                columns = list(rows[0].keys()) if rows else []
                return {"code": 0, "data": {"kind": "table", "columns": columns, "rows": rows}}
        else:
            cur.execute("EXPLAIN PLAN FOR " + clean)
            try:
                cur.execute(
                    "SELECT id, parent_id, operation, options, object_name, cardinality, cost "
                    "FROM plan_table ORDER BY id"
                )
                pt = cur.fetchall()
                if pt:
                    root = _build_oracle_tree(pt)
                    if root is not None:
                        return {"code": 0, "data": {"kind": "tree", "root": root}}
            except Exception:
                pass
            try:
                cur.execute("SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, NULL, 'ALL'))")
                plan_rows = cur.fetchall()
                lines = [
                    str(r[0]) if not hasattr(r, "items") else str(next(iter(r.values())))
                    for r in plan_rows
                ]
            except Exception:
                lines = []
            root = _parse_dbms_xplan_tree(lines)
            if root is not None:
                return {"code": 0, "data": {"kind": "tree", "root": root}}
            return {"code": 0, "data": {"kind": "table", "rows": lines}}
    except HTTPException:
        raise
    except Exception as e:
        de = _extract_sql_error(e, ds.type)
        raise HTTPException(status_code=502, detail=f"explain failed: {de.message}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


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
