# -*- coding: utf-8 -*-
"""PyFlink 引擎(内嵌常驻,连接 YARN Session)。

与 spark_engine.py 同构:db-proxy 进程内常驻一个 TableEnvironment,
连接已部署的 Flink YARN Session(execution.target=yarn-session),
SQL 查询直接提交到集群,避免 SQL Gateway 那层 REST 的冷启动/卡顿。

要求:
- apache-flink==1.17.2(pip 安装)
- Java 11(PyFlink 1.17 需要;javaHome 配置项指定,不污染系统环境变量)
- HADOOP_CONF_DIR 可访问(连 YARN 用)

配置段(datasources.json -> "flink"):
{
  "enabled": true,
  "javaHome": "/root/whm/jdk/jdk-11.0.32+9",
  "yarnAppId": "application_xxx",          # 常驻 YARN Session 的 application id
  "sessionName": "db-proxy-flink-session",
  "queue": "default",                       # 提交 job 的 YARN 队列(可选)
  "defaultLimit": 1000,
  "maxLimit": 10000,
  "queryTimeout": 300,                      # 结果 collect 超时(秒)
  "allowWrite": false                       # true 才允许 DDL/DML,默认只读
}
"""

import os
import re
import time
import threading
from typing import Any, Dict, List, Optional

from spark_engine import is_write_sql  # 复用 SQL 读写白名单判定

log = None  # main.py 注入 logging.getLogger("db-proxy")


def _setup_logger(logger):
    global log
    log = logger


# ── 工具 ──────────────────────────────────────────────────
def _clean_sql(sql: str) -> str:
    """去注释、去空白,便于读写判定。"""
    s = re.sub(r"--[^\n]*", "", sql)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return s.strip().strip(";").strip()


def _extract_columns_schema(result) -> List[str]:
    """从 TableResult 提取列名。"""
    try:
        return list(result.get_table_schema().get_field_names())
    except Exception:
        return []


def _fmt_value(v):
    """把 pyflink 行值转成可 JSON 序列化的值。"""
    if v is None:
        return None
    if hasattr(v, "isoformat"):  # datetime/date/time
        return v.isoformat()
    if hasattr(v, "to_pylist"):  # Row/RowKind 等
        try:
            return v.to_pylist()
        except Exception:
            pass
    if isinstance(v, (list, tuple)):
        return [_fmt_value(x) for x in v]
    if isinstance(v, dict):
        return {k: _fmt_value(x) for k, x in v.items()}
    return v


class FlinkEngine:
    """懒加载 + 串行执行的 PyFlink 引擎(连接常驻 YARN Session)。"""

    def __init__(self, cfg: Dict[str, Any], base_dir: str) -> None:
        self.cfg = cfg
        self.base_dir = base_dir
        self._lock = threading.Lock()          # 串行:同一时刻只执行一个请求
        self._init_lock = threading.Lock()
        self._t_env = None
        self._session_state = "disabled"       # disabled|starting|idle|error
        self._last_error: Optional[str] = None
        self._current_job_client = None        # 当前执行中的 JobClient(可取消)
        self._cancel_flag = threading.Event()  # 手动/超时取消标记
        self._log_dir = os.path.join(base_dir, str(cfg.get("logDir", "flink-logs")))
        os.makedirs(self._log_dir, exist_ok=True)
        self._audit_file = os.path.join(self._log_dir, "flink-audit.log")
        self._client_log = os.path.join(self._log_dir, "flink-client.log")
        self._default_limit = int(cfg.get("defaultLimit", 1000))
        self._max_limit = int(cfg.get("maxLimit", 10000))
        self._query_timeout = int(cfg.get("queryTimeout", 300))
        self._allow_write = bool(cfg.get("allowWrite", False))

    # ── 内部 ──────────────────────────────────────────────
    def _audit(self, msg: str) -> None:
        line = "%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
        try:
            with open(self._audit_file, "a", encoding="utf-8") as f:
                f.write(line)
        except Exception:
            pass
        if log:
            log.info("flink audit: %s", msg)

    def _apply_java(self) -> None:
        """进程内设置 JAVA_HOME/PATH(仅对当前进程生效,不污染集群环境变量)。"""
        java_home = str(self.cfg.get("javaHome", "")).strip()
        if java_home:
            os.environ["JAVA_HOME"] = java_home
            bin_dir = os.path.join(java_home, "bin")
            if bin_dir not in os.environ.get("PATH", ""):
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
        # HADOOP_CONF_DIR 缺失时用默认,连 YARN 必需
        if not os.environ.get("HADOOP_CONF_DIR"):
            os.environ["HADOOP_CONF_DIR"] = "/etc/hadoop/conf"

    def _ensure_initialized(self) -> None:
        """首次使用时创建 TableEnvironment(懒加载)。

        JAVA_HOME 必须在 import pyflink 之前生效,因此在锁内先设环境再 import。
        """
        with self._init_lock:
            if self._t_env is not None:
                return
            self._apply_java()
            self._session_state = "starting"
            t0 = time.time()
            try:
                self._t_env = self._build_env()
                self._session_state = "idle"
                self._audit(
                    "flink session created in %.1fs (yarnAppId=%s)"
                    % (time.time() - t0, self.cfg.get("yarnAppId", ""))
                )
            except Exception as e:
                self._session_state = "error"
                self._last_error = "%s: %s" % (type(e).__name__, e)
                raise

    def _build_env(self):
        from pyflink.common import Configuration
        from pyflink.table import EnvironmentSettings, TableEnvironment

        config = Configuration()
        # 连接已部署的 YARN Session
        config.set_string("execution.target", "yarn-session")
        yarn_app_id = str(self.cfg.get("yarnAppId", "")).strip()
        if yarn_app_id:
            config.set_string("yarn.application.id", yarn_app_id)
        # 队列(可选)
        queue = str(self.cfg.get("queue", "")).strip()
        if queue:
            config.set_string("yarn.application.queue", queue)

        settings = (
            EnvironmentSettings.new_instance()
            .in_batch_mode()  # 查询引擎用 batch,结果秒回
            .with_configuration(config)
            .build()
        )
        return TableEnvironment.create(settings)

    # ── 查询 ──────────────────────────────────────────────
    def execute_sql(self, sql: str, limit: int = 0) -> Dict[str, Any]:
        """执行 FlinkSQL:SELECT 返回表格;DDL/DML 受 allowWrite 控制。"""
        self._ensure_initialized()
        with self._lock:
            clean = _clean_sql(sql)
            if not clean:
                raise ValueError("empty sql")
            if is_write_sql(clean) and not self._allow_write:
                raise PermissionError(
                    "flink write is disabled (datasources.json flink.allowWrite=false), "
                    "only SELECT/SHOW/DESC/EXPLAIN allowed"
                )
            if limit <= 0:
                limit = self._default_limit
            limit = min(limit, self._max_limit)

            t0 = time.time()
            self._cancel_flag.clear()
            try:
                from pyflink.table import Table
                # SELECT 走 sql_query(有表结果);DDL/DML 走 execute_sql
                if re.match(r"^\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN)\b", clean, re.IGNORECASE):
                    table = self._t_env.sql_query(clean)
                    result = table.execute()
                else:
                    result = self._t_env.execute_sql(clean)

                # 记下 JobClient 供取消
                try:
                    self._current_job_client = result.get_job_client()
                except Exception:
                    self._current_job_client = None

                columns = _extract_columns_schema(result)
                rows: List[List[Any]] = []
                # 读操作才有行;DDL/DML 的 collect 可能为空
                if re.match(r"^\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN)\b", clean, re.IGNORECASE):
                    collected = 0
                    for row in result.collect():
                        if self._cancel_flag.is_set():
                            break
                        if collected >= limit:
                            break
                        rows.append([_fmt_value(v) for v in row])
                        collected += 1

                truncated = collected >= limit
                cost_ms = int((time.time() - t0) * 1000)
                self._audit("execute_sql ok in %dms (rows=%d) :: %.120s" % (cost_ms, len(rows), clean))
                return {
                    "columns": columns,
                    "rows": rows,
                    "costMs": cost_ms,
                    "truncated": truncated,
                }
            except Exception as e:
                self._audit("execute_sql failed :: %.120s :: %s" % (clean, e))
                raise
            finally:
                self._current_job_client = None

    def cancel(self) -> bool:
        """取消当前正在执行的 job(超时/手动停止)。"""
        with self._lock:
            self._cancel_flag.set()
            jc = self._current_job_client
            if jc is not None:
                try:
                    jc.cancel()
                    return True
                except Exception:
                    return False
            return False

    # ── 状态/日志 ─────────────────────────────────────────
    def status(self) -> Dict[str, Any]:
        return {
            "enabled": self.cfg.get("enabled", False),
            "yarnAppId": self.cfg.get("yarnAppId", ""),
            "sessionState": self._session_state,
            "allowWrite": self._allow_write,
            "lastError": self._last_error,
        }

    def read_logs(self, offset: int = 0, size: int = 200) -> Dict[str, Any]:
        """增量读取客户端日志(与 spark 引擎同款语义)。"""
        try:
            with open(self._client_log, "rb") as f:
                f.seek(offset)
                content = f.read(size * 1024).decode("utf-8", "replace")
                total = os.path.getsize(self._client_log)
                return {"content": content, "offset": offset + len(content.encode("utf-8")), "total": total}
        except FileNotFoundError:
            return {"content": "", "offset": offset, "total": 0}
