# 数据访问:结果规范化/结构化错误/查询准备与执行/Oracle 看门狗/fetch(原样迁出)

from __future__ import annotations
import re
import time
import threading
from typing import Any, Dict, List, Optional
from fastapi import HTTPException
from pydantic import BaseModel
from dbp_audit import _write_audit
from dbp_core import DB_CONNECT_TIMEOUT, LIMIT_RE, QUERY_TIMEOUT
from dbp_datasources import get_datasource
from dbp_sqlguard import READ_ONLY_SQL_RE, _strip_sql_literals, append_row_limit, check_single_statement, check_tables_allowed, enforce_limit


# ── 数据访问 ──────────────────────────────────────────────────
def _safe_scalar(v: Any) -> Any:
    """结果单元规范化:bytes/bytearray(MySQL BLOB、Oracle RAW)按 UTF-8 可读解码,
    避免 FastAPI jsonable_encoder strict 解码导致整条查询 500(与 spark_engine 一致)。"""
    if isinstance(v, (bytes, bytearray)):
        raw = bytes(v)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw.decode("utf-8", errors="replace")
    return v


def _rows_to_dicts(rows: List[Any], description: List[Any]) -> List[Dict[str, Any]]:
    """统一行格式:list[dict],key 为列名。"""
    cols = [d[0].lower() for d in description] if description else []
    return [{cols[i]: _safe_scalar(r[i]) for i in range(len(cols))} for r in rows]


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
        if not LIMIT_RE.search(_strip_sql_literals(clean_sql)):
            clean_sql = append_row_limit(clean_sql, limit, row_mode)
        cur = conn.cursor()
        cur.execute(clean_sql)
        if ds.type == "mysql":
            rows = cur.fetchall()  # DictCursor → list[dict]
            truncated = len(rows) > limit
            rows = rows[:limit]
            # BLOB/二进制列规范化,防 jsonable_encoder strict 解码 500
            rows = [{k: _safe_scalar(v) for k, v in row.items()} for row in rows]
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


def _start_oracle_watchdog(conn: Any, q_timeout: Optional[int], timed_out: threading.Event) -> Optional[threading.Thread]:
    """Oracle 查询超时看门狗:python-oracledb 无语句级超时,超时后强制 close 连接
    中断底层执行(thin 模式 close 断开 socket,执行线程随即抛错;与异步取消同源)。
    非 Oracle 或无超时返回 None;正常路径由调用方在 finally 中 timed_out.set() 停表,
    避免正常关闭被误判为超时。"""
    if q_timeout and q_timeout > 0:
        def _kill() -> None:
            if not timed_out.wait(q_timeout):
                timed_out.set()
                try:
                    conn.close()
                except Exception:
                    pass
        t = threading.Thread(target=_kill, daemon=True, name="oracle-timeout")
        t.start()
        return t
    return None


def fetch(sql: str, db: str, timeout_ms: Optional[int] = None, source: str = "sync") -> Dict[str, Any]:
    """连接并执行 SQL,返回 {columns, rows, costMs, truncated}。
    SELECT 类返回结果集;写语句(INSERT/UPDATE/DELETE)返回受影响行数。
    timeout_ms:覆盖默认查询超时(异步 job 用,大查询可传更长,不撞网关 60s)。
    写语句执行(成功/失败/连接失败)后追加一条审计日志(source='sync'|'async')。"""
    ds, clean_sql, is_select, limit, q_timeout, start = _prepare_query(
        sql, db, timeout_ms, source=source
    )
    timed_out = threading.Event()
    watchdog = None
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        de = _extract_sql_error(e, ds.type)
        if de.error_type == "DatabaseError":
            de = DbError(ds.type, "ConnectError", de.error_code, de.message)
        if not is_select:
            _write_audit(db, ds.type, clean_sql, None, (time.time() - start) * 1000, source)
        raise DbError(ds.type, de.error_type, de.error_code, f"connect failed: {de.message}")
    if ds.type == "oracle":
        watchdog = _start_oracle_watchdog(conn, q_timeout, timed_out)
    try:
        result = _execute_query(ds, conn, clean_sql, is_select, limit, start)
        if not is_select:
            affected = (
                result["rows"][0].get("affected_rows") if result.get("rows") else None
            )
            _write_audit(db, ds.type, clean_sql, affected, result["costMs"], source)
        return result
    except Exception as e:
        # Oracle 看门狗超时触发(连接被强关)→ 归类为查询超时而非执行失败
        if timed_out.is_set():
            if not is_select:
                _write_audit(db, ds.type, clean_sql, None, (time.time() - start) * 1000, source)
            raise DbError(
                ds.type, "TimeoutError", None,
                f"query timed out after {q_timeout}s (oracle connection closed by watchdog)",
            )
        if not is_select:
            _write_audit(db, ds.type, clean_sql, None, (time.time() - start) * 1000, source)
        de = _extract_sql_error(e, ds.type)
        raise DbError(ds.type, de.error_type, de.error_code, f"query failed: {de.message}")
    finally:
        timed_out.set()  # 先停看门狗再关连接,防正常关闭被误判为超时
        try:
            conn.close()
        except Exception:
            pass


# ── 接口 ──────────────────────────────────────────────────────
class QueryReq(BaseModel):
    db: str
    sql: str
    timeoutMs: int = 0  # 异步 job 用(毫秒,0=默认 1 小时);同步 /query 忽略
