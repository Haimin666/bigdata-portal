# 路由:/spark/*(config/query/logs/status/stages/jobs/cancel)(APIRouter,路径不变)
# 装饰器由 @app.* 改为 @router.*(include_router 挂载,路径与行为零变化)

from __future__ import annotations
from typing import Any, Dict, Optional
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from dbp_core import log, require_auth
from dbp_engines import SPARK_ENGINE, SPARK_JOBS, _check_spark_write_creds
from dbp_routers_core import query

router = APIRouter()


# ── Spark 引擎(集成:常驻 client session + SQL/PySpark + 日志透传)────
class SparkQueryReq(BaseModel):
    kind: str = "sql"  # "sql" | "pyspark"
    sql: Optional[str] = None
    code: Optional[str] = None
    writeUnlocked: bool = False
    timeoutMs: int = 120000  # 与门户/前端默认 120s 对齐;超时自动 cancelJobGroup 释放锁


class SparkJobSubmitReq(BaseModel):
    sql: str = ""
    code: str = ""  # kind=pyspark 用
    kind: str = "sql"
    writeUnlocked: bool = False
    timeoutMs: int = 600000  # 异步任务默认 10 分钟(大查询可传更久,不撞网关超时)


class SparkConfigReq(BaseModel):
    executorInstances: int = 0  # 0=动态分配(后端 maxExecutors);>0=固定常驻数量


@router.post("/spark/config")
def spark_config(
    req: SparkConfigReq,
    x_db_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """前端设置 Spark executor 数量(方案A):存 cfg + 停会话,下次查询自动重建生效。"""
    require_auth(x_db_token)
    if not SPARK_ENGINE.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    if req.executorInstances != 0 and req.executorInstances not in (5, 10, 15, 20):
        raise HTTPException(status_code=400, detail="executorInstances 仅支持 0/5/10/15/20(0=动态分配)")
    try:
        SPARK_ENGINE.set_executors(req.executorInstances)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    log.info("spark config updated: executorInstances=%s", req.executorInstances)
    return {"code": 0, "data": {"executorInstances": req.executorInstances}}


@router.post("/spark/query")
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
    except HTTPException:
        raise  # 凭证校验等已构造的 4xx 错误原样透传,避免被兜底吞成 502
    except Exception as e:  # 兜底:任何异常都透传可读信息,避免 500 Internal Server Error
        raise HTTPException(status_code=502, detail=str(e)[:1000])
    return {"code": 0, "data": result}


@router.get("/spark/logs")
def spark_logs(
    jvm: int = 0, audit: int = 0, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not SPARK_ENGINE.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    return {"code": 0, "data": SPARK_ENGINE.read_logs({"jvm": jvm, "audit": audit})}


@router.get("/spark/status")
def spark_status(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not SPARK_ENGINE.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    return {"code": 0, "data": SPARK_ENGINE.status()}


@router.get("/spark/stages")
def spark_stages(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not SPARK_ENGINE.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    return {"code": 0, "data": SPARK_ENGINE.stages_status()}


@router.post("/spark/jobs")
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


@router.get("/spark/jobs/{job_id}")
def spark_job_status(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    j = SPARK_JOBS.get(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="job not found: %s" % job_id)
    return {"code": 0, "data": j}


@router.post("/spark/jobs/{job_id}/cancel")
def spark_job_cancel(job_id: str, x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    if not SPARK_JOBS.cancel(job_id):
        raise HTTPException(status_code=404, detail="job not found or already finished: %s" % job_id)
    return {"code": 0, "data": {"cancelled": True}}


@router.post("/spark/cancel")
def spark_cancel(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    """取消当前正在执行的 spark 查询/代码(手动停止或超时均走此逻辑)。"""
    require_auth(x_db_token)
    if not SPARK_ENGINE.enabled:
        raise HTTPException(
            status_code=503, detail="spark engine not enabled (datasources.json spark.enabled=false)"
        )
    cancelled = SPARK_ENGINE.cancel()
    return {"code": 0, "data": {"cancelled": cancelled}}
