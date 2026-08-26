# Spark/Flink 引擎单例与初始化(自 main.py 原样迁出;未装 pyspark 不影响 mysql/oracle)

from __future__ import annotations
import os
import secrets
from typing import Optional
from fastapi import HTTPException
from dbp_core import CONFIG, log

# 引擎模块导入(原 main.py 中的延迟导入,拆分后显式化;未装 pyspark 不影响 mysql/oracle)
from spark_engine import init_engine
from flink_engine import FlinkEngine, _setup_logger as _flink_setup_logger
from flink_connectors import FlinkConnectors, _setup_logger as _flink_conn_setup_logger
from flink_prejob import FlinkPreJobManager, _setup_logger as _flink_prejob_setup_logger


SPARK_CFG = CONFIG.get("spark") or {}


SPARK_BASE_DIR = os.path.dirname(os.path.abspath(__file__))


SPARK_ENGINE = init_engine(SPARK_CFG, SPARK_BASE_DIR)


if SPARK_ENGINE.enabled:
    from spark_engine import SparkJobManager
    SPARK_JOBS = SparkJobManager(SPARK_ENGINE)
    log.info("spark engine enabled (master=%s, queue=%s, allowWrite=%s)",
             SPARK_CFG.get("master"), SPARK_CFG.get("queue"), SPARK_CFG.get("allowWrite"))


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


def _check_spark_write_creds(write_unlocked: bool, req_token: Optional[str]) -> None:
    """写解锁凭证服务端校验(S1):
    writeUnlocked=true 时必须携带与配置一致的 X-Spark-Write 头(共享密钥)。
    **未配置 spark.writeToken 时放行(默认不拦截)** —— 门户权限矩阵仍是第一道
    防线;配置了 token 则强校验,堵死直连 db-proxy 伪造 writeUnlocked。
    """
    if not write_unlocked:
        return
    cfg_token = str(SPARK_CFG.get("writeToken", "") or "")
    if not cfg_token:
        # 未配置共享密钥:门户侧已做权限管控,不额外拦截(用户无需解锁)
        return
    if not req_token or not secrets.compare_digest(cfg_token, req_token):
        raise HTTPException(
            status_code=403, detail="spark write token mismatch (无法自行解锁写权限)"
        )
