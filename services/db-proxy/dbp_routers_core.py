# 路由:/health /dbs /query /jobs(提交/状态/取消) /acl(APIRouter,路径不变)
# 装饰器由 @app.* 改为 @router.*(include_router 挂载,路径与行为零变化)

from __future__ import annotations
import re
import time
import threading
from typing import Any, Dict, Optional
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import JSONResponse
from dbp_audit import _write_audit
from dbp_core import ALLOWED_DBS, ALLOWED_TABLES, AUTH_TOKEN, DB_CONNECT_TIMEOUT, DEFAULT_LIMIT, MAX_CONCURRENT, MAX_LIMIT, MAX_QPS, MAX_SQL_LEN, ORACLE_CLIENT_LIB, QUERY_TIMEOUT, _check_qps, _query_semaphore, check_db_allowed, log, require_auth
from dbp_datasources import DATASOURCES, get_datasource
from dbp_dbaccess import DbError, QueryReq, _execute_query, _prepare_query, _start_oracle_watchdog, fetch
from dbp_engines import FLINK_ENGINE, SPARK_ENGINE
from dbp_sqlguard import check_single_statement, check_tables_allowed

router = APIRouter()


@router.get("/health")
def health() -> Dict[str, Any]:
    return {"code": 0, "msg": "ok"}


@router.get("/dbs")
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
        try:
            # _check_qps 必须在 try 内:限速 429 时也要释放信号量,防槽位永久泄漏
            _check_qps()
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
        timed_out = threading.Event()
        start = time.time()
        try:
            # 异步 job 用更长查询超时(默认 1 小时,可配置),不再受网关 60s 限制
            ds, clean_sql, is_select, limit, q_timeout, start = _prepare_query(j["sql"], j["db"], j["timeout_ms"], source="async")
            conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
            j["conn"] = conn  # 持有连接:取消时 close 中断底层查询(真停止)
            watchdog = None
            if ds.type == "oracle":
                # Oracle 无语句级超时:看门狗超时后强关连接,中断底层查询
                watchdog = _start_oracle_watchdog(conn, q_timeout, timed_out)
            try:
                result = _execute_query(ds, conn, clean_sql, is_select, limit, start)
            finally:
                j["conn"] = None
                timed_out.set()  # 先停看门狗再关连接,防正常关闭被误判为超时
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
            if timed_out.is_set():
                # 看门狗触发:超时失败(与"用户主动取消"区分)
                j["error"] = f"query timed out after {q_timeout}s (oracle connection closed by watchdog)"
                j["state"] = "failed"
            elif j.get("cancel_requested") or (conn is not None and str(e).find("closed") >= 0):
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


@router.post("/query")
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


@router.post("/jobs")
def db_job_submit(
    req: QueryReq,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """异步提交 mysql/oracle 查询:立即返回 jobId,后台执行(网关 60s 超时安全)。"""
    require_auth(x_db_token)
    if not req.sql or not req.sql.strip():
        raise HTTPException(status_code=400, detail="sql is required")
    # 与同步 /query 一致的长度护栏;timeoutMs 设上限,防绕过同步路径的保护
    if len(req.sql) > MAX_SQL_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"SQL too long: {len(req.sql)} > MAX_SQL_LEN({MAX_SQL_LEN})",
        )
    timeout_ms = req.timeoutMs or 3600000
    if timeout_ms > 4 * 3600000 or timeout_ms < 1000:
        raise HTTPException(status_code=400, detail="timeoutMs must be in [1000, 14400000]")
    job_id = DB_JOBS.submit(req.db, req.sql, timeout_ms)
    log.info("db job submitted: %s db=%s", job_id, req.db)
    return {"code": 0, "data": {"jobId": job_id}}


@router.get("/jobs/{job_id}")
def db_job_status(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    j = DB_JOBS.get(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="job not found: %s" % job_id)
    return {"code": 0, "data": j}


@router.post("/jobs/{job_id}/cancel")
def db_job_cancel(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not DB_JOBS.cancel(job_id):
        raise HTTPException(status_code=404, detail="job not found or already finished: %s" % job_id)
    return {"code": 0, "data": {"cancelled": True}}


@router.get("/acl")
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
