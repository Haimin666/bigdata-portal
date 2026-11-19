"""db-proxy:数据库只读 HTTP 代理服务(客户机侧)。

运行在可直连数据库的客户机上,把"查询"能力以 HTTP API 暴露给平台。
支持 MySQL、Oracle 与 Impala 的**多数据源**(一个服务连多套库,按 db 参数路由)。

**所有配置集中在 datasources.json 一个文件**(代码写死路径,无需其他配置):
  - 服务配置:authToken / listenHost / listenPort / 超时 / 行数限制
  - Oracle thick 模式:oracleClientLib
  - 数据源:datasources 数组(每个数据库独立成块;MySQL/Doris/Oracle 可用 connectionString)

设计目标:
  - 网关管控读写权限;Impala 数据源可额外启用只读保护
  - 鉴权 + 资源护栏(多语句/行数/长度/超时/限流);库级/表级白名单由门户网关执行,
    本服务只回显配置,不再做拦截
  - 强制行数上限(默认 1000 行,硬上限 500000 行;MySQL LIMIT / Oracle 12c+ FETCH / 11g ROWNUM)
  - 连接信息只存在于客户机,平台永远不接触数据库密码
  - AUTH_TOKEN 鉴权,防内网随意调用
  - 执行审计日志

依赖:
  - MySQL:  pymysql(Python 3.7 兼容)
  - Oracle: oracledb>=1.4,<2.2(Python 3.7 兼容,thin 模式无需客户端库;
            连 11g 需配 oracleClientLib 走 thick 模式)
  - Impala(可选):impyla + sqlglot(类型检查);AI SQL 修复仅使用服务端配置
用法:python main.py
"""

from __future__ import annotations

import json
import logging
import os
import base64
import hmac
import re
import time
import uuid
import secrets
import collections
import datetime
import threading
import hashlib
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# 行数限制的唯一实现点(默认 1000 行 / 硬上限 500000 行,作用域与注释感知)
from sql_limits import (
    DEFAULT_ROWS,
    MAX_ROWS,
    effective_limits,
    mask_sql,
    plan_row_limit,
)
from sync_generator import generate_db2hive

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
IDENTITY_SECRET = str(CONFIG.get("identitySecret") or AUTH_TOKEN)
LISTEN_HOST = str(CONFIG.get("listenHost", "0.0.0.0"))
LISTEN_PORT = int(CONFIG.get("listenPort", 8756))
# 行数契约(产品固定):默认返回 1000 行,显式上限硬顶 500000 行。
# 配置项只能在 [1, MAX_ROWS] 内收紧,不能突破硬上限。
DEFAULT_LIMIT, MAX_LIMIT = effective_limits(
    CONFIG.get("defaultLimit"), CONFIG.get("maxLimit")
)
# SQL 长度上限(字节),防超大 SQL 拖垮客户机/数据库;默认 32KB
MAX_SQL_LEN = int(CONFIG.get("maxSqlLen", 32768))
QUERY_TIMEOUT = int(CONFIG.get("queryTimeout", 60))
DB_CONNECT_TIMEOUT = int(CONFIG.get("connectTimeout", 5))
# 旧配置兼容字段:仅由 /acl 回显,不参与 db-proxy 侧的库/表过滤。
ALLOWED_DBS = [str(s).strip() for s in CONFIG.get("allowedDbs", []) if str(s).strip()]
ALLOWED_TABLES = [
    str(s).strip() for s in CONFIG.get("allowedTables", []) if str(s).strip()
]
# 查询授权由门户网关数据权限矩阵负责;db-proxy 保留鉴权、资源护栏与可选只读保护。
# Oracle thick 模式:客户端库目录(含 libclntsh.so),连 11g 必配
ORACLE_CLIENT_LIB = str(CONFIG.get("oracleClientLib", ""))

# 服务端资源护栏:同时执行上限 + 请求限速(防批量请求刷爆数据库连接/拖垮库)
MAX_CONCURRENT = max(1, int(CONFIG.get("maxConcurrent", 5)))
MAX_QPS = max(1, int(CONFIG.get("maxQps", 10)))
MAX_CONCURRENT_PER_SUBJECT = min(
    MAX_CONCURRENT, max(1, int(CONFIG.get("maxConcurrentPerSubject", 2)))
)
MAX_QPS_PER_SUBJECT = max(1, int(CONFIG.get("maxQpsPerSubject", 3)))
_query_semaphore = threading.BoundedSemaphore(MAX_CONCURRENT)
_subject_active: Dict[str, int] = {}
_subject_qps: Dict[str, collections.deque] = {}
_qps_lock = threading.Lock()
_qps_window = collections.deque()
_SEARCH_WORKERS = min(MAX_CONCURRENT, 8)
_SEARCH_MAX_REQUESTS = max(1, int(CONFIG.get("maxConcurrentSearches", 2)))
try:
    _SEARCH_DEADLINE_SECONDS = min(15.0, max(1.0, float(CONFIG.get("searchDeadlineSeconds", 5.0))))
except (TypeError, ValueError):
    _SEARCH_DEADLINE_SECONDS = 5.0
_SEARCH_CONNECT_TIMEOUT = max(1, int(CONFIG.get("searchConnectTimeout", 2)))
_search_request_semaphore = threading.BoundedSemaphore(_SEARCH_MAX_REQUESTS)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("db-proxy")

# Spark SQL 双通道:Thrift / 历史 YARN client SparkSession;缺省 Thrift。
from spark_engine import SparkJobManager  # noqa: E402
from spark_thrift_engine import SparkThriftEngine  # noqa: E402
from spark_session_engine import SparkSessionEngine  # noqa: E402
from impala_engine import ImpalaEngine, ImpalaSchemaCache, schema_summary as _impala_schema_summary  # noqa: E402

SPARK_CFG = CONFIG.get("spark") or {}
SPARK_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SPARK_ENGINE = SparkThriftEngine(SPARK_CFG, SPARK_BASE_DIR)
SPARK_ENGINES = {
    "thrift": SPARK_ENGINE,
    "session": SparkSessionEngine(SPARK_CFG, SPARK_BASE_DIR),
}
SPARK_JOBS = SparkJobManager(SPARK_ENGINES)
if SPARK_ENGINE.enabled:
    log.info("spark thrift engine enabled (jdbcUrl=%s, user=%s)",
             SPARK_ENGINE.status()["config"]["jdbcUrl"], SPARK_CFG.get("user", "root"))

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
    from flink_engine import FlinkJobManager
    FLINK_JOBS = FlinkJobManager(FLINK_ENGINE)
    log.info("flink engine enabled (yarnAppId=%s, allowWrite=%s)",
             FLINK_CFG.get("yarnAppId"), FLINK_CFG.get("allowWrite"))
if FLINK_PREJOB.enabled:
    log.info("flink prejob enabled (mode=yarn-per-job, queue=%s, flinkHome=%s)",
             FLINK_PREJOB.status().get("queue"), FLINK_PREJOB.status().get("flinkHome"))

# Impala 引擎(可选):impyla 未安装时不影响 MySQL/Oracle/Spark/Flink 启动;
# 仅在 datasources.json 声明 type=impala 的数据源时实际连接。
IMPALA_CFG = CONFIG.get("impala") or {}
IMPALA_SCHEMA_CACHE = ImpalaSchemaCache(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "impala-schema-cache.json"),
    # 默认 24h 过期:DDL 变更后不必等到报错才刷新(仍保留"错误驱动强制刷新"路径)
    ttl_seconds=IMPALA_CFG.get("schemaCacheTtlSeconds", 86400),
)
IMPALA_ENGINE = ImpalaEngine(IMPALA_CFG, IMPALA_SCHEMA_CACHE)
if any(str(x.get("type", "")).lower() == "impala" for x in CONFIG.get("datasources", [])):
    log.info("impala engine configured (driver=%s, typeCheck=%s, aiFix=%s)",
             IMPALA_ENGINE.available, IMPALA_ENGINE.type_check_enabled, IMPALA_ENGINE.ai.enabled)

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


# 行数上限由 sql_limits.plan_row_limit 统一处理(作用域/注释感知),
# 不再用整条 SQL 正则判断,避免字符串字面量或子查询里的 LIMIT 被误判。

app = FastAPI(title="db-proxy", version="2.1.0")

# 对会新建数据库连接/执行计划的元数据端点施加共享并发护栏。
# 跨库搜索有自己的请求闸门;其 worker 对每条物理连接单独申请 _query_semaphore。
_METADATA_PATHS = frozenset({"/owners", "/tables", "/fields", "/ddl", "/schema", "/explain", "/sync/db2hive"})
_SEARCH_PATH = "/search/tables"


@app.middleware("http")
async def database_resource_guard(request, call_next):
    path = request.url.path.rstrip("/").lower() or "/"
    if request.method == "GET" and path == _SEARCH_PATH:
        semaphore = _search_request_semaphore
        name = "table searches"
    elif path in _METADATA_PATHS:
        semaphore = _query_semaphore
        name = "database metadata/explain requests"
    else:
        return await call_next(request)
    if not semaphore.acquire(blocking=False):
        return JSONResponse(
            status_code=429,
            content={"code": 429, "detail": "too many concurrent %s" % name},
        )
    try:
        return await call_next(request)
    finally:
        semaphore.release()


# ── 数据源注册表 ──────────────────────────────────────────────
def _cancel_log(message: str) -> None:
    """取消/中止相关的诊断只记 warning 以下级别,避免刷爆日志。"""
    log.info("cancel: %s", message)


def _query_thread_id(conn) -> Optional[int]:
    """MySQL/Doris 连接线程号(供 KILL QUERY 使用)。"""
    fn = getattr(conn, "thread_id", None)
    if callable(fn):
        try:
            return int(fn())
        except Exception:
            return None
    return None


def _oracle_session_ids(conn) -> Tuple[Optional[int], Optional[int]]:
    """读取当前 Oracle 会话的 sid/serial#(供 KILL SESSION 使用);无权限时返回 (None, None)。"""
    cur = None
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT sid, serial# FROM v$session "
            "WHERE sid = SYS_CONTEXT('USERENV','SID')"
        )
        row = cur.fetchone()
        if row and row[0] is not None and row[1] is not None:
            return int(row[0]), int(row[1])
    except Exception:
        pass
    finally:
        if cur is not None:
            try:
                cur.close()
            except Exception:
                pass
    return None, None


def _expand_connection_string(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """把单条 MySQL/Doris/Oracle URI 展开为驱动参数;显式字段仍可覆盖 URI。"""
    raw = cfg.get("connectionString")
    if raw is None:
        return cfg
    name = str(cfg.get("name", "?"))
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"datasource '{name}' connectionString must be a non-empty string")

    source_type = str(cfg.get("type", "mysql")).strip().lower()
    try:
        parsed = urlsplit(raw.strip())
        host = parsed.hostname
        port = parsed.port
        username = parsed.username
        password = parsed.password
    except ValueError as exc:
        raise ValueError(f"datasource '{name}' has invalid connectionString") from exc

    schemes = {"mysql": ("mysql", "doris"), "oracle": ("oracle",)}
    if parsed.scheme.lower() not in schemes.get(source_type, ()):
        raise ValueError(
            f"datasource '{name}' connectionString scheme does not match type '{source_type}'"
        )
    if not parsed.netloc or not host:
        raise ValueError(f"datasource '{name}' connectionString must include a host")
    if parsed.fragment:
        raise ValueError(f"datasource '{name}' connectionString must not include a fragment")

    query = parse_qs(parsed.query, keep_blank_values=True)
    allowed_query_keys = {"mysql": {"charset"}, "oracle": {"service_name"}}
    unknown = set(query) - allowed_query_keys.get(source_type, set())
    if unknown:
        raise ValueError(
            f"datasource '{name}' connectionString has unsupported query options: "
            + ", ".join(sorted(unknown))
        )

    fields: Dict[str, Any] = {"host": host}
    if port is not None:
        fields["port"] = port
    if username is not None:
        fields["user"] = unquote(username)
    if password is not None:
        fields["password"] = unquote(password)

    database = unquote(parsed.path.lstrip("/"))
    if source_type == "mysql":
        if database:
            fields["schema"] = database
        if "charset" in query:
            fields["charset"] = query["charset"][-1]
    else:
        service = database or (query.get("service_name") or [""])[-1]
        if service:
            fields["service"] = service

    # 保持向后兼容:URI 给出连接默认值,同一数据源显式字段优先。
    return {**fields, **cfg}


class DataSource:
    """单个数据源配置:name 是请求 db 参数,type 是 mysql/oracle。"""

    def __init__(self, cfg: Dict[str, Any]) -> None:
        self.name: str = str(cfg["name"])
        # 显示别名:下拉/展示用,缺省回退到 name
        self.label: str = str(cfg.get("label", "")).strip() or self.name
        self.type: str = str(cfg.get("type", "mysql")).strip().lower()
        # Preserve the maintained source kind: Doris is exposed as MySQL-compatible,
        # but its metadata must not be used to generate a MySQL DataX sync job.
        self.source_type: str = str(cfg.get("sourceType", self.type)).strip().lower()
        self.datax_jdbc_url: str = str(cfg.get("dataxJdbcUrl", "")).strip()
        if self.type not in ("mysql", "oracle", "impala"):
            raise ValueError(f"datasource '{self.name}' type must be mysql/oracle/impala")
        cfg = _expand_connection_string(cfg)
        raw_hosts = cfg.get("hosts", cfg.get("host", "127.0.0.1"))
        if isinstance(raw_hosts, list):
            self.host: str = ",".join(str(x).strip() for x in raw_hosts if str(x).strip())
        else:
            self.host = str(raw_hosts)
        self.port: int = int(cfg.get("port", 21050 if self.type == "impala" else 3306 if self.type == "mysql" else 1521))
        self.user: str = str(cfg.get("user", ""))
        self.password: str = str(cfg.get("password", ""))
        self.charset: str = str(
            cfg.get("charset", "utf8mb4" if self.type == "mysql" else "AL32UTF8")
        )
        # Oracle Service Name 只用于连接;owner/schema 是可选默认会话 schema。
        # 缺少 owner 字段的旧配置仍回退 name;显式空字符串表示未指定默认 schema。
        self.service: str = str(cfg.get("database", cfg.get("service", cfg.get("schema", self.name))))
        raw_owner = str(cfg.get("owner", self.name) or "").strip()
        self.owner: str = raw_owner.upper() if self.type == "oracle" else raw_owner
        raw_owners = cfg.get("owners") or []
        if not isinstance(raw_owners, list):
            raise ValueError(f"datasource '{self.name}' owners must be a list")
        self.owners: List[str] = sorted({str(value).strip().upper() for value in raw_owners if str(value).strip()}) if self.type == "oracle" else []
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
        if self.type in ("mysql", "impala"):
            return "mysql"
        # Oracle:探测主版本,11g(11)用 rownum,12+ 用 fetch
        if self._oracle_major < 0:
            self._oracle_major = self._detect_oracle_version(conn)
        return "rownum" if self._oracle_major <= 11 else "fetch"

    def connect(self, connect_timeout: int, query_timeout: int, schema_name: Optional[str] = None):
        if self.type == "impala":
            return IMPALA_ENGINE.connect(
                host=self.host,
                port=self.port,
                user=self.user,
                password=self.password,
                database=self.service,
                connect_timeout=connect_timeout,
                query_timeout=query_timeout,
            )
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
            conn = oracledb.connect(**kwargs, connect_timeout=connect_timeout)
        except TypeError:
            conn = oracledb.connect(**kwargs)
        # 客户端读超时:oracledb 2.x 的 call_timeout(毫秒);1.x 无此属性则跳过
        try:
            conn.call_timeout = max(1, int(query_timeout)) * 1000
        except Exception:
            pass
        requested_schema = self.owner if schema_name is None else str(schema_name or "").strip().upper()
        if requested_schema:
            cur = conn.cursor()
            try:
                owner_ident = requested_schema.replace('"', '""')
                cur.execute('ALTER SESSION SET CURRENT_SCHEMA = "{}"'.format(owner_ident))
            except Exception:
                conn.close()
                raise
            finally:
                cur.close()
        return conn

    # ── 真实取消:终止数据库侧正在执行的语句(不是只关本地连接)──────────
    def _helper_mysql(self):
        return pymysql.connect(
            host=self.host,
            port=self.port,
            user=self.user,
            password=self.password,
            database=self.service,
            charset=self.charset,
            connect_timeout=max(1, DB_CONNECT_TIMEOUT),
            read_timeout=max(5, DB_CONNECT_TIMEOUT * 2),
            write_timeout=max(5, DB_CONNECT_TIMEOUT * 2),
            autocommit=True,
        )

    def _cancel_mysql(self, thread_id: Optional[int]) -> str:
        """MySQL/Doris:用同账号短连接发 KILL QUERY,真正打断服务端语句。"""
        if thread_id is None or not _HAS_MYSQL:
            return "close"
        helper = None
        try:
            helper = self._helper_mysql()
            cur = helper.cursor()
            try:
                cur.execute("KILL QUERY %d" % int(thread_id))
            finally:
                try:
                    cur.close()
                except Exception:
                    pass
            return "mysql:KILL QUERY %d" % int(thread_id)
        except Exception as exc:
            _cancel_log("mysql KILL QUERY failed (thread=%s): %s" % (thread_id, exc))
            return "close"
        finally:
            if helper is not None:
                try:
                    helper.close()
                except Exception:
                    pass

    def _cancel_oracle(self, conn, session_ids) -> str:
        """Oracle:优先 OCI break(Connection.cancel),否则 KILL SESSION,最后关连接。"""
        cancel = getattr(conn, "cancel", None)
        if callable(cancel):
            try:
                cancel()
                return "oracle:Connection.cancel"
            except Exception as exc:
                _cancel_log("oracle Connection.cancel failed: %s" % exc)
        sid, serial = session_ids or (None, None)
        if sid and serial and _HAS_ORACLE:
            helper = None
            try:
                helper = oracledb.connect(
                    user=self.user, password=self.password,
                    dsn=f"{self.host}:{self.port}/{self.service}",
                )
                cur = helper.cursor()
                try:
                    cur.execute(
                        "ALTER SYSTEM KILL SESSION '%d,%d' IMMEDIATE" % (int(sid), int(serial))
                    )
                finally:
                    try:
                        cur.close()
                    except Exception:
                        pass
                return "oracle:KILL SESSION %d,%d" % (int(sid), int(serial))
            except Exception as exc:
                # 普通账号无 ALTER SYSTEM 权限时属预期降级,仅记 debug 级日志
                _cancel_log(
                    "oracle KILL SESSION unavailable (sid=%s, needs ALTER SYSTEM): %s" % (sid, exc)
                )
            finally:
                if helper is not None:
                    try:
                        helper.close()
                    except Exception:
                        pass
        return "close"

    def _cancel_impala(self, cursor) -> str:
        """Impala:优先 HS2 CancelOperation,退化为关闭 operation,最后关会话。"""
        if cursor is not None:
            for name in ("cancel_operation", "cancel"):
                fn = getattr(cursor, name, None)
                if callable(fn):
                    try:
                        fn()
                        return "impala:%s" % name
                    except Exception as exc:
                        _cancel_log("impala %s failed: %s" % (name, exc))
            close_op = getattr(cursor, "close_operation", None)
            if callable(close_op):
                try:
                    close_op()
                    return "impala:close_operation"
                except Exception as exc:
                    _cancel_log("impala close_operation failed: %s" % exc)
        # 返回 close:由调用方关闭连接(HiveServer2 CloseSession 会取消会话内查询)
        return "close"

    def cancel_query(self, conn, cursor=None, thread_id=None, session_ids=None) -> str:
        """终止该数据源上正在执行的语句,返回实际使用的方式(供 job 日志回显)。"""
        if self.type == "mysql":
            return self._cancel_mysql(thread_id)
        if self.type == "oracle":
            return self._cancel_oracle(conn, session_ids)
        if self.type == "impala":
            return self._cancel_impala(cursor)
        return "unsupported"


    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "label": self.label,
            "type": self.type,
            "sourceType": self.source_type,
            "host": self.host,
            "port": self.port,
            "user": self.user,
            "database": self.service if self.type == "mysql" else None,
            "serviceName": self.service if self.type == "oracle" else None,
            "owner": self.owner if self.type == "oracle" else None,
            "owners": self.owners if self.type == "oracle" else None,
            "rowLimit": self.row_limit,
            "readOnly": self.read_only,
        }


def _build_datasources(config: Dict[str, Any], *, reject_duplicates: bool = False) -> Dict[str, DataSource]:
    profiles = config.get("connectionProfiles") or {}
    if not isinstance(profiles, dict):
        raise ValueError("datasources.json 'connectionProfiles' must be an object")

    sources: Dict[str, DataSource] = {}
    for raw_cfg in config["datasources"]:
        if not isinstance(raw_cfg, dict):
            raise ValueError("each datasource must be an object")
        cfg = dict(raw_cfg)
        profile_name = cfg.pop("connectionProfile", None)
        if profile_name is not None:
            profile = profiles.get(str(profile_name))
            if not isinstance(profile, dict):
                raise ValueError(
                    f"datasource '{cfg.get('name', '?')}' references unknown "
                    f"connectionProfile '{profile_name}'"
                )
            # Per-datasource fields override shared connection defaults.
            cfg = {**profile, **cfg}

        ds = DataSource(cfg)
        if ds.name in sources:
            if reject_duplicates:
                raise ValueError(f"duplicate datasource name '{ds.name}'")
            log.warning(
                "duplicate datasource name '%s'; later entry overrides earlier one",
                ds.name,
            )
        sources[ds.name] = ds
    return sources


def _load_datasources() -> Dict[str, DataSource]:
    return _build_datasources(CONFIG)


DATASOURCES = _load_datasources()
_DATASOURCE_CONFIG_LOCK = threading.RLock()


def get_datasource(db: str) -> DataSource:
    ds = DATASOURCES.get(db)
    if not ds:
        raise HTTPException(
            status_code=404, detail=f"datasource '{db}' not configured"
        )
    return ds


def _impala_cache_namespace(ds: DataSource) -> str:
    identity = json.dumps([ds.name, ds.host, ds.port, ds.user, ds.service], ensure_ascii=False)
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


# ── 安全工具 ──────────────────────────────────────────────────
def verified_subject(payload: Optional[str], signature: Optional[str]) -> Tuple[str, bool]:
    """验证网关签发的短时主体声明;返回主体与可信的门户管理员标记。"""
    if not IDENTITY_SECRET:
        raise HTTPException(status_code=503, detail="db-proxy identity signing secret is not configured")
    if not payload or not signature:
        raise HTTPException(status_code=401, detail="signed db-proxy subject required")
    if len(payload) > 1024 or len(signature) > 128:
        raise HTTPException(status_code=401, detail="invalid db-proxy subject")
    try:
        payload_bytes = payload.encode("ascii")
        signature_bytes = signature.encode("ascii")
    except UnicodeEncodeError:
        raise HTTPException(status_code=401, detail="invalid db-proxy subject")
    expected = hmac.new(
        IDENTITY_SECRET.encode("utf-8"), payload_bytes, hashlib.sha256
    ).hexdigest().encode("ascii")
    if not secrets.compare_digest(signature_bytes, expected):
        raise HTTPException(status_code=401, detail="invalid db-proxy subject signature")
    try:
        padded = payload + "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        subject = claims.get("subject")
        expires_at = claims.get("expiresAt")
    except Exception:
        raise HTTPException(status_code=401, detail="invalid db-proxy subject")
    now = int(time.time())
    if (
        not isinstance(subject, str) or len(subject) > 256
        or not isinstance(expires_at, int) or expires_at < now or expires_at > now + 60
    ):
        raise HTTPException(status_code=401, detail="expired or invalid db-proxy subject")
    if subject != "anonymous" and not subject.startswith(("user:", "token:")):
        raise HTTPException(status_code=401, detail="invalid db-proxy subject")
    return subject, claims.get("isAdmin") is True


def require_auth(x_db_token: Optional[str]) -> None:
    """鉴权:配置了 authToken 则必须匹配(常量时间比较,避免时序侧信道)。"""
    if not AUTH_TOKEN:
        return
    provided = x_db_token or ""
    # compare_digest 要求同类型;str 参数按 UTF-8 比较,长度不同也不会提前返回
    if not secrets.compare_digest(provided, AUTH_TOKEN):
        raise HTTPException(status_code=401, detail="unauthorized")


READ_ONLY_SQL_RE = re.compile(
    r"^\s*(?:--[^\n]*\n\s*|/\*.*?\*/\s*)*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|WITH)\b",
    re.IGNORECASE | re.DOTALL,
)
# 只对 SELECT/WITH 查询在服务端隐藏追加行数限制;SHOW/DESC/EXPLAIN 等保持原文。
SELECT_ONLY_RE = re.compile(
    r"^\s*(?:--[^\n]*\n\s*|/\*.*?\*/\s*)*(?:SELECT|WITH)\b",
    re.IGNORECASE | re.DOTALL,
)
ORACLE_PLSQL_START_RE = re.compile(
    r"^\s*(?:DECLARE\b|BEGIN\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER)\b)",
    re.IGNORECASE,
)


# ── 写操作审计(MySQL/Oracle/Doris 写 SQL 执行审计,JSON Lines)────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
AUDIT_DIR = os.path.join(BASE_DIR, "audit")
AUDIT_LOG_FILE = os.path.join(AUDIT_DIR, "audit-db.log")
_audit_lock = threading.Lock()


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


def _bounded_timeout_seconds(timeout_ms: Optional[int]) -> int:
    """把毫秒超时转成连接/读取超时秒数,保证 >= 1(0 在驱动里等于"永不超时")。"""
    if not timeout_ms:
        return QUERY_TIMEOUT
    return max(1, int(timeout_ms / 1000))


# ── 数据访问 ──────────────────────────────────────────────────
def _rows_to_dicts(rows: List[Any], description: List[Any]) -> List[Dict[str, Any]]:
    """统一行格式:list[dict],key 为列名。"""
    cols = [d[0].lower() for d in description] if description else []
    return [{cols[i]: r[i] for i in range(len(cols))} for r in rows]


class DbError(Exception):
    """数据库执行错误(结构化,类似 SQL 客户端:类型 + 错误码)。"""

    def __init__(self, engine: str, error_type: str, error_code, message: str, logs: Optional[List[str]] = None):
        super().__init__(message)
        self.engine = engine
        self.error_type = error_type
        self.error_code = error_code
        self.message = message
        self.logs = list(logs or [])


_MYSQL_ERROR_TYPES = {
    1044: "AccessDenied", 1045: "AccessDenied", 1049: "UnknownDatabase", 1054: "ColumnNotFound",
    1062: "DuplicateEntry", 1064: "SyntaxError", 1130: "AccessDenied", 1142: "TableAccessDenied",
    1146: "TableNotFound", 1205: "LockWaitTimeout", 1213: "Deadlock",
    1364: "FieldNotDefault", 1406: "DataTooLong",
    1451: "ForeignKeyViolation", 1452: "ForeignKeyViolation",
    2002: "ConnectError", 2003: "ConnectError", 2005: "ConnectError", 2006: "ConnectError",
    2013: "ConnectError", 2055: "ConnectError",
}

_ORACLE_ERROR_TYPES = {
    "ORA-00001": "DuplicateEntry", "ORA-00900": "SyntaxError",
    "ORA-00904": "ColumnNotFound", "ORA-00933": "SyntaxError",
    "ORA-00942": "TableNotFound", "ORA-01017": "AccessDenied",
    "ORA-01400": "FieldNotDefault", "ORA-01401": "DataTooLong",
    "ORA-00060": "Deadlock",
    "ORA-03113": "ConnectError", "ORA-03114": "ConnectError", "ORA-03135": "ConnectError",
    "ORA-12154": "ConnectError", "ORA-12170": "ConnectError", "ORA-12505": "ConnectError",
    "ORA-12514": "ConnectError", "ORA-12516": "ConnectError", "ORA-12535": "ConnectError",
    "ORA-12537": "ConnectError", "ORA-12541": "ConnectError", "ORA-12543": "ConnectError",
    "ORA-12545": "ConnectError", "ORA-12547": "ConnectError", "ORA-12560": "ConnectError",
}

_DB_ERROR_GUIDANCE = {
    "UnknownDatabase": ("数据库名不存在或配置不匹配。请核对当前数据源的数据库名称。"),
    "TableNotFound": ("表不存在或当前账号不可见。请核对库名、表名、大小写及访问权限。"),
    "ColumnNotFound": ("字段不存在或当前账号不可见。请核对字段名、表结构及访问权限。"),
    "ConnectError": ("数据库连接失败。请检查主机地址、端口、网络连通性及数据库服务状态；Oracle 还需核对服务名或 SID。"),
    "AccessDenied": ("数据库拒绝访问。请检查账号、密码及目标库的授权。"),
    "TableAccessDenied": ("当前账号无权访问该表。请检查表级授权。"),
}


def _safe_db_error_text(message: str) -> str:
    """清理错误详情中的常见凭证形式后再返回给门户。"""
    text = " ".join(str(message or "").split())
    text = re.sub(r"(//)[^/\s@]+:[^/\s@]+@", r"\1***:***@", text)
    text = re.sub(
        r"\b(username|user|password|passwd|pwd|token|secret|dsn|access[_-]?key)\b\s*([=:])\s*([^\s,;]+)",
        r"\1\2***", text, flags=re.IGNORECASE
    )
    text = re.sub(
        r"\b(username|user|password|passwd|pwd|token|secret|dsn|access[_-]?key)\b(\s+)([A-Za-z0-9+/=._-]{8,})",
        r"\1\2***", text, flags=re.IGNORECASE
    )
    text = re.sub(r"\b(x-db-token|x-spark-token|x-spark-write)\b\s*[:=]\s*\S+", r"\1: ***", text, flags=re.IGNORECASE)
    return text[:1000]


def _describe_db_error(error: DbError) -> str:
    """返回便于用户排查的中文说明，并保留脱敏后的驱动详情。"""
    code = " [%s]" % error.error_code if error.error_code is not None else ""
    guidance = _DB_ERROR_GUIDANCE.get(error.error_type, "数据库执行失败，请结合原始错误详情排查。")
    return "%s %s%s：%s 原始错误：%s" % (
        error.engine, error.error_type, code, guidance, _safe_db_error_text(error.message)
    )


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
    if engine == "impala":
        lower = msg.lower()
        if "authorization" in lower or "not authorized" in lower or "permission" in lower:
            etype = "AccessDenied"
        elif "transport" in lower or "connection" in lower or "timed out" in lower or "timeout" in lower:
            etype = "ConnectError"
        elif "parseexception" in lower or "syntax" in lower:
            etype = "SyntaxError"
        elif any(
            marker in lower
            for marker in (
                "type mismatch",
                "incompatible types",
                "operands of type",
                "not comparable",
                "cannot implicitly convert",
                "incompatible operand",
            )
        ):
            etype = "TypeMismatch"
        elif "analysisexception" in lower or "column not found" in lower:
            etype = "ColumnNotFound"
        elif "table not found" in lower or "unknown table" in lower:
            etype = "TableNotFound"
        else:
            etype = "DatabaseError"
        return DbError(engine, etype, None, msg)
    return DbError(engine, "DatabaseError", None, msg)


def _prepare_query(sql: str, db: str, timeout_ms: Optional[int] = None, source: str = "sync"):
    """解析/校验 SQL,返回 (ds, clean_sql, is_select, q_timeout, start)。
    供 fetch(同步)与 DbJobManager(异步,需持有连接才能取消)共用。"""
    ds = get_datasource(db)
    clean_sql = sql.strip()
    if ds.type != "oracle" or not ORACLE_PLSQL_START_RE.match(clean_sql):
        clean_sql = clean_sql.rstrip(";").strip()
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
    # 读写限制已全部收口到门户网关侧(db-proxy 不做库表白名单/只读/多语句拦截)
    # 行数限制不在此处计算:需要连接才能确定 Oracle 11g/12c 的限行语法(见 _execute_query)
    q_timeout = _bounded_timeout_seconds(timeout_ms)
    return ds, clean_sql, is_select, q_timeout, time.time()


def _execute_query(
    ds: Any,
    conn: Any,
    clean_sql: str,
    is_select: bool,
    start: float,
    job_logs: Optional[List[str]] = None,
    state: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """在已建立的连接上执行(连接由调用方管理,便于异步 job 真实取消)。

    state 为异步 job 的运行态字典:执行期间登记 cursor / 线程号 / Oracle 会话号,
    取消时据此在数据库侧终止语句(而不是只关本地连接)。
    """
    if is_select:
        # 画布 SQL 不变;SELECT/WITH 由服务端限行(默认 1000,硬上限 500000)。
        # Impala 无 FROM 常量查询及 SHOW/DESC/EXPLAIN 不追加限行子句,读取仍有界。
        row_mode = ds.effective_row_limit(conn)
        plan = plan_row_limit(clean_sql, mode=row_mode,
                              default_limit=DEFAULT_LIMIT, max_limit=MAX_LIMIT,
                              engine=ds.type)
        clean_sql = plan.sql
        limit = plan.limit
        cur = conn.cursor()
        _publish_cursor(ds, conn, cur, state)
        try:
            if ds.type == "impala" and job_logs is not None:
                job_logs.append("【Impala 进度】已提交 SQL，正在等待 Impala 执行完成。")
            cur.execute(clean_sql)
            if ds.type == "impala" and job_logs is not None:
                job_logs.append("【Impala 进度】SQL 执行完成，正在读取查询结果。")
            fetched = cur.fetchmany(limit + 1)
            truncated = len(fetched) > limit or (plan.clamped and len(fetched) >= limit)
            description = list(cur.description or [])
            if ds.type == "mysql":
                # DictCursor → list[dict];列名从 description 取,空结果集也能保留表头
                columns = [str(d[0]).lower() for d in description]
                rows = [dict(row) for row in fetched[:limit]]
            else:
                columns = [str(d[0]).lower() for d in description]
                rows = _rows_to_dicts(fetched[:limit], description)
            if ds.type == "impala" and job_logs is not None:
                job_logs.append("【Impala 进度】结果读取完成：%d 行、%d 列。" % (len(rows), len(columns)))
        finally:
            _publish_cursor(ds, conn, None, state)
            try:
                cur.close()
            except Exception:
                pass
        return {
            "columns": columns,
            "rows": rows,
            "costMs": int((time.time() - start) * 1000),
            "truncated": truncated,
            "limit": limit,
            "limited": plan.rewritten,
        }
    # 写语句(INSERT/UPDATE/DELETE):执行并返回受影响行数
    # 注意:pymysql 的 execute() 返回受影响行数,但 python-oracledb 返回 None,
    # 统一用 cursor.rowcount(commit 前有效,此处顺序正确),修复 Oracle 审计 affected 恒 null。
    cur = conn.cursor()
    _publish_cursor(ds, conn, cur, state)
    try:
        cur.execute(clean_sql)
        affected = cur.rowcount
        conn.commit()
    finally:
        _publish_cursor(ds, conn, None, state)
        try:
            cur.close()
        except Exception:
            pass
    return {
        "columns": ["affected_rows"],
        "rows": [{"affected_rows": affected}],
        "costMs": int((time.time() - start) * 1000),
        "truncated": False,
    }


def _publish_cursor(ds: Any, conn: Any, cursor, state: Optional[Dict[str, Any]]) -> None:
    """把执行中的 cursor 与取消所需的会话标识登记到异步 job 状态里。"""
    if state is None:
        return
    if cursor is None:
        state["cursor"] = None
        return
    state["cursor"] = cursor
    try:
        if ds.type == "mysql":
            state["thread_id"] = _query_thread_id(conn)
        elif ds.type == "oracle":
            state["session_ids"] = _oracle_session_ids(conn)
    except Exception:
        pass


def _impala_read_only(sql: str) -> bool:
    """AI 修复只允许保持只读语义,避免模型把查询改成 DML/DDL。"""
    clean = re.sub(r"--[^\n]*|/\*[\s\S]*?\*/", "", sql or "").strip()
    if not READ_ONLY_SQL_RE.match(clean):
        return False
    if re.match(r"^WITH\b", clean, re.IGNORECASE) and re.search(
        r"\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b", clean, re.IGNORECASE
    ):
        return False
    return IMPALA_ENGINE.is_read_only_sql(clean)


def _execute_database(
    ds: DataSource,
    conn: Any,
    clean_sql: str,
    is_select: bool,
    start: float,
    job_logs: Optional[List[str]] = None,
    query_timeout: Optional[int] = None,
    state: Optional[Dict[str, Any]] = None,
    ai_fix_enabled: Optional[bool] = None,
) -> Dict[str, Any]:
    """执行数据库语句,并为 Impala 增加类型检查、AI 修复与结构化日志。"""
    logs: List[str] = job_logs if job_logs is not None else []
    run_sql = clean_sql
    schema_summary = None
    if ds.type == "impala" and ds.read_only and not is_select:
        logs.append("【安全拦截】当前 Impala 数据源为只读模式，已拒绝写入操作。")
        raise DbError(ds.type, "ReadOnly", None, "Impala datasource is configured read-only", logs)
    if ds.type == "impala" and is_select:
        schema_conn = None
        try:
            # Impyla cursors share a Thrift transport/session; isolate DESCRIBE from query execution.
            if IMPALA_ENGINE.type_check_available:
                schema_conn = ds.connect(DB_CONNECT_TIMEOUT, query_timeout or QUERY_TIMEOUT)
                run_sql, schema_summary = IMPALA_ENGINE.prepare_sql(
                    schema_conn, run_sql, logs, _impala_cache_namespace(ds), ds.service
                )
            elif IMPALA_ENGINE.type_check_enabled:
                logs.append("【类型校验】未安装 sqlglot，本次跳过类型校验。")
        except Exception as exc:
            logs.append("【类型校验】准备校验时发生错误，继续执行原 SQL：%s。" % (str(exc) or exc.__class__.__name__))
        finally:
            if schema_conn is not None:
                try:
                    schema_conn.close()
                except Exception:
                    pass
    ai_attempt = 0
    while True:
        logs.append("【执行】开始执行 SQL（第 %d 次）。" % (ai_attempt + 1))
        if ai_attempt:
            logs.append("【AI 修正后实际执行 SQL】\n" + run_sql)
        try:
            if ds.type == "impala":
                logs.append("【Impala 进度】类型校验完成，准备提交 SQL。")
            result = _execute_query(ds, conn, run_sql, is_select, start, logs, state)
            if ds.type == "impala":
                logs.append("【执行成功】耗时 %s 毫秒。" % result.get("costMs", 0))
                result["engine"] = "impala"
                result["executedSql"] = run_sql
                result["logs"] = logs
            return result
        except Exception as exc:
            if ds.type != "impala" or not is_select:
                de = _extract_sql_error(exc, ds.type)
                de.logs = logs
                raise de
            de = _extract_sql_error(exc, ds.type)
            if de.error_type not in ("SyntaxError", "TypeMismatch", "ColumnNotFound", "TableNotFound"):
                logs.append("【AI 修复】错误类型为 %s，当前不自动修复。" % de.error_type)
                de.logs = logs
                raise de
            if ai_fix_enabled is False:
                logs.append("【执行失败】错误类型：%s。" % de.error_type)
                logs.append("【执行失败】数据库详情：%s" % de.message)
                logs.append("【AI 修复】工作台已关闭 AI 自动修复，本次保留原 SQL。")
                de.logs = logs
                raise de
            error_labels = {
                "SyntaxError": "SQL 语法错误",
                "TypeMismatch": "字段类型不匹配",
                "ColumnNotFound": "字段或表引用无法识别",
                "TableNotFound": "数据表不存在",
            }
            logs.append("【执行失败】错误类型：%s（%s）。" % (error_labels.get(de.error_type, de.error_type), de.error_type))
            logs.append("【执行失败】数据库详情：%s" % de.message)
            if de.error_type in ("ColumnNotFound", "TableNotFound", "TypeMismatch"):
                schema_conn = None
                try:
                    schema_conn = ds.connect(DB_CONNECT_TIMEOUT, query_timeout or QUERY_TIMEOUT)
                    if de.error_type == "TableNotFound":
                        refreshed_tables = IMPALA_ENGINE.list_tables(
                            schema_conn, _impala_cache_namespace(ds), ds.service, refresh=True
                        )
                        logs.append("【元数据刷新】已更新表清单（%d 张表）。" % len(refreshed_tables))
                    refreshed_schema = IMPALA_ENGINE.refresh_sql_schema(
                        schema_conn, run_sql, logs, _impala_cache_namespace(ds), ds.service
                    )
                    if refreshed_schema:
                        schema_summary = _impala_schema_summary(refreshed_schema)
                except Exception as refresh_exc:
                    logs.append("【元数据刷新】刷新失败，继续处理原始错误：%s。" % (str(refresh_exc) or refresh_exc.__class__.__name__))
                finally:
                    if schema_conn is not None:
                        try:
                            schema_conn.close()
                        except Exception:
                            pass
            ai_attempt += 1
            new_sql = IMPALA_ENGINE.rewrite_sql(
                run_sql,
                de.message,
                schema_summary,
                logs,
                ai_attempt,
            )
            if not new_sql:
                if not IMPALA_ENGINE.ai.enabled:
                    logs.append("【AI 修复】未启用 AI 修复，结束自动重试。")
                de = _extract_sql_error(exc, ds.type)
                de.logs = logs
                raise de
            if not _impala_read_only(new_sql):
                logs.append("【安全校验】AI 返回的 SQL 不是只读查询，已拒绝执行。")
                de = _extract_sql_error(exc, ds.type)
                de.logs = logs
                raise de
            run_sql = new_sql.strip().rstrip(";").strip()
            try:
                schema_conn = ds.connect(DB_CONNECT_TIMEOUT, query_timeout or QUERY_TIMEOUT)
                try:
                    run_sql, schema_summary = IMPALA_ENGINE.prepare_sql(
                        schema_conn, run_sql, logs, _impala_cache_namespace(ds), ds.service
                    )
                finally:
                    schema_conn.close()
            except Exception as type_exc:
                logs.append("【类型校验】AI 修复后的 SQL 未能完成字段校验，继续尝试执行：%s。" % (str(type_exc) or type_exc.__class__.__name__))


def fetch(sql: str, db: str, timeout_ms: Optional[int] = None, source: str = "sync", schema_name: Optional[str] = None) -> Dict[str, Any]:
    """连接并执行 SQL,返回 {columns, rows, costMs, truncated}。
    SELECT 类返回结果集;写语句(INSERT/UPDATE/DELETE)返回受影响行数。
    timeout_ms:覆盖默认查询超时(异步 job 用,大查询可传更长,不撞网关 60s)。
    写语句执行(成功/失败/连接失败)后追加一条审计日志(source='sync'|'async')。"""
    ds, clean_sql, is_select, q_timeout, start = _prepare_query(
        sql, db, timeout_ms, source=source
    )
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout, schema_name=schema_name)
    except Exception as e:
        de = _extract_sql_error(e, ds.type)
        if de.error_type == "DatabaseError":
            de = DbError(ds.type, "ConnectError", de.error_code, de.message)
        if not is_select:
            _write_audit(db, ds.type, clean_sql, None, (time.time() - start) * 1000, source)
        raise DbError(ds.type, de.error_type, de.error_code, f"connect failed: {de.message}", de.logs)
    try:
        result = _execute_database(ds, conn, clean_sql, is_select, start, query_timeout=q_timeout)
        if not is_select:
            affected = (
                result["rows"][0].get("affected_rows") if result.get("rows") else None
            )
            _write_audit(db, ds.type, clean_sql, affected, result["costMs"], source)
        return result
    except Exception as e:
        if not is_select:
            _write_audit(db, ds.type, clean_sql, None, (time.time() - start) * 1000, source)
        de = e if isinstance(e, DbError) else _extract_sql_error(e, ds.type)
        if not de.logs:
            de.logs = []
        raise DbError(ds.type, de.error_type, de.error_code, f"query failed: {de.message}", de.logs)
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
    aiFix: Optional[bool] = None  # 异步 Impala job 的 AI 修复选择;省略沿用服务端配置
    schemaName: Optional[str] = None  # Oracle owner/schema 上下文;省略兼容默认 owner,空字符串读取全部允许的 schema


class Db2HiveReq(BaseModel):
    db_name: str
    table_name: str
    align_with_hive: bool = True
    datasource_id: Optional[str] = None
    service_name: Optional[str] = None
    owner: Optional[str] = None


def _eligible_sync_datasource(ds: DataSource) -> bool:
    return ds.type in ("mysql", "oracle") and ds.source_type in ("mysql", "oracle")


def _find_sync_datasource_by_id(datasource_id: str) -> DataSource:
    ds = DATASOURCES.get(datasource_id)
    if ds is None or not _eligible_sync_datasource(ds):
        raise HTTPException(status_code=404, detail="未找到可用于数据同步的 MySQL/Oracle 数据源")
    return ds


def _find_sync_datasource(db_name: str) -> DataSource:
    """Legacy lookup: before datasource_id existed, db_name also selected the source."""
    query = db_name.strip().casefold()
    eligible = [ds for ds in DATASOURCES.values() if _eligible_sync_datasource(ds)]
    for attribute in ("name", "label", "service"):
        matches = [ds for ds in eligible if str(getattr(ds, attribute, "")).casefold() == query]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise HTTPException(status_code=409, detail="数据库名称匹配到多个数据源，请使用数据源 name")
    matches = [
        ds for ds in eligible
        if query and (query in ds.name.casefold() or query in ds.label.casefold())
    ]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise HTTPException(status_code=409, detail="数据库名称匹配到多个数据源，请使用完整数据源 name")
    raise HTTPException(status_code=404, detail="未找到可用于数据同步的 MySQL/Oracle 数据源")


def _validate_schema_context(ds: DataSource, schema_name: Optional[str]) -> Optional[str]:
    requested = str(schema_name or "").strip().upper()
    if not requested:
        if ds.type != "oracle":
            return None
        if schema_name is None:
            if ds.owner and ds.owners and ds.owner not in ds.owners:
                raise HTTPException(status_code=403, detail="默认 owner 不在当前数据源允许的 schema 列表中")
            return ds.owner
        return ""
    if ds.type != "oracle":
        raise HTTPException(status_code=400, detail="schemaName 仅支持 Oracle 数据源")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_$#]{0,127}", requested):
        raise HTTPException(status_code=400, detail="schemaName 不是有效的 Oracle schema 名称")
    if ds.owners and requested not in ds.owners:
        raise HTTPException(status_code=403, detail="schemaName 不在当前数据源允许的 schema 列表中")
    return requested


def _oracle_owner_clause(ds: DataSource, schema_name: Optional[str], prefix: str = "owner", owner_column: str = "owner") -> Tuple[str, Dict[str, str]]:
    requested = str(schema_name or "").strip().upper()
    if schema_name is None and ds.owner:
        requested = ds.owner
    if requested:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_$#]{0,127}", requested):
            raise HTTPException(status_code=400, detail="schemaName 不是有效的 Oracle schema 名称")
        if ds.owners and requested not in ds.owners:
            raise HTTPException(status_code=403, detail="schemaName 不在当前数据源允许的 schema 列表中")
        return " AND {} = :{}".format(owner_column, prefix), {prefix: requested}
    if ds.owners:
        binds = {"{}{}".format(prefix, index): owner for index, owner in enumerate(ds.owners)}
        placeholders = ", ".join(":" + name for name in binds)
        return " AND {} IN ({})".format(owner_column, placeholders), binds
    return "", {}


@app.post("/sync/db2hive")
def sync_db2hive(
    req: Db2HiveReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    db_name = req.db_name.strip()
    table_name = req.table_name.strip()
    datasource_id = str(req.datasource_id or "").strip()
    service_name = str(req.service_name or "").strip()
    requested_owner = str(req.owner or "").strip()
    if not db_name or not table_name:
        raise HTTPException(status_code=400, detail="db_name 和 table_name 不能为空")
    if not re.fullmatch(r"[A-Za-z0-9_$#]+(?:\.[A-Za-z0-9_$#]+)?", table_name):
        raise HTTPException(status_code=400, detail="table_name 只允许表名，或旧版 Oracle OWNER.TABLE 格式")
    ds = _find_sync_datasource_by_id(datasource_id) if datasource_id else _find_sync_datasource(db_name)
    if ds.type == "oracle":
        if service_name and service_name.casefold() != ds.service.casefold():
            raise HTTPException(status_code=400, detail="service_name 必须与所选数据源的 Oracle Service Name 一致")
        if "." in table_name:
            table_owner, table_name = table_name.split(".", 1)
            if requested_owner and table_owner.upper() != requested_owner.upper():
                raise HTTPException(status_code=400, detail="OWNER.TABLE 中的 owner 与单独传入的 owner 不一致")
            requested_owner = table_owner
        requested_owner = requested_owner.strip().upper()
        if requested_owner and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_$#]{0,127}", requested_owner):
            raise HTTPException(status_code=400, detail="owner 不是有效的 Oracle schema 名称")
        if requested_owner and ds.owners and requested_owner not in ds.owners:
            raise HTTPException(status_code=403, detail="owner 不在当前数据源允许的 schema 列表中")
        if not requested_owner:
            requested_owner = ds.owner or None
        if requested_owner and ds.owners and requested_owner not in ds.owners:
            raise HTTPException(status_code=403, detail="owner 不在当前数据源允许的 schema 列表中")
    else:
        if service_name or requested_owner:
            raise HTTPException(status_code=400, detail="service_name 和 owner 仅支持 Oracle 数据源")
        if "." in table_name:
            raise HTTPException(status_code=400, detail="OWNER.TABLE 格式仅支持 Oracle 数据源")
    try:
        data = generate_db2hive(
            ds,
            db_name,
            table_name,
            req.align_with_hive,
            CONFIG.get("dataSync") or {},
            DB_CONNECT_TIMEOUT,
            QUERY_TIMEOUT,
            oracle_owner=requested_owner,
        )
        return {"code": 0, "data": data}
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        if not (CONFIG.get("dataSync") or {}).get("enabled", False):
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        log.exception("db2hive generation failed datasource=%s table=%s", ds.name, table_name)
        raise HTTPException(status_code=502, detail="同步代码生成失败，请检查 db-proxy 日志与 dataSync 配置") from exc
    except Exception as exc:
        log.exception("db2hive generation failed datasource=%s table=%s", ds.name, table_name)
        raise HTTPException(status_code=502, detail="同步代码生成失败，请检查 db-proxy 日志") from exc


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"code": 0, "msg": "ok"}


@app.get("/dbs")
def dbs(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    names = sorted(DATASOURCES.keys())
    # 不做库白名单过滤:读写限制统一在门户网关侧
    return {"code": 0, "data": names}


class DbJobManager:
    """通用数据库异步任务(mysql/oracle/impala):提交即返回 jobId,后台线程执行。

    动机:公司网关固定 60s 读超时,mysql/oracle 慢查询/大查询同步挂起
    会被掐断 504;异步化后提交/查状态/取消均为秒级往返。
    取消是**真实取消**:MySQL/Doris 用 KILL QUERY、Oracle 用 Connection.cancel 或
    KILL SESSION、Impala 用 CancelOperation;都失败才退化为关闭连接。
    """

    def __init__(self, max_jobs: int = 200, ttl: int = 3600) -> None:
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._max_jobs = max_jobs
        self._ttl = ttl

    def submit(self, db: str, sql: str, timeout_ms: int = 3600000,
               owner: Optional[str] = None, ai_fix: Optional[bool] = None,
               schema_name: Optional[str] = None) -> str:
        # 数据源在提交阶段就解析:未知 db 立刻 404,而不是等后台线程失败
        ds = get_datasource(db)
        # 与同步 /query 共享全局与主体级并发/QPS 配额。
        _acquire_query_slot(owner)
        try:
            job_id = "dbj_%s" % uuid.uuid4().hex
            with self._lock:
                self._jobs[job_id] = {
                    "id": job_id, "state": "queued", "db": db, "sql": sql,
                    "timeout_ms": timeout_ms, "ai_fix": ai_fix, "schema_name": schema_name, "created_at": time.time(),
                    "started_at": None, "finished_at": None,
                    "result": None, "error": None, "logs": [], "executed_sql": None,
                    "conn": None, "cursor": None, "thread_id": None,
                    "session_ids": None, "ds": ds, "owner": owner,
                    "cancel_requested": False, "cancel_method": None,
                }
            threading.Thread(target=self._run, args=(job_id, owner), daemon=True, name="db-job-%s" % job_id).start()
            return job_id
        except Exception:
            _release_query_slot(owner)
            raise

    def _run(self, job_id: str, owner: str) -> None:
        try:
            self._run_inner(job_id)
        finally:
            # 无论成功/失败/取消,释放全局与主体级查询槽(submit 已 acquire)
            _release_query_slot(owner)

    def _job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self._jobs.get(job_id)

    def _run_inner(self, job_id: str) -> None:
        j = self._job(job_id)
        if not j:
            return
        if j.get("cancel_requested"):  # 提交后未开始即被取消
            j["state"] = "cancelled"
            j["finished_at"] = time.time()
            return
        j["state"] = "running"
        j["started_at"] = time.time()
        conn = None
        ds = j.get("ds")
        clean_sql = ""
        is_select = False
        start = time.time()
        try:
            # 异步 job 用更长查询超时(默认 1 小时,可配置),不再受网关 60s 限制
            ds, clean_sql, is_select, q_timeout, start = _prepare_query(j["sql"], j["db"], j["timeout_ms"], source="async")
            j["ds"] = ds
            if ds.type == "impala":
                j["logs"].append("【Impala 进度】任务已启动，正在连接数据源。")
            try:
                conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout, schema_name=j.get("schema_name"))
            except Exception as exc:
                de = _extract_sql_error(exc, ds.type)
                if de.error_type == "DatabaseError":
                    de.error_type = "ConnectError"
                raise DbError(
                    ds.type, de.error_type, de.error_code,
                    "connect failed: %s" % de.message, j["logs"]
                ) from exc
            j["conn"] = conn  # 持有连接:取消时先杀语句再关连接
            if ds.type == "impala":
                j["logs"].append("【Impala 进度】数据源连接成功，开始 SQL 类型校验。")
            try:
                result = _execute_database(
                    ds, conn, clean_sql, is_select, start, j["logs"], q_timeout, j,
                    ai_fix_enabled=j.get("ai_fix")
                )
            finally:
                j["conn"] = None
                j["cursor"] = None
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
            j["logs"] = result.get("logs", []) or j["logs"]
            j["executed_sql"] = result.get("executedSql")
            j["state"] = "done"
        except Exception as e:
            if j.get("cancel_requested"):
                # 用户主动停止:数据库侧语句已被 KILL/取消,记为 cancelled 而非 failed
                j["state"] = "cancelled"
                if j.get("cancel_method"):
                    j["logs"].append("【已停止】取消方式：%s。" % j["cancel_method"])
            else:
                # 写语句执行失败也审计(仅当 _prepare_query 已通过,避免 readOnly 等前置拦截重复记录)
                if not is_select and clean_sql and ds is not None:
                    _write_audit(j["db"], ds.type, clean_sql, None, (time.time() - start) * 1000, "async")
                if isinstance(e, DbError):
                    j["logs"] = list(e.logs)
                    diagnosis = _describe_db_error(e)
                    j["logs"].append("【错误诊断】" + diagnosis)
                    j["error"] = diagnosis[:2000]
                else:
                    j["error"] = str(e)[:2000]
                j["state"] = "failed"
        finally:
            j["finished_at"] = time.time()
            self._gc()

    def get(self, job_id: str, owner: Optional[str] = None) -> Optional[Dict[str, Any]]:
        with self._lock:
            j = self._jobs.get(job_id)
            if not j:
                return None
            if owner is not None and j.get("owner") != owner:
                return None
            return {
                "id": j["id"], "state": j["state"], "db": j["db"], "sql": j["sql"][:500],
                "createdAt": j["created_at"], "startedAt": j["started_at"],
                "finishedAt": j["finished_at"], "result": j["result"], "error": j["error"],
                "logs": list(j.get("logs") or []), "executedSql": j.get("executed_sql"),
                "cancelMethod": j.get("cancel_method"),
            }

    def cancel(self, job_id: str, owner: Optional[str] = None) -> bool:
        """取消 queued/running 的 job:**在数据库侧终止语句**,再关连接兜底。

        顺序:标记 cancel_requested → ds.cancel_query(KILL QUERY / Connection.cancel /
        KILL SESSION / CancelOperation)→ 关闭连接。执行线程的 execute/fetch 会立即抛错,
        _run_inner 据此判定为 cancelled(用户主动停止),而非 failed。
        """
        with self._lock:
            j = self._jobs.get(job_id)
            if not j or j["state"] not in ("queued", "running"):
                return False
            if owner is not None and j.get("owner") != owner:
                return False
            j["cancel_requested"] = True
            conn = j.get("conn")
            cursor = j.get("cursor")
            thread_id = j.get("thread_id")
            session_ids = j.get("session_ids")
            ds = j.get("ds")
        method = "close"
        if ds is not None and conn is not None:
            try:
                method = ds.cancel_query(
                    conn, cursor=cursor, thread_id=thread_id, session_ids=session_ids
                )
            except Exception as exc:
                _cancel_log("cancel_query failed for %s: %s" % (job_id, exc))
        with self._lock:
            j["cancel_method"] = method
            j["logs"].append("【停止中】已请求终止数据库侧语句（%s）。" % method)
        # 语句已在数据库侧终止(或已降级),关闭连接释放会话资源
        if conn is not None:
            try:
                conn.close()
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
    req: QueryReq,
    x_db_token: Optional[str] = Header(default=None),
    x_db_subject: Optional[str] = Header(default=None),
    x_db_subject_signature: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_auth(x_db_token)
    subject, _ = verified_subject(x_db_subject, x_db_subject_signature)
    _acquire_query_slot(subject)
    try:
        # SQL 长度上限(防超大 SQL)
        if len(req.sql) > MAX_SQL_LEN:
            raise HTTPException(
                status_code=400,
                detail=f"SQL too long: {len(req.sql)} > MAX_SQL_LEN({MAX_SQL_LEN})",
            )
        ds = get_datasource(req.db)
        schema_context = _validate_schema_context(ds, req.schemaName)
        # 读写限制已收口到门户网关侧,此处仅保留资源护栏(行数/长度/超时/限流)
        result = fetch(req.sql, req.db, schema_name=schema_context)
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
                "detail": _describe_db_error(e)[:500],
                "logs": e.logs,
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        log.exception("query unexpected error: %.300s", str(e))
        raise HTTPException(status_code=500, detail=str(e)[:500])
    finally:
        _release_query_slot(subject)


def _acquire_query_slot(subject: str) -> None:
    """原子申请全局与主体级并发槽，并累计双方的一秒滑动 QPS 窗口。"""
    now = time.time()
    with _qps_lock:
        active = _subject_active.get(subject, 0)
        if active >= MAX_CONCURRENT_PER_SUBJECT:
            raise HTTPException(
                status_code=429,
                detail=f"too many concurrent queries for subject (max={MAX_CONCURRENT_PER_SUBJECT})",
            )
        if not _query_semaphore.acquire(blocking=False):
            raise HTTPException(
                status_code=429, detail=f"too many concurrent queries (max={MAX_CONCURRENT})"
            )
        subject_window = None
        try:
            while _qps_window and now - _qps_window[0] > 1.0:
                _qps_window.popleft()
            for key, window in list(_subject_qps.items()):
                while window and now - window[0] > 1.0:
                    window.popleft()
                if not window:
                    _subject_qps.pop(key, None)
            subject_window = _subject_qps.setdefault(subject, collections.deque())
            while subject_window and now - subject_window[0] > 1.0:
                subject_window.popleft()
            if len(_qps_window) >= MAX_QPS:
                raise HTTPException(status_code=429, detail=f"too many requests (max {MAX_QPS} qps)")
            if len(subject_window) >= MAX_QPS_PER_SUBJECT:
                raise HTTPException(
                    status_code=429,
                    detail=f"too many requests for subject (max {MAX_QPS_PER_SUBJECT} qps)",
                )
            _qps_window.append(now)
            subject_window.append(now)
            _subject_active[subject] = active + 1
        except Exception:
            if not subject_window:
                _subject_qps.pop(subject, None)
            _query_semaphore.release()
            raise


def _release_query_slot(subject: Optional[str]) -> None:
    if subject is None:
        return
    with _qps_lock:
        active = _subject_active.get(subject, 0)
        if active <= 1:
            _subject_active.pop(subject, None)
        else:
            _subject_active[subject] = active - 1
        _query_semaphore.release()
        subject_window = _subject_qps.get(subject)
        if subject_window is not None:
            now = time.time()
            while subject_window and now - subject_window[0] > 1.0:
                subject_window.popleft()
            if not subject_window:
                _subject_qps.pop(subject, None)


@app.post("/jobs")
def db_job_submit(
    req: QueryReq,
    x_db_token: Optional[str] = Header(default=None),
    x_db_subject: Optional[str] = Header(default=None),
    x_db_subject_signature: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """异步提交 MySQL/Oracle/Impala 查询并按已验签主体隔离配额与任务结果。"""
    require_auth(x_db_token)
    subject, _ = verified_subject(x_db_subject, x_db_subject_signature)
    if not req.sql or not req.sql.strip():
        raise HTTPException(status_code=400, detail="sql is required")
    # 与同步 /query 同一护栏:异步入口不能绕过 SQL 长度上限
    if len(req.sql) > MAX_SQL_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"SQL too long: {len(req.sql)} > MAX_SQL_LEN({MAX_SQL_LEN})",
        )
    ds = get_datasource(req.db)
    schema_context = _validate_schema_context(ds, req.schemaName)
    timeout_ms = req.timeoutMs or 3600000
    job_id = DB_JOBS.submit(
        req.db, req.sql, timeout_ms, owner=subject, ai_fix=req.aiFix,
        schema_name=schema_context,
    )
    log.info("db job submitted: %s db=%s", job_id, req.db)
    return {"code": 0, "data": {"jobId": job_id}}


@app.get("/jobs/{job_id}")
def db_job_status(
    job_id: str,
    x_db_token: Optional[str] = Header(default=None),
    x_db_subject: Optional[str] = Header(default=None),
    x_db_subject_signature: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_auth(x_db_token)
    subject, is_admin = verified_subject(x_db_subject, x_db_subject_signature)
    j = DB_JOBS.get(job_id, owner=None if is_admin else subject)
    if not j:
        raise HTTPException(status_code=404, detail="job not found: %s" % job_id)
    return {"code": 0, "data": j}


@app.post("/jobs/{job_id}/cancel")
def db_job_cancel(
    job_id: str,
    x_db_token: Optional[str] = Header(default=None),
    x_db_subject: Optional[str] = Header(default=None),
    x_db_subject_signature: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_auth(x_db_token)
    subject, is_admin = verified_subject(x_db_subject, x_db_subject_signature)
    if not DB_JOBS.cancel(job_id, owner=None if is_admin else subject):
        raise HTTPException(status_code=404, detail="job not found or already finished: %s" % job_id)
    return {"code": 0, "data": {"cancelled": True}}


class DatasourceAdminRequest(BaseModel):
    name: Optional[str] = None
    label: Optional[str] = None
    type: str
    host: str
    port: int
    user: str
    password: Optional[str] = None
    database: Optional[str] = None
    serviceName: Optional[str] = None
    owner: Optional[str] = None
    owners: Optional[List[str]] = None
    charset: Optional[str] = None
    rowLimit: Optional[str] = None
    readOnly: bool = False
    expectedRevision: Optional[str] = None


def _admin_revision(config: Dict[str, Any]) -> str:
    serialized = json.dumps(config.get("datasources", []), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    key = str(config.get("adminToken") or "db-proxy-unconfigured").encode("utf-8")
    return hmac.new(key, serialized.encode("utf-8"), hashlib.sha256).hexdigest()[:24]


def _managed_source(ds: DataSource) -> bool:
    return ds.type in ("mysql", "oracle")


def _admin_datasource_dict(ds: DataSource) -> Dict[str, Any]:
    kind = "doris" if ds.source_type == "doris" else ds.type
    return {
        "name": ds.name,
        "label": ds.label,
        "type": kind,
        "host": ds.host,
        "port": ds.port,
        "user": ds.user,
        "database": ds.service if ds.type == "mysql" else None,
        "serviceName": ds.service if ds.type == "oracle" else None,
        "owner": ds.owner if ds.type == "oracle" else None,
        "owners": ds.owners if ds.type == "oracle" else None,
        "charset": ds.charset if ds.type == "mysql" else None,
        "rowLimit": ds.row_limit if ds.type == "oracle" else None,
        "readOnly": ds.read_only,
        "hasPassword": bool(ds.password),
    }


def _require_admin_token(provided: Optional[str]) -> None:
    expected = str(CONFIG.get("adminToken", ""))
    if not expected or secrets.compare_digest(expected, AUTH_TOKEN or ""):
        raise HTTPException(status_code=503, detail="db-proxy adminToken must be configured separately from authToken")
    if not secrets.compare_digest(provided or "", expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def _read_admin_config() -> Dict[str, Any]:
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as stream:
            cfg = json.load(stream)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="datasources.json could not be read") from exc
    if not isinstance(cfg, dict) or not isinstance(cfg.get("datasources"), list):
        raise HTTPException(status_code=500, detail="datasources.json has invalid structure")
    return cfg


def _resolve_admin_source(raw: Dict[str, Any], config: Dict[str, Any]) -> Dict[str, Any]:
    cfg = dict(raw)
    profile_name = cfg.pop("connectionProfile", None)
    if profile_name is not None:
        profile = (config.get("connectionProfiles") or {}).get(str(profile_name))
        if not isinstance(profile, dict):
            raise ValueError("datasource references an invalid connection profile")
        cfg = {**profile, **cfg}
    return _expand_connection_string(cfg)


def _parse_admin_request(payload: Any) -> DatasourceAdminRequest:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="datasource request must be an object")
    try:
        return DatasourceAdminRequest(**payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="invalid datasource request fields") from exc


def _validate_admin_fields(request: DatasourceAdminRequest, *, creating: bool, validate_owner_allowlist: bool = True) -> Dict[str, Any]:
    name = str(request.name or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name):
        raise HTTPException(status_code=400, detail="name must use letters, digits, dot, underscore, or hyphen")
    kind = str(request.type or "").strip().lower()
    if kind not in ("mysql", "oracle", "doris"):
        raise HTTPException(status_code=400, detail="type must be mysql, oracle, or doris")
    host = str(request.host or "").strip()
    if not host or len(host) > 255 or any(char.isspace() for char in host) or any(char in host for char in "/\\@?#"):
        raise HTTPException(status_code=400, detail="host is invalid")
    if not 1 <= int(request.port) <= 65535:
        raise HTTPException(status_code=400, detail="port must be between 1 and 65535")
    username = str(request.user or "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="user is required")
    password = request.password
    if creating and not password:
        raise HTTPException(status_code=400, detail="password is required for a new datasource")

    result: Dict[str, Any] = {
        "name": name,
        "label": str(request.label or "").strip() or name,
        "type": "mysql" if kind == "doris" else kind,
        "sourceType": kind,
        "host": host,
        "port": int(request.port),
        "user": username,
        "readOnly": bool(request.readOnly),
    }
    if password:
        result["password"] = password
    if kind in ("mysql", "doris"):
        database = str(request.database or "").strip()
        if not database:
            raise HTTPException(status_code=400, detail="database is required")
        result["database"] = database
        result["charset"] = str(request.charset or "utf8mb4").strip() or "utf8mb4"
    else:
        service = str(request.serviceName or "").strip()
        if not service:
            raise HTTPException(status_code=400, detail="Oracle serviceName is required")
        owner = str(request.owner or "").strip().upper()
        if owner and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_$#]{0,127}", owner):
            raise HTTPException(status_code=400, detail="owner must be a valid Oracle schema identifier")
        owners = request.owners or []
        if not isinstance(owners, list) or len(owners) > 500:
            raise HTTPException(status_code=400, detail="owners must be a list of at most 500 Oracle schema names")
        normalized_owners = sorted({str(value).strip().upper() for value in owners if str(value).strip()})
        if any(not re.fullmatch(r"[A-Za-z][A-Za-z0-9_$#]{0,127}", value) for value in normalized_owners):
            raise HTTPException(status_code=400, detail="owners contains an invalid Oracle schema identifier")
        if validate_owner_allowlist and owner and normalized_owners and owner not in normalized_owners:
            raise HTTPException(status_code=400, detail="default owner must be included in the owners allowlist")
        row_limit = str(request.rowLimit or "").strip().lower()
        if row_limit and row_limit not in ("fetch", "rownum"):
            raise HTTPException(status_code=400, detail="rowLimit must be fetch or rownum")
        result["service"] = service
        result["owner"] = owner
        result["owners"] = normalized_owners
        if row_limit:
            result["rowLimit"] = row_limit
    return result


def _save_admin_config(candidate: Dict[str, Any], sources: Dict[str, DataSource]) -> None:
    temp_path = CONFIG_FILE + ".tmp"
    try:
        with open(temp_path, "w", encoding="utf-8") as stream:
            os.chmod(temp_path, 0o600)
            json.dump(candidate, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, CONFIG_FILE)
        try:
            os.chmod(CONFIG_FILE, 0o600)
        except OSError:
            pass
    except Exception as exc:
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail="datasources.json could not be saved") from exc

    global CONFIG, DATASOURCES
    CONFIG = candidate
    DATASOURCES = sources


def _redact_admin_error(error: BaseException, password: str = "") -> str:
    text = str(error)
    if password:
        text = text.replace(password, "<redacted>")
    text = " ".join(text.split()) or "connection failed"
    text = re.sub(r"(?i)(password|passwd|pwd)(\s*[:=]\s*)(?:'[^']*'|\"[^\"]*\"|[^\s,;]+)", r"\1\2<redacted>", text)
    text = re.sub(r"(?i)\b(mysql|oracle)://[^\s/@]+:[^\s/@]+@", r"\1://<redacted>@", text)
    return text[:500]


def _admin_mutate_datasources(action: str, name: str, incoming: Optional[Dict[str, Any]], expected_revision: Optional[str]) -> Dict[str, Any]:
    global CONFIG, DATASOURCES
    with _DATASOURCE_CONFIG_LOCK:
        current = _read_admin_config()
        current_revision = _admin_revision(current)
        if expected_revision and not secrets.compare_digest(expected_revision, current_revision):
            raise HTTPException(status_code=409, detail="datasources changed; refresh and retry")
        raw_sources = current["datasources"]
        indices = [index for index, item in enumerate(raw_sources) if isinstance(item, dict) and str(item.get("name", "")) == name]
        if action == "create" and indices:
            raise HTTPException(status_code=409, detail="datasource name already exists")
        if action in ("update", "delete") and not indices:
            raise HTTPException(status_code=404, detail="datasource not found")
        if len(indices) > 1:
            raise HTTPException(status_code=409, detail="duplicate datasource names exist in configuration")

        candidate = dict(current)
        raw_copy = [dict(item) if isinstance(item, dict) else item for item in raw_sources]
        if action == "delete":
            old_cfg = _resolve_admin_source(raw_copy[indices[0]], current)
            old_ds = DataSource(old_cfg)
            if not _managed_source(old_ds):
                raise HTTPException(status_code=400, detail="datasource type cannot be managed here")
            raw_copy.pop(indices[0])
        else:
            assert incoming is not None
            submitted_name = str(incoming.get("name") or "").strip()
            if submitted_name != name:
                raise HTTPException(status_code=400, detail="datasource name cannot be changed")
            previous: Dict[str, Any] = {}
            if action == "update":
                previous = _resolve_admin_source(raw_copy[indices[0]], current)
                previous_ds = DataSource(previous)
                if not _managed_source(previous_ds):
                    raise HTTPException(status_code=400, detail="datasource type cannot be managed here")
                requested_type = str(incoming.get("type", "")).strip().lower()
                requested_source_type = str(incoming.get("sourceType", requested_type)).strip().lower()
                if requested_type != previous_ds.type or requested_source_type != previous_ds.source_type:
                    raise HTTPException(status_code=409, detail="datasource type cannot be changed; create a new name")
            built = dict(previous)
            built.update(incoming)
            if action == "update" and not incoming.get("password"):
                built["password"] = previous.get("password", "")
            built.pop("connectionString", None)
            built.pop("connectionProfile", None)
            if built.get("type") == "oracle":
                built.pop("database", None)
                built.pop("schema", None)
                built.pop("charset", None)
                if "rowLimit" not in incoming:
                    built.pop("rowLimit", None)
            else:
                built.pop("service", None)
                built.pop("schema", None)
                built.pop("rowLimit", None)
            if action == "create":
                raw_copy.append(built)
            else:
                raw_copy[indices[0]] = built

        candidate["datasources"] = raw_copy
        try:
            next_sources = _build_datasources(candidate, reject_duplicates=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=_redact_admin_error(exc)) from exc
        _save_admin_config(candidate, next_sources)
        items = [_admin_datasource_dict(ds) for ds in next_sources.values() if _managed_source(ds)]
        return {"datasources": items, "revision": _admin_revision(candidate)}


def _require_admin_header(x_db_admin_token: Optional[str]) -> None:
    _require_admin_token(x_db_admin_token)


@app.get("/admin/datasources")
def admin_list_datasources(x_db_admin_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    _require_admin_header(x_db_admin_token)
    with _DATASOURCE_CONFIG_LOCK:
        return {"code": 0, "data": {"datasources": [_admin_datasource_dict(ds) for ds in DATASOURCES.values() if _managed_source(ds)], "revision": _admin_revision(CONFIG)}}


@app.post("/admin/datasources")
def admin_create_datasource(payload: Any = Body(...), x_db_admin_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    _require_admin_header(x_db_admin_token)
    request = _parse_admin_request(payload)
    fields = _validate_admin_fields(request, creating=True)
    data = _admin_mutate_datasources("create", fields["name"], fields, request.expectedRevision)
    return {"code": 0, "data": data}


@app.put("/admin/datasources/{name}")
def admin_update_datasource(name: str, payload: Any = Body(...), x_db_admin_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    _require_admin_header(x_db_admin_token)
    request = _parse_admin_request(payload)
    target_name = str(name).strip()
    fields = _validate_admin_fields(request, creating=False)
    data = _admin_mutate_datasources("update", target_name, fields, request.expectedRevision)
    return {"code": 0, "data": data}


@app.delete("/admin/datasources/{name}")
def admin_delete_datasource(name: str, x_db_admin_token: Optional[str] = Header(default=None), expected_revision: Optional[str] = Header(default=None, alias="If-Match")) -> Dict[str, Any]:
    _require_admin_header(x_db_admin_token)
    data = _admin_mutate_datasources("delete", str(name).strip(), None, expected_revision)
    return {"code": 0, "data": data}


@app.post("/admin/datasources/discover-owners")
def admin_discover_owners(payload: Any = Body(...), x_db_admin_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    _require_admin_header(x_db_admin_token)
    request = _parse_admin_request(payload)
    fields = _validate_admin_fields(request, creating=False, validate_owner_allowlist=False)
    if request.type.strip().lower() != "oracle":
        raise HTTPException(status_code=400, detail="owner discovery only supports Oracle datasources")
    if not fields.get("password"):
        source = DATASOURCES.get(str(request.name or "").strip())
        if source is None or source.type != "oracle" or not source.password:
            raise HTTPException(status_code=400, detail="password is required to discover Oracle schemas")
        fields["password"] = source.password
    if not _query_semaphore.acquire(timeout=1):
        raise HTTPException(status_code=429, detail="db-proxy 当前连接测试繁忙，请稍后重试")
    connection = None
    cursor = None
    try:
        ds = DataSource(fields)
        connection = ds.connect(5, 10)
        cursor = connection.cursor()
        cursor.execute("SELECT DISTINCT owner FROM all_tables ORDER BY owner")
        owners = [str(row[0]).upper() for row in cursor.fetchall() if row and row[0]]
        return {"code": 0, "data": {"owners": owners, "count": len(owners)}}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=_redact_admin_error(exc, str(fields.get("password") or ""))) from exc
    finally:
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                pass
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
        _query_semaphore.release()


@app.post("/admin/datasources/test")
def admin_test_datasource(payload: Any = Body(...), x_db_admin_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    _require_admin_header(x_db_admin_token)
    request = _parse_admin_request(payload)
    fields = _validate_admin_fields(request, creating=True)
    started = time.monotonic()
    if not _query_semaphore.acquire(timeout=1):
        return {"code": 0, "data": {"ok": False, "elapsedMs": 0, "error": "db-proxy 当前连接测试繁忙，请稍后重试"}}
    connection = None
    cursor = None
    try:
        ds = DataSource(fields)
        connection = ds.connect(5, 5)
        cursor = connection.cursor()
        cursor.execute("SELECT 1 FROM dual" if ds.type == "oracle" else "SELECT 1")
        if cursor.fetchone() is None:
            raise RuntimeError("probe query returned no rows")
        return {"code": 0, "data": {"ok": True, "elapsedMs": int((time.monotonic() - started) * 1000)}}
    except HTTPException:
        raise
    except Exception as exc:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        return {"code": 0, "data": {"ok": False, "elapsedMs": elapsed_ms, "error": _redact_admin_error(exc, str(request.password or ""))}}
    finally:
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                pass
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
        _query_semaphore.release()


@app.get("/acl")
def acl(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    """回显当前配置(脱敏),排查用。"""
    require_auth(x_db_token)
    return {
        "code": 0,
        "data": {
            "datasources": [ds.to_dict() for ds in DATASOURCES.values()],
            "allowedDbs": [name for name in ALLOWED_DBS if name in DATASOURCES] if ALLOWED_DBS else sorted(DATASOURCES.keys()),
            "allowedTables": ALLOWED_TABLES,
            "defaultLimit": DEFAULT_LIMIT,
            "maxLimit": MAX_LIMIT,
            "maxSqlLen": MAX_SQL_LEN,
            "maxConcurrent": MAX_CONCURRENT,
            "maxQps": MAX_QPS,
            "maxConcurrentPerSubject": MAX_CONCURRENT_PER_SUBJECT,
            "maxQpsPerSubject": MAX_QPS_PER_SUBJECT,
            "identityEnabled": bool(IDENTITY_SECRET),
            "queryTimeout": QUERY_TIMEOUT,
            "authEnabled": bool(AUTH_TOKEN),
            "oracleThick": bool(ORACLE_CLIENT_LIB),
            "impala": IMPALA_ENGINE.status(),
            "spark": SPARK_ENGINE.status(),
            "flink": FLINK_ENGINE.status(),
        },
    }


# ── Spark SQL 双执行模式───────────────────────────────────────────
class SparkModeReq(BaseModel):
    executionMode: str = "thrift"


def _spark_engine(execution_mode: str = "thrift"):
    if execution_mode not in SPARK_ENGINES:
        raise HTTPException(status_code=400, detail="executionMode must be thrift or session")
    engine = SPARK_ENGINES[execution_mode]
    if not engine.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    return engine


class SparkQueryReq(SparkModeReq):
    kind: str = "sql"
    sql: Optional[str] = None
    writeUnlocked: bool = False
    timeoutMs: int = 120000


class SparkJobSubmitReq(SparkModeReq):
    sql: str = ""
    kind: str = "sql"
    writeUnlocked: bool = False
    timeoutMs: int = 600000  # 异步任务默认 10 分钟(大查询可传更久,不撞网关超时)


class SparkExportSubmitReq(SparkModeReq):
    sql: str
    timeoutMs: int = 7200000


@app.post("/spark/query")
def spark_query(
    req: SparkQueryReq,
    x_db_token: Optional[str] = Header(default=None),
    x_spark_write: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_auth(x_db_token)
    engine = _spark_engine(req.executionMode)
    try:
        if req.kind != "sql":
            raise HTTPException(status_code=400, detail="Spark 仅支持 SparkSQL")
        if not req.sql:
            raise HTTPException(status_code=400, detail="sql required")
        result = engine.execute_sql(req.sql, req.writeUnlocked, req.timeoutMs)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except HTTPException:
        raise  # 凭证校验等已构造的 4xx 错误原样透传,避免被兜底吞成 502
    except Exception as e:  # 兜底:任何异常都透传可读信息,避免 500 Internal Server Error
        raise HTTPException(status_code=502, detail=str(e)[:1000])
    return {"code": 0, "data": result}


@app.get("/spark/logs")
def spark_logs(
    jvm: int = 0, audit: int = 0, x_db_token: Optional[str] = Header(default=None),
    executionMode: str = "thrift",
) -> Dict[str, Any]:
    require_auth(x_db_token)
    engine = _spark_engine(executionMode)
    return {"code": 0, "data": engine.read_logs({"jvm": jvm, "audit": audit})}


# ── 通用 TTL 缓存(线程安全 + 容量上限 + 同 key 只加载一次,防惊群)──────────
class TtlCache:
    """小型 TTL 缓存:进程内 dict,按 key 去重加载,过期惰性淘汰,超上限删最旧。"""

    def __init__(self, ttl: float, max_entries: int = 256, name: str = "cache") -> None:
        self._ttl = float(ttl)
        self._max = max(1, int(max_entries))
        self._name = name
        self._data: Dict[str, Tuple[float, Any]] = {}
        self._pending: Dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def _fresh(self, key: str) -> Tuple[bool, Any]:
        hit = self._data.get(key)
        if hit and time.time() - hit[0] < self._ttl:
            return True, hit[1]
        return False, None

    def get(self, key: str) -> Any:
        with self._lock:
            fresh, value = self._fresh(key)
        return value if fresh else None

    def put(self, key: str, value: Any) -> None:
        with self._lock:
            self._data[key] = (time.time(), value)
            self._prune_locked()

    def _prune_locked(self) -> None:
        if len(self._data) <= self._max:
            return
        now = time.time()
        for key in [k for k, v in self._data.items() if now - v[0] >= self._ttl]:
            self._data.pop(key, None)
        if len(self._data) <= self._max:
            return
        overflow = len(self._data) - self._max
        for key, _ in sorted(self._data.items(), key=lambda kv: kv[1][0])[:overflow]:
            self._data.pop(key, None)

    def get_or_load(self, key: str, loader):
        """返回缓存值;未命中时加载。同 key 并发请求只会打一次下游。"""
        with self._lock:
            fresh, value = self._fresh(key)
            if fresh:
                return value
            waiter = self._pending.get(key)
            owner = waiter is None
            if owner:
                waiter = threading.Event()
                self._pending[key] = waiter
        if not owner:
            waiter.wait(timeout=120)
            with self._lock:
                fresh, value = self._fresh(key)
            if fresh:
                return value
            # 前一个加载失败/超时:自行加载(不重复登记 pending)
            return loader()
        try:
            value = loader()
        finally:
            with self._lock:
                self._pending.pop(key, None)
            waiter.set()
        with self._lock:
            self._data[key] = (time.time(), value)
            self._prune_locked()
        return value


# ── Spark 元数据(表结构树/补全:库→表→字段;只读 SHOW/DESC,TTL 缓存防重复打集群)──
_SPARK_SCHEMA_TTL = 300.0  # 5 分钟
_SPARK_SCHEMA_CACHE = TtlCache(_SPARK_SCHEMA_TTL, max_entries=256, name="spark-schema")


def _spark_schema_cached(key: str, loader) -> list:
    return _SPARK_SCHEMA_CACHE.get_or_load(key, loader)


def _spark_meta_one_col(sql: str, engine) -> list:
    """执行只读元数据 SQL,取每行首个非空字段值(SHOW DATABASES 列名随版本:result/databaseName)"""
    r = engine.execute_schema_sql(sql, 60000)
    out = []
    for x in r.get("rows") or []:
        v = x.get("result") or x.get("databaseName")
        if v is None:
            v = next((cand for cand in x.values() if cand is not None and cand != ""), None)
        if v is not None:
            out.append(v)
    return out


def _spark_table_names(sql: str, engine) -> list:
    """SHOW TABLES IN:列名随版本(tableName/tab_name/name),显式取表名列"""
    r = engine.execute_schema_sql(sql, 60000)
    out = []
    for x in r.get("rows") or []:
        v = x.get("tableName") or x.get("tab_name") or x.get("name")
        if v:
            out.append(v)
    return out


def _spark_ident(name: str) -> str:
    """标识符清洗:剥掉反引号,防注入(SHOW/DESC 拼接前的最后防线)"""
    cleaned = (name or "").replace("`", "")
    if not cleaned:
        raise HTTPException(status_code=400, detail="参数缺失")
    return cleaned


@app.get("/spark/schema/databases")
def spark_schema_databases(
    x_db_token: Optional[str] = Header(default=None), executionMode: str = "thrift"
) -> Dict[str, Any]:
    require_auth(x_db_token)
    engine = _spark_engine(executionMode)
    return {"code": 0, "data": _spark_schema_cached(f"sp:{executionMode}:databases", lambda: _spark_meta_one_col("SHOW DATABASES", engine))}


@app.get("/spark/schema/tables")
def spark_schema_tables(
    db: str = "", x_db_token: Optional[str] = Header(default=None),
    executionMode: str = "thrift",
) -> Dict[str, Any]:
    require_auth(x_db_token)
    engine = _spark_engine(executionMode)
    name = _spark_ident(db)
    key = f"sp:{executionMode}:tables:{name}"
    return {"code": 0, "data": _spark_schema_cached(key, lambda: _spark_table_names(f"SHOW TABLES IN `{name}`", engine))}


@app.get("/spark/schema/fields")
def spark_schema_fields(
    db: str = "", table: str = "", x_db_token: Optional[str] = Header(default=None),
    executionMode: str = "thrift",
) -> Dict[str, Any]:
    require_auth(x_db_token)
    engine = _spark_engine(executionMode)
    dbn, tbl = _spark_ident(db), _spark_ident(table)
    key = f"sp:{executionMode}:fields:{dbn}:{tbl}"

    def load() -> list:
        r = engine.execute_schema_sql(f"DESC `{dbn}`.`{tbl}`", 60000)
        out = []
        for x in r.get("rows") or []:
            n = x.get("col_name") or x.get("name")
            if not n or n.startswith("#"):
                continue  # "# Partition Information" 小节行跳过
            out.append({"name": n, "type": x.get("data_type") or "", "comment": x.get("comment") or ""})
        return out

    return {"code": 0, "data": _spark_schema_cached(key, load)}


# ── 跨库表搜索(库表搜索:mysql 走 information_schema、oracle 走 all_tables;按 (type,host,port) 去重,
#    每实例一条查询;结果 TTL 30s 缓存;Spark 表不做跨库搜索(逐库 SHOW TABLES 集群负载重,展开树即可) ──
_SEARCH_TTL = 30.0
_SEARCH_CACHE = TtlCache(_SEARCH_TTL, max_entries=128, name="table-search")
_SEARCH_LIMIT = 200  # 每实例返回上限
_SEARCH_TOTAL = 300  # 整体截断
# Executor 是进程级且 worker 数固定;请求超时只取消排队任务,正在运行的 DB 调用
# 由驱动 timeout 结束,其数量受 _query_semaphore 限制。
_SEARCH_EXECUTOR = ThreadPoolExecutor(
    max_workers=_SEARCH_WORKERS, thread_name_prefix="db-table-search"
)


def _distinct_search_datasources(datasources):
    """保留各配置数据源的权限与凭证边界;仅合并同一 Impala service。"""
    seen = set()
    distinct = []
    for ds in datasources:
        ent = (
            ds.type,
            ds.host,
            ds.port,
            ds.name if ds.type in ("mysql", "oracle") else ds.service if ds.type == "impala" else "",
        )
        if ent in seen:
            continue
        seen.add(ent)
        distinct.append(ds)
    return distinct


def _search_one_instance(ds: DataSource, keyword: str) -> List[Dict[str, Any]]:
    """搜索单个实例;每个实际连接占用全局查询并发槽。"""
    if not _query_semaphore.acquire(blocking=False):
        raise RuntimeError("database concurrency limit reached")
    conn = None
    try:
        conn = ds.connect(
            connect_timeout=_SEARCH_CONNECT_TIMEOUT,
            query_timeout=max(2, _SEARCH_CONNECT_TIMEOUT + 1),
        )
        cur = conn.cursor()
        try:
            out: List[Dict[str, Any]] = []
            if ds.type == "mysql":
                cur.execute(
                    "SELECT table_schema, table_name FROM information_schema.tables "
                    "WHERE table_name LIKE %s AND table_schema = %s "
                    "AND table_schema NOT IN ('information_schema','mysql','performance_schema','sys') "
                    "ORDER BY table_schema, table_name LIMIT %s",
                    (f"%{keyword}%", ds.service, _SEARCH_LIMIT),
                )
                for schema_name, table_name in cur.fetchall():
                    out.append({"engine": "mysql", "db": ds.name, "schema": schema_name, "table": table_name})
            elif ds.type == "oracle":
                owner_clause, owner_params = _oracle_owner_clause(ds, "", owner_column="owner")
                params = {"search_keyword": f"%{keyword.lower()}%", "search_limit": _SEARCH_LIMIT}
                params.update(owner_params)
                cur.execute(
                    "SELECT owner, table_name FROM all_tables "
                    "WHERE LOWER(table_name) LIKE :search_keyword" + owner_clause +
                    " AND ROWNUM <= :search_limit ORDER BY owner, table_name",
                    params,
                )
                for owner, table_name in cur.fetchall():
                    out.append({"engine": "oracle", "db": ds.name, "owner": owner, "table": table_name})
            else:  # impala
                cur.execute("SHOW TABLES")
                for row in cur.fetchall():
                    table_name = str(row[0])
                    if keyword.lower() in table_name.lower():
                        out.append({"engine": "impala", "db": ds.name, "table": table_name})
                        if len(out) >= _SEARCH_LIMIT:
                            break
            return out
        finally:
            try:
                cur.close()
            except Exception:
                pass
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        _query_semaphore.release()


def _run_bounded_table_search(
    keyword: str,
    datasources=None,
    deadline_seconds: Optional[float] = None,
    executor=None,
) -> Tuple[List[Dict[str, Any]], bool, int, int]:
    """并行扫描不同实例,返回 (hits, complete, successful_count, instance_count)。

    complete 只有所有实例都在 deadline 内成功返回时才为 True;任何失败或超时
    都会阻止调用方把 partial hits 写入 TTL 缓存。等待中的 future 不会阻塞请求退出;
    尚未启动的 future 会被 cancel,正在执行的连接受 driver timeout 和全局并发槽保护。
    """
    targets = _distinct_search_datasources(datasources if datasources is not None else DATASOURCES.values())
    if not targets:
        return [], True, 0, 0
    pool = executor or _SEARCH_EXECUTOR
    timeout = _SEARCH_DEADLINE_SECONDS if deadline_seconds is None else max(0.0, float(deadline_seconds))
    future_by_index = {
        pool.submit(_search_one_instance, ds, keyword): (index, ds)
        for index, ds in enumerate(targets)
    }
    done, pending = wait(future_by_index, timeout=timeout)
    for future in pending:
        future.cancel()

    rows_by_index: Dict[int, List[Dict[str, Any]]] = {}
    success_count = 0
    failed_count = 0
    for future in done:
        index, ds = future_by_index[future]
        try:
            rows_by_index[index] = future.result()
            success_count += 1
        except Exception as exc:
            failed_count += 1
            log.warning(
                "search tables failed for %s(%s:%s): %s",
                ds.type, ds.host, ds.port, str(exc)[:160],
            )
    hits: List[Dict[str, Any]] = []
    for index in sorted(rows_by_index):
        hits.extend(rows_by_index[index])
    complete = len(done) == len(future_by_index) and failed_count == 0
    return hits[:_SEARCH_TOTAL], complete, success_count, len(targets)


@app.get("/search/tables")
def search_tables(keyword: str = "", x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    kw = (keyword or "").strip()
    if not kw:
        raise HTTPException(status_code=400, detail="keyword required")
    if len(kw) > 64:
        raise HTTPException(status_code=400, detail="keyword too long")
    key = f"st:{kw}"
    cached = _SEARCH_CACHE.get(key)
    if cached is not None:
        return {"code": 0, "data": cached}

    if not _search_request_semaphore.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="too many concurrent table searches")
    try:
        # 获取闸门后再查一次缓存,避免两个同词搜索同时 miss 后重复扇出。
        cached = _SEARCH_CACHE.get(key)
        if cached is not None:
            return {"code": 0, "data": cached}
        out, complete, success_count, instance_count = _run_bounded_table_search(kw)
        if complete:
            # 只有全实例成功的完整扫描(包括空结果)才能进入 30s 缓存。
            _SEARCH_CACHE.put(key, out)
        else:
            log.warning(
                "table search partial: keyword=%s completed=%d/%d deadline=%.1fs",
                kw[:64], success_count, instance_count, _SEARCH_DEADLINE_SECONDS,
            )
        return {"code": 0, "data": out}
    finally:
        _search_request_semaphore.release()


@app.get("/spark/status")
def spark_status(
    x_db_token: Optional[str] = Header(default=None), executionMode: str = "thrift"
) -> Dict[str, Any]:
    require_auth(x_db_token)
    engine = _spark_engine(executionMode)
    return {"code": 0, "data": engine.status()}


@app.get("/spark/stages")
def spark_stages(
    x_db_token: Optional[str] = Header(default=None), executionMode: str = "thrift"
) -> Dict[str, Any]:
    require_auth(x_db_token)
    engine = _spark_engine(executionMode)
    stages = engine.stages_status() if executionMode == "session" else {
        "activeJobs": [], "stages": [], "numActiveJobs": 0, "numActiveStages": 0,
    }
    return {"code": 0, "data": stages}


@app.post("/spark/jobs")
def spark_job_submit(
    req: SparkJobSubmitReq,
    x_db_token: Optional[str] = Header(default=None),
    x_spark_write: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """异步提交 spark 任务:立即返回 jobId,后台线程执行(网关 60s 超时安全)。"""
    require_auth(x_db_token)
    _spark_engine(req.executionMode)
    if req.kind != "sql":
        raise HTTPException(status_code=400, detail="Spark 仅支持 SparkSQL")
    sql = req.sql
    if not sql or not str(sql).strip():
        raise HTTPException(status_code=400, detail="sql is required")
    job_id = SPARK_JOBS.submit(str(sql), "sql", req.writeUnlocked, req.timeoutMs,
                               execution_mode=req.executionMode)
    log.info("spark job submitted: %s kind=sql", job_id)
    return {"code": 0, "data": {"jobId": job_id}}


@app.post("/spark/export/jobs")
def spark_export_job_submit(
    req: SparkExportSubmitReq,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """提交只读 Spark SQL 的 HDFS CSV 导出任务。"""
    require_auth(x_db_token)
    _spark_engine(req.executionMode)
    sql = str(req.sql or "")
    if not sql.strip():
        raise HTTPException(status_code=400, detail="sql is required")
    job_id = SPARK_JOBS.submit(sql, "export", False, req.timeoutMs,
                               execution_mode=req.executionMode)
    log.info("spark export job submitted: %s", job_id)
    return {"code": 0, "data": {"jobId": job_id}}


@app.get("/spark/jobs/{job_id}")
def spark_job_status(
    job_id: str, x_db_token: Optional[str] = Header(default=None), executionMode: str = "thrift"
) -> Dict[str, Any]:
    require_auth(x_db_token)
    # The stored job identity owns its mode; a changed caller selection is ignored.
    j = SPARK_JOBS.get(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="job not found: %s" % job_id)
    return {"code": 0, "data": j}


@app.post("/spark/jobs/{job_id}/cancel")
def spark_job_cancel(
    job_id: str, req: Optional[SparkModeReq] = None, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    # Cancellation resolves the adapter from the job, not the optional request mode.
    if not SPARK_JOBS.cancel(job_id):
        raise HTTPException(status_code=404, detail="job not found or already finished: %s" % job_id)
    return {"code": 0, "data": {"cancelled": True}}


@app.post("/spark/cancel")
def spark_cancel(
    req: Optional[SparkModeReq] = None, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    """取消当前正在执行的 Spark SQL (手动停止或超时均走此逻辑)。"""
    require_auth(x_db_token)
    engine = _spark_engine(req.executionMode if req else "thrift")
    cancelled = engine.cancel()
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
        result = FLINK_ENGINE.execute_script(
            req.sql, req.limit or 0, mode=mode, write_unlocked=req.writeUnlocked
        )
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise  # 凭证校验等已构造的 4xx 错误原样透传,避免被兜底吞成 502
    except Exception as e:
        if log:
            log.exception("flink query failed: %.200s", str(e))
        raise HTTPException(status_code=502, detail=str(e)[:1000])
    return {"code": 0, "data": result}


@app.post("/flink/async")
def flink_job_submit(
    req: FlinkQueryReq,
    x_db_token: Optional[str] = Header(default=None),
    x_spark_write: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """异步提交 flink 任务(流式 SELECT/大结果):立即返回 jobId,后台线程执行。

    动机:公司网关固定 60s 读超时,流式 SQL 同步挂起会被掐断 504;
    异步化后提交/查状态/取消均为秒级往返。
    """
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    mode = req.mode if req.mode in ("batch", "stream") else "batch"
    if not req.sql or not str(req.sql).strip():
        raise HTTPException(status_code=400, detail="sql is required")
    job_id = FLINK_JOBS.submit(
        str(req.sql), mode=mode, limit=req.limit or 0,
        write_unlocked=req.writeUnlocked, timeout_ms=req.timeoutMs
    )
    log.info("flink job submitted: %s mode=%s", job_id, mode)
    return {"code": 0, "data": {"jobId": job_id}}


@app.get("/flink/async/{job_id}")
def flink_job_status(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    j = FLINK_JOBS.get(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="job not found: %s" % job_id)
    return {"code": 0, "data": j}


@app.post("/flink/async/{job_id}/cancel")
def flink_job_cancel(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    if not FLINK_JOBS.cancel(job_id):
        raise HTTPException(status_code=404, detail="job not found or already finished: %s" % job_id)
    return {"code": 0, "data": {"cancelled": True}}


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
    jobs = FLINK_ENGINE.list_jobs()
    # 合并 prejob(yarn-per-job)任务到统一流任务列表,使「流任务管理」也能看到并停止
    prejob_jobs = FLINK_PREJOB.list_jobs() if FLINK_PREJOB.enabled else []
    for p in prejob_jobs:
        jobs.append({
            "jobId": p.get("jobId", ""),
            "sql": p.get("name", "") or p.get("appId", "") or p.get("jobId", ""),
            "status": p.get("status", "UNKNOWN"),
            "submittedAt": p.get("submittedAt", ""),
            "mode": "prejob",
        })
    terminal = {"FINISHED", "FAILED", "CANCELED", "KILLED", "SUBMIT_FAILED"}
    jobs.sort(key=lambda x: (x["status"] in terminal, x["submittedAt"]), reverse=False)
    return {"code": 0, "data": {"jobs": jobs}}


@app.get("/flink/jobs/{job_id}")
def flink_job_status(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    # 先查交互会话任务,再查 prejob(yarn-per-job);统一由「流任务管理」查看
    try:
        return {"code": 0, "data": FLINK_ENGINE.job_status(job_id)}
    except KeyError:
        pass
    if FLINK_PREJOB.enabled:
        try:
            return {"code": 0, "data": FLINK_PREJOB.job_status(job_id)}
        except KeyError:
            pass
    raise HTTPException(status_code=404, detail="job not found: %s" % job_id)


@app.post("/flink/jobs/{job_id}/stop")
def flink_job_stop(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    # prejob 任务由 FlinkPreJobManager 停止(yarn application -kill,无需密码)
    if FLINK_PREJOB.enabled:
        try:
            stopped = FLINK_PREJOB.cancel(job_id)
            return {"code": 0, "data": {"stopped": stopped}}
        except KeyError:
            pass
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
    resources: Optional[Dict[str, Any]] = None  # {parallelism, jobManagerMemory, taskManagerMemory, slotsPerTaskManager}


class FlinkPreJobUpdateReq(BaseModel):
    name: Optional[str] = None
    sql: Optional[str] = None
    queue: Optional[str] = None
    resources: Optional[Dict[str, Any]] = None


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
        return {"code": 0, "data": FLINK_PREJOB.submit(
            req.name, req.sql, queue=req.queue, write_unlocked=req.writeUnlocked,
            resources=req.resources,
        )}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise  # 凭证校验等已构造的 4xx 错误原样透传,避免被兜底吞成 502
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


@app.post("/flink/prejob/jobs/{job_id}/disable")
def flink_prejob_disable(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    try:
        ok = FLINK_PREJOB.disable(job_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"code": 0, "data": {"disabled": ok}}


@app.post("/flink/prejob/jobs/{job_id}/enable")
def flink_prejob_enable(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    try:
        job = FLINK_PREJOB.enable(job_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"code": 0, "data": job}


@app.put("/flink/prejob/jobs/{job_id}")
def flink_prejob_update(
    job_id: str, req: FlinkPreJobUpdateReq,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    try:
        job = FLINK_PREJOB.update(
            job_id, name=req.name, sql=req.sql, queue=req.queue, resources=req.resources,
        )
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"code": 0, "data": job}


# ── 脚本存储(我的目录:保存 SQL 脚本)────────────────────────────
# 目录树元数据:scripts/tree.json;文件内容:scripts/files/<id>.sql
# 可用环境变量 DB_SCRIPTS_DIR 覆盖(docker 挂载建议挂此目录)
SCRIPTS_DIR = os.environ.get("DB_SCRIPTS_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
TREE_FILE = os.path.join(SCRIPTS_DIR, "tree.json")
FILES_DIR = os.path.join(SCRIPTS_DIR, "files")
_TABLE_NAME_RE = re.compile(r"^[A-Za-z0-9_$#.\- ]+$")


def _impala_ident(name: str) -> str:
    """Quote a validated Impala identifier, including optional database qualification."""
    if not _TABLE_NAME_RE.match(name or ""):
        raise HTTPException(status_code=400, detail="非法表名")
    parts = [part.strip().strip("`") for part in name.split(".") if part.strip()]
    if not parts:
        raise HTTPException(status_code=400, detail="非法表名")
    return ".".join("`%s`" % part for part in parts)


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
    parent = None
    if req.parentId:
        found = _find_node(my, req.parentId)
        if not found or found[0].get("type") != "dir":
            raise HTTPException(status_code=404, detail="父目录不存在")
        parent = found[0]
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


# ── Oracle 可见 schema 列表与表目录 ────────────────────────────
@app.get("/owners")
def oracle_owners(db: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    ds = get_datasource(db)
    if ds.type != "oracle":
        raise HTTPException(status_code=400, detail="owners only supports Oracle datasources")
    owner_clause, params = _oracle_owner_clause(ds, "")
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, QUERY_TIMEOUT)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"connect failed: {exc}")
    try:
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT owner FROM all_tables WHERE 1=1" + owner_clause + " ORDER BY owner", params)
        owners = [str(row[0]).upper() for row in cur.fetchall() if row and row[0]]
        cur.close()
    except Exception as exc:
        de = _extract_sql_error(exc, ds.type)
        raise HTTPException(status_code=502, detail=f"failed to list Oracle schemas: {de.message}") from exc
    finally:
        conn.close()
    return {"code": 0, "data": owners}


# ── 表目录(库→schema→表→字段,只读元数据)──────────────────────
@app.get("/tables")
def tables(
    db: str,
    schemaName: Optional[str] = None,
    detail: int = 0,
    timeoutMs: int = 0,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """表列表。detail=1 时返回 [{name, comment}](含表注释),否则保持 string[] 兼容旧调用。"""
    require_auth(x_db_token)
    ds = get_datasource(db)
    cache_namespace = _impala_cache_namespace(ds) if ds.type == "impala" else ""
    if ds.type == "impala":
        cached_tables = IMPALA_SCHEMA_CACHE.get_tables(cache_namespace, ds.service)
        if cached_tables is not None:
            items = [{"name": name, "comment": ""} for name in cached_tables]
            return {"code": 0, "data": items if detail else [item["name"] for item in items]}
    q_timeout = _bounded_timeout_seconds(timeoutMs)
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
        elif ds.type == "impala":
            names = IMPALA_ENGINE.list_tables(conn, cache_namespace, ds.service)
            items = [{"name": name, "comment": ""} for name in names]
        else:
            owner_clause, owner_params = _oracle_owner_clause(ds, schemaName, owner_column="t.owner")
            cur.execute(
                "SELECT t.owner, t.table_name, c.comments FROM all_tables t "
                "LEFT JOIN all_tab_comments c ON t.owner = c.owner AND t.table_name = c.table_name "
                "WHERE 1=1" + owner_clause + " ORDER BY t.owner, t.table_name",
                owner_params,
            )
            rows = cur.fetchall()
            items = [{"name": r[1], "owner": str(r[0]).upper(), "comment": str(r[2] or "")} for r in rows]
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
    schemaName: Optional[str] = None,
    detail: int = 0,
    timeoutMs: int = 0,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """字段列表。detail=1 时返回完整元数据 [{name,type,comment,nullable,key}],
    否则保持 [{name,type}] 兼容旧调用。
    注意:Oracle 列默认值 data_default 是 LONG 类型,驱动读取有风险,P0 不取。"""
    require_auth(x_db_token)
    if not _TABLE_NAME_RE.match(table or ""):
        raise HTTPException(status_code=400, detail="非法表名")
    ds = get_datasource(db)
    cache_namespace = _impala_cache_namespace(ds) if ds.type == "impala" else ""
    if ds.type == "impala":
        cached_columns = IMPALA_SCHEMA_CACHE.get_table(cache_namespace, ds.service, table)
        if cached_columns is not None:
            cols = [
                {"name": name, "type": typ, **({"comment": "", "nullable": True, "key": ""} if detail else {})}
                for name, typ in cached_columns.items()
            ]
            return {"code": 0, "data": cols}
    q_timeout = _bounded_timeout_seconds(timeoutMs)
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
        elif ds.type == "impala":
            columns = IMPALA_ENGINE.table_columns(
                conn, cache_namespace, ds.service, table, describe_db=""
            ) or {}
            cols = [
                {"name": name, "type": typ, **({"comment": "", "nullable": True, "key": ""} if detail else {})}
                for name, typ in columns.items()
            ]
        else:
            owner_clause, owner_params = _oracle_owner_clause(ds, schemaName)
            pk_clause, pk_params = _oracle_owner_clause(ds, schemaName, prefix="pk_owner", owner_column="c.owner")
            pk_set = set()
            cur.execute(
                "SELECT cc.owner, cc.column_name FROM all_cons_columns cc "
                "JOIN all_constraints c ON cc.owner = c.owner "
                "AND cc.constraint_name = c.constraint_name AND cc.table_name = c.table_name "
                "WHERE 1=1" + pk_clause + " AND c.constraint_type = 'P' AND c.table_name = :t",
                {**pk_params, "t": table.upper()},
            )
            for r in cur.fetchall():
                pk_set.add((str(r[0]).upper(), str(r[1]).upper()))
            cur.execute(
                "SELECT owner, column_name, data_type, nullable FROM all_tab_columns "
                "WHERE table_name = :t" + owner_clause + " ORDER BY owner, column_id",
                {**owner_params, "t": table.upper()},
            )
            rows = cur.fetchall()
            col_meta = {(str(r[0]).upper(), r[1]): (r[2], r[3]) for r in rows}
            comment_clause, comment_params = _oracle_owner_clause(ds, schemaName, prefix="comment_owner")
            cur.execute(
                "SELECT owner, column_name, comments FROM all_col_comments "
                "WHERE table_name = :t" + comment_clause,
                {**comment_params, "t": table.upper()},
            )
            comments = {(str(r[0]).upper(), r[1]): str(r[2] or "") for r in cur.fetchall()}
            cols = []
            for (owner_name, name), (data_type, nullable) in col_meta.items():
                base = {"name": name, "type": data_type, "owner": owner_name}
                if detail:
                    base.update(
                        {
                            "comment": comments.get((owner_name, name), ""),
                            "nullable": str(nullable).upper() == "Y",
                            "key": "PRI" if (owner_name, str(name).upper()) in pk_set else "",
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
    schemaName: Optional[str] = None,
    timeoutMs: int = 0,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """生成建表 DDL:MySQL SHOW CREATE TABLE / Oracle DBMS_METADATA.GET_DDL。
    需数据源账号具备读取 DDL 的权限(SHOW VIEW / EXECUTE_CATALOG_ROLE),失败返回友好错误。"""
    require_auth(x_db_token)
    if not _TABLE_NAME_RE.match(table or ""):
        raise HTTPException(status_code=400, detail="非法表名")
    ds = get_datasource(db)
    q_timeout = _bounded_timeout_seconds(timeoutMs)
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
        elif ds.type == "impala":
            cur.execute("SHOW CREATE TABLE " + _impala_ident(table))
            rows = cur.fetchall()
            ddl_text = "\n".join(str(r[0]) for r in rows if r and r[0])
        else:
            owner_clause, owner_params = _oracle_owner_clause(ds, schemaName)
            cur.execute(
                "SELECT DISTINCT owner FROM all_tables WHERE table_name = :t" + owner_clause + " ORDER BY owner",
                {**owner_params, "t": table.upper()},
            )
            owners = [str(row[0]).upper() for row in cur.fetchall() if row and row[0]]
            if not owners:
                raise HTTPException(status_code=404, detail=f"Oracle table '{table}' not found")
            if len(owners) > 1:
                raise HTTPException(status_code=409, detail="该表存在于多个 schema，请先选择 owner")
            cur.execute(
                "SELECT DBMS_METADATA.GET_DDL('TABLE', :t, :owner) FROM dual",
                {"t": table.upper(), "owner": owners[0]},
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
    schemaName: Optional[str] = None,
    timeoutMs: int = 30000,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """一次性返回该数据源全部表+字段的扁平元数据(供前端 SQL 编辑器补全)。

    - MySQL/Doris(走 mysql 协议):information_schema.tables/columns;table_schema 取
      连接库(ds.service,与 /tables 的 SHOW TABLE STATUS 一致),而非请求参数 db
    - Oracle:all_tables/all_tab_comments/all_tab_columns 按 schemaName 或 datasource owners allowlist 过滤；显式空 schemaName 表示全部可见范围
    表数 > 800 只返回前 800 张并在 data.truncated=true。"""
    require_auth(x_db_token)
    ds = get_datasource(db)
    cache_namespace = _impala_cache_namespace(ds) if ds.type == "impala" else ""
    if ds.type == "impala":
        cached_names = IMPALA_SCHEMA_CACHE.get_tables(cache_namespace, ds.service)
        if cached_names is not None:
            cached_names = cached_names[:SCHEMA_MAX_TABLES]
            cached_schema = [
                IMPALA_SCHEMA_CACHE.get_table(cache_namespace, ds.service, name)
                for name in cached_names
            ]
            if all(columns is not None for columns in cached_schema):
                tables = [
                    {
                        "name": name,
                        "comment": "",
                        "columns": [{"name": col, "type": typ} for col, typ in (columns or {}).items()],
                    }
                    for name, columns in zip(cached_names, cached_schema)
                ]
                return {
                    "code": 0,
                    "data": {"tables": tables, "truncated": len(IMPALA_SCHEMA_CACHE.get_tables(cache_namespace, ds.service) or []) > SCHEMA_MAX_TABLES, "engine": ds.type},
                }
    q_timeout = _bounded_timeout_seconds(timeoutMs)
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    schema_truncated = False
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
        elif ds.type == "impala":
            table_names = IMPALA_ENGINE.list_tables(conn, cache_namespace, ds.service)
            tables = []
            schema_to_cache = {}
            for name in table_names[:SCHEMA_MAX_TABLES]:
                columns = IMPALA_ENGINE.table_columns(
                    conn, cache_namespace, ds.service, name, persist=False, describe_db=""
                ) or {}
                schema_to_cache[name] = columns
                tables.append({
                    "name": name,
                    "comment": "",
                    "columns": [{"name": col, "type": typ} for col, typ in columns.items()],
                })
            IMPALA_SCHEMA_CACHE.put_schema(cache_namespace, ds.service, schema_to_cache)
            schema_truncated = len(table_names) > SCHEMA_MAX_TABLES
        else:
            owner_clause, owner_params = _oracle_owner_clause(ds, schemaName, owner_column="t.owner")
            cur.execute(
                "SELECT t.owner, t.table_name, c.comments FROM all_tables t "
                "LEFT JOIN all_tab_comments c ON t.owner = c.owner AND t.table_name = c.table_name "
                "WHERE 1=1" + owner_clause + " ORDER BY t.owner, t.table_name",
                owner_params,
            )
            table_rows = cur.fetchall()
            col_clause, col_params = _oracle_owner_clause(ds, schemaName)
            cur.execute(
                "SELECT owner, table_name, column_name, data_type FROM all_tab_columns "
                "WHERE 1=1" + col_clause + " ORDER BY owner, table_name, column_id",
                col_params,
            )
            col_rows = cur.fetchall()
            tables = [
                {"name": str(r[1] or ""), "owner": str(r[0]).upper(), "qualifiedName": "{}.{}".format(str(r[0]).upper(), str(r[1] or "")), "comment": str(r[2] or ""), "columns": []}
                for r in table_rows
            ]
            by_key = {(t["owner"], t["name"]): t for t in tables}
            for c in col_rows:
                t = by_key.get((str(c[0]).upper(), str(c[1] or "")))
                if t is not None:
                    t["columns"].append({"name": str(c[2] or ""), "type": str(c[3] or "")})
        cur.close()
    except HTTPException:
        raise
    except Exception as e:
        de = _extract_sql_error(e, ds.type)
        raise HTTPException(status_code=502, detail=f"failed to load schema: {de.message}")
    finally:
        conn.close()
    truncated = schema_truncated if ds.type == "impala" else len(tables) > SCHEMA_MAX_TABLES
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
    schemaName: Optional[str] = None  # Oracle owner/schema 上下文;必须与数据源配置一致


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
    raw = (req.sql or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="sql is required")
    # _prepare_query 仅保留资源护栏(行数/长度/超时),不做读写限制拦截(已收口网关侧);
    # EXPLAIN 只读,非 SELECT 一律 400
    # (MySQL 5.x 的 EXPLAIN 对 DML 会实际执行,必须在此挡住)。
    ds, clean, is_select, q_timeout, _start = _prepare_query(raw, req.db)
    schema_context = _validate_schema_context(ds, req.schemaName)
    if not is_select:
        raise HTTPException(status_code=400, detail="explain only supports read-only SQL")
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout, schema_name=schema_context)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            try:
                # EXPLAIN FORMAT=JSON:老版本 MySQL 不支持会语法报错 → 回退普通 EXPLAIN
                cur.execute("EXPLAIN FORMAT=JSON " + clean)
                row = cur.fetchone()
                payload = None
                if row:
                    payload = next(iter(row.values())) if hasattr(row, "items") else row[0]
                data = json.loads(payload) if isinstance(payload, str) else payload
                if not isinstance(data, dict):
                    raise ValueError("unexpected explain json shape")
                root = _build_explain_tree(data)
                return {"code": 0, "data": {"kind": "tree", "root": root}}
            except Exception:
                cur.execute("EXPLAIN " + clean)
                rows = cur.fetchall()
                columns = list(rows[0].keys()) if rows else []
                return {"code": 0, "data": {"kind": "table", "columns": columns, "rows": rows}}
        elif ds.type == "impala":
            cur.execute("EXPLAIN " + clean)
            lines = [str(r[0]) for r in cur.fetchall() if r and r[0] is not None]
            return {"code": 0, "data": {"kind": "table", "columns": ["plan"], "rows": [{"plan": line} for line in lines]}}
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
