# 数据源注册表:DataSource 配置/连接(mysql+oracle)、DATASOURCES 加载(原样迁出)

from __future__ import annotations
from typing import Any, Dict
from fastapi import HTTPException
from dbp_core import CONFIG, _HAS_MYSQL, _HAS_ORACLE


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
