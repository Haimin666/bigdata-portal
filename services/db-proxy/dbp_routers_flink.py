# 路由:/flink/*(query/async/status/connectors/ddl/jobs/prejob)(APIRouter,路径不变)
# 装饰器由 @app.* 改为 @router.*(include_router 挂载,路径与行为零变化)

from __future__ import annotations
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from dbp_core import log, require_auth
from dbp_engines import FLINK_CFG, FLINK_CONNECTORS, FLINK_ENGINE, FLINK_JOBS, FLINK_PREJOB, _check_spark_write_creds
from dbp_routers_core import query
from dbp_routers_meta import ddl, fields

router = APIRouter()


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


@router.post("/flink/query")
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
    except HTTPException:
        raise  # 凭证校验等已构造的 4xx 错误原样透传,避免被兜底吞成 502
    except Exception as e:
        if log:
            log.exception("flink query failed: %.200s", str(e))
        raise HTTPException(status_code=502, detail=str(e)[:1000])
    return {"code": 0, "data": result}


@router.post("/flink/async")
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
    _check_spark_write_creds(req.writeUnlocked, x_spark_write)
    if not req.sql or not str(req.sql).strip():
        raise HTTPException(status_code=400, detail="sql is required")
    job_id = FLINK_JOBS.submit(
        str(req.sql), mode=mode, limit=req.limit or 0,
        write_unlocked=req.writeUnlocked, timeout_ms=req.timeoutMs
    )
    log.info("flink job submitted: %s mode=%s", job_id, mode)
    return {"code": 0, "data": {"jobId": job_id}}


@router.get("/flink/async/{job_id}")
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


@router.post("/flink/async/{job_id}/cancel")
def flink_job_cancel(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    if not FLINK_JOBS.cancel(job_id):
        raise HTTPException(status_code=404, detail="job not found or already finished: %s" % job_id)
    return {"code": 0, "data": {"cancelled": True}}


@router.post("/flink/cancel")
def flink_cancel(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    cancelled = FLINK_ENGINE.cancel()
    return {"code": 0, "data": {"cancelled": cancelled}}


@router.get("/flink/status")
def flink_status(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    return {"code": 0, "data": FLINK_ENGINE.status()}


# ── Flink 连接器与 DDL 生成 ───────────────────────────────
@router.get("/flink/connectors")
def flink_connectors(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not FLINK_CFG.get("enabled"):
        raise HTTPException(
            status_code=503, detail="flink engine not enabled (datasources.json flink.enabled=false)"
        )
    return {"code": 0, "data": {"connectors": FLINK_CONNECTORS.list_connectors()}}


class FlinkProbeReq(BaseModel):
    params: Dict[str, Any] = {}


@router.post("/flink/connectors/{conn_name}/probe")
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


@router.post("/flink/ddl/generate")
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
@router.get("/flink/jobs")
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


@router.get("/flink/jobs/{job_id}")
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


@router.post("/flink/jobs/{job_id}/stop")
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


@router.get("/flink/prejob/config")
def flink_prejob_config(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    return {"code": 0, "data": FLINK_PREJOB.status()}


@router.post("/flink/prejob/jobs")
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


@router.get("/flink/prejob/jobs")
def flink_prejob_jobs(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    return {"code": 0, "data": {"jobs": FLINK_PREJOB.list_jobs()}}


@router.get("/flink/prejob/jobs/{job_id}")
def flink_prejob_status(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    try:
        return {"code": 0, "data": FLINK_PREJOB.job_status(job_id)}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/flink/prejob/jobs/{job_id}/logs")
def flink_prejob_logs(job_id: str, tail: int = 200, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    _prejob_guard()
    try:
        return {"code": 0, "data": FLINK_PREJOB.logs(job_id, tail=tail)}
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/flink/prejob/jobs/{job_id}/cancel")
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


@router.post("/flink/prejob/jobs/{job_id}/disable")
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


@router.post("/flink/prejob/jobs/{job_id}/enable")
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


@router.put("/flink/prejob/jobs/{job_id}")
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
