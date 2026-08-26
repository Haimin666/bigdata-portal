# 配置常量/日志/资源护栏(并发信号量+QPS)/鉴权与库白名单/SQL 正则(自 main.py 原样迁出)

from __future__ import annotations
import json
import logging
import os
import re
import time
import collections
import threading
from typing import Any, Dict, Optional
from fastapi import HTTPException


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


# 行数上限检测(MySQL/Oracle 通用,匹配前先剥离字符串/注释防误判):
#   LIMIT n / LIMIT offset, count / FETCH FIRST n ROWS / ROWNUM <= n
LIMIT_RE = re.compile(
    r"\b(?:LIMIT\s+(\d+)\s*(?:,\s*(\d+))?|FETCH\s+FIRST\s+(\d+)\s+ROWS|ROWNUM\s*(?:<=|<)\s*(\d+))",
    re.IGNORECASE,
)


# LIMIT 负值/带符号(如 LIMIT -1、LIMIT 5, -1、FETCH FIRST -5、ROWNUM <= -1)无法安全
# 兜底,直接拒绝(避免生成语法错误 SQL 或绕过行数护栏)
INVALID_LIMIT_RE = re.compile(
    r"\b(?:LIMIT\s*[+-]\s*\d+|LIMIT\s+\d+\s*,\s*[+-]\s*\d+|FETCH\s+FIRST\s*[+-]\s*\d+|ROWNUM\s*<=?\s*[+-]\s*\d+)",
    re.IGNORECASE,
)


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


_TABLE_NAME_RE = re.compile(r"^[A-Za-z0-9_$#.\- ]+$")
