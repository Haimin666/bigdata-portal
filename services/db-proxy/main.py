"""db-proxy 服务入口(装配层):FastAPI app 创建 + 路由模块挂载 + 启动。
业务实现见同目录 dbp_*.py(2026-08 自本文件拆分,函数体逐字迁出,行为零变化);
运行方式不变:`python3 main.py`(或 uvicorn main:app)。"""
from __future__ import annotations

from fastapi import FastAPI

import dbp_core
import dbp_engines  # noqa: F401  引擎单例在 import 时初始化(spark/flink 缺省禁用)
import dbp_datasources
from dbp_routers_core import router as core_router
from dbp_routers_spark import router as spark_router
from dbp_routers_flink import router as flink_router
from dbp_routers_scripts import router as scripts_router
from dbp_routers_meta import router as meta_router

app = FastAPI(title="db-proxy", version="2.1.0")
app.include_router(core_router)
app.include_router(spark_router)
app.include_router(flink_router)
app.include_router(scripts_router)
app.include_router(meta_router)

if __name__ == "__main__":
    import uvicorn

    dbp_core.log.info(
        "db-proxy listening on %s:%s (%d datasource(s), auth=%s, oracleThick=%s)",
        dbp_core.LISTEN_HOST,
        dbp_core.LISTEN_PORT,
        len(dbp_datasources.DATASOURCES),
        "on" if dbp_core.AUTH_TOKEN else "off",
        "on" if dbp_core.ORACLE_CLIENT_LIB else "off",
    )
    uvicorn.run(app, host=dbp_core.LISTEN_HOST, port=dbp_core.LISTEN_PORT, log_level="info")
