"""db-proxy Spark 引擎:集成一个 client 模式常驻 SparkSession。

设计目标(与门户自建 Spark 网关对齐):
  - 常驻一个 client 模式 SparkSession(懒加载,首次 /spark/query 才 getOrCreate),
    SQL 与 PySpark 代码共用同一 session,临时视图跨请求保留。
  - 串行执行:同一时刻只跑一个请求(threading.Lock),避免 SparkSession 并发串扰。
  - SQL 写限制:白名单只读(SELECT/SHOW/DESC/EXPLAIN/SET/USE)放行;
    写语句(INSERT/CREATE/DROP/ALTER/TRUNCATE/MSCK 等)需要 allowWrite 且请求带
    writeUnlocked=true(由门户网关在 X-Spark-Token 校验通过后置位)。
  - PySpark 代码:信任模式(用户拍板),执行于 {spark, sc} 命名空间,完整审计日志。
  - 日志透传:log4j 重定向到 spark-jvm.log(独立 JVM 的 driver 日志),
    Python 侧审计写入 spark-audit.log;GET /spark/logs 增量读取两个文件。

配置(datasources.json 顶层 spark 段,缺省 spark 未配置 = 引擎禁用):
  "spark": {
    "enabled": true,
    "master": "yarn",
    "deployMode": "client",
    "appName": "db-proxy-spark",
    "sparkHome": "/opt/spark/spark-3.4.2-bin-hadoop3",
    "driverMemory": "4g",
    "executorMemory": "8g",
    "executorCores": 2,
    "maxExecutors": 15,
    "queue": "default",
    "hiveMetastoreUris": "thrift://hadoop-nn-1.bigdata.shiqiao.com:9083",
    "defaultLimit": 1000,
    "maxLimit": 10000,
    "maxSqlLen": 65536,
    "allowWrite": false,
    "logDir": "spark-logs"
  }
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import traceback
from typing import Any, Dict, List, Optional

log = logging.getLogger("db-proxy.spark")

# ── 只读白名单(与门户网关 isSparkWriteSql 保持一致)────────────
READONLY_KW = re.compile(r"^(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|SET|USE)\b", re.IGNORECASE)
WRITE_KW = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|MSCK|REFRESH|LOAD|OVERWRITE)\b",
    re.IGNORECASE,
)


def _strip_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*|/\*[\s\S]*?\*/", "", sql).strip()


_FILE_NOT_FOUND_MARKS = (
    "FileNotFoundException",
    "File does not exist",
    "readCurrentFileNotFoundError",
    "It is possible the underlying files have been updated",
)


def _is_file_not_found(msg: str) -> bool:
    """判断异常是否为 HDFS 底层文件被重写导致的 SparkFileNotFoundException。"""
    return any(m in msg for m in _FILE_NOT_FOUND_MARKS)


def _format_spark_error(e: BaseException) -> str:
    """把 py4j/Spark 异常压缩成人类可读信息(去掉 Java 堆栈,保留要点)。"""
    msg = str(e)
    # Py4JJavaError / AnalysisException:取第一个冒号后的核心信息 + 行号提示
    m = re.search(r"ParseException[^\n]*|AnalysisException[^\n]*|Table or view not found[^\n]*", msg)
    core = m.group(0) if m else ""
    # 提取 "== SQL ==" 片段(含 caret 提示行)
    sql_hint = ""
    sm = re.search(r"== SQL ==\n.*?(?=\n\s*\n|\Z)", msg, re.S)
    if sm:
        sql_hint = "\n" + "\n".join(sm.group(0).splitlines()[:6])
    if core or sql_hint:
        return (core + sql_hint).strip() or msg[:500]
    return msg[:500]


def _extract_tables(sql: str) -> List[str]:
    """从 SQL 中提取可能涉及的表名(db.table 或 table),用于 REFRESH。

    只做保守提取:匹配 from/join/update/into/table 关键字后跟的标识符,
    忽略注释与字符串字面量(先剥离注释,再匹配)。
    """
    s = re.sub(r"--[^\n]*|/\*[\s\S]*?\*/", "", sql)
    s = re.sub(r"'[^']*'", "''", s)  # 字符串字面量替换为空串
    tables = re.findall(
        r"\b(?:from|join|update|into|table)\s+([`\w]+(?:\.[`\w]+)?)",
        s,
        re.IGNORECASE,
    )
    out = []
    for t in tables:
        t = t.strip("`")
        if t and t.lower() not in ("dual",):
            out.append(t)
    return out


def is_write_sql(sql: str) -> bool:
    """判定 SQL 是否可能为写操作(去注释后):
    - 只读关键字开头且无写关键字 → 只读
    - WITH 前缀且无写关键字 → 只读(CTE)
    - 其余(含 CTE 前缀 DML、CACHE 等)→ 视为写
    """
    s = _strip_comments(sql)
    if not s:
        return False
    # 多语句走私:非末尾分号 → 视为写,拒绝
    semi = s.split(";")
    if len(semi) > 2 or (len(semi) == 2 and semi[1].strip() != ""):
        return True
    if len(semi) == 2:
        s = semi[0].strip()
    if READONLY_KW.match(s):
        return False
    if re.match(r"^WITH\b", s, re.IGNORECASE) and not WRITE_KW.search(s):
        return False
    return True


class SparkEngine:
    """懒加载 + 串行执行的 Spark 引擎。"""

    def __init__(self, cfg: Dict[str, Any], base_dir: str) -> None:
        self.cfg = cfg
        self.base_dir = base_dir
        self._lock = threading.Lock()  # 串行:同一时刻只执行一个请求
        self._init_lock = threading.Lock()
        self._spark = None
        self._session_state = "disabled"  # disabled|starting|idle|error
        self._last_error: Optional[str] = None
        self._log_dir = os.path.join(base_dir, str(cfg.get("logDir", "spark-logs")))
        os.makedirs(self._log_dir, exist_ok=True)
        self._audit_file = os.path.join(self._log_dir, "spark-audit.log")
        self._jvm_log = os.path.join(self._log_dir, "spark-jvm.log")
        self._log4j_props = os.path.join(self._log_dir, "log4j.properties")
        self._write_log4j_props()
    # ── 初始化 ────────────────────────────────────────────────
    def _write_log4j_props(self) -> None:
        """生成 log4j.properties:driver JVM 日志(含 INFO 级)写入 spark-jvm.log。"""
        props = (
            "log4j.rootCategory=INFO, FILE\n"
            "log4j.appender.FILE=org.apache.log4j.RollingFileAppender\n"
            f"log4j.appender.FILE.File={self._jvm_log}\n"
            "log4j.appender.FILE.MaxFileSize=20MB\n"
            "log4j.appender.FILE.MaxBackupIndex=5\n"
            "log4j.appender.FILE.layout=org.apache.log4j.PatternLayout\n"
            "log4j.appender.FILE.layout.ConversionPattern=%d{yyyy-MM-dd HH:mm:ss} %p %c{1}: %m%n\n"
            "log4j.logger.org.apache.spark=INFO\n"
            "log4j.logger.org.apache.hadoop=WARN\n"
            "log4j.logger.org.sparkproject=WARN\n"
        )
        try:
            with open(self._log4j_props, "w", encoding="utf-8") as f:
                f.write(props)
        except Exception as e:  # pragma: no cover
            log.warning("write log4j.properties failed: %s", e)

    def _audit(self, msg: str) -> None:
        line = "%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
        try:
            with open(self._audit_file, "a", encoding="utf-8") as f:
                f.write(line)
        except Exception:
            pass
        log.info("spark audit: %s", msg)

    def _ensure_initialized(self) -> None:
        """首次使用时创建 SparkSession(懒加载,避免 db-proxy 启动即依赖 spark)。

        持锁完成初始化:并发请求会阻塞等待首个创建完成(SparkSession 创建耗时较长,
        串行队列语义下多请求同时到达时,后续请求等第一个建完即可复用)。
        """
        with self._init_lock:
            if self._spark is not None:
                return
            self._session_state = "starting"
            t0 = time.time()
            try:
                self._spark = self._build_session()
                self._session_state = "idle"
                self._audit(
                    "spark session created in %.1fs (appName=%s, master=%s)"
                    % (time.time() - t0, self.cfg.get("appName", "db-proxy-spark"), self.cfg.get("master", "yarn"))
                )
            except Exception as e:
                self._session_state = "error"
                self._last_error = str(e)
                self._audit("spark session create FAILED: %s\n%s" % (e, traceback.format_exc()))
                raise RuntimeError("spark session create failed: %s" % e)

    def _build_session(self):
        # 显式指定 SPARK_HOME:避免 CDH 默认 Spark 2.4 与 pyspark 3.x 的 JVM 不匹配
        # (Spark 2.4 无 PythonUtils.isEncryptionEnabled,getOrCreate 直接失败)
        spark_home = str(self.cfg.get("sparkHome", "")).strip()
        if spark_home:
            os.environ["SPARK_HOME"] = spark_home
            spark_bin = os.path.join(spark_home, "bin")
            if spark_bin not in os.environ.get("PATH", ""):
                os.environ["PATH"] = spark_bin + os.pathsep + os.environ.get("PATH", "")

        from pyspark import SparkConf
        from pyspark.sql import SparkSession

        c = self.cfg
        conf = SparkConf().setAppName(str(c.get("appName", "db-proxy-spark")))
        conf.setMaster(str(c.get("master", "yarn")))
        conf.set("spark.submit.deployMode", str(c.get("deployMode", "client")))
        conf.set("spark.sql.catalogImplementation", str(c.get("catalog", "hive")))
        # 资源参数
        if c.get("driverMemory"):
            conf.set("spark.driver.memory", str(c["driverMemory"]))
        if c.get("executorMemory"):
            conf.set("spark.executor.memory", str(c["executorMemory"]))
        if c.get("executorCores"):
            conf.set("spark.executor.cores", int(c["executorCores"]))
        if c.get("driverCores"):
            conf.set("spark.driver.cores", int(c["driverCores"]))
        # 动态资源
        if c.get("maxExecutors"):
            conf.set("spark.dynamicAllocation.enabled", "true")
            conf.set("spark.dynamicAllocation.minExecutors", str(c.get("minExecutors", 1)))
            conf.set("spark.dynamicAllocation.maxExecutors", str(c["maxExecutors"]))
            conf.set("spark.dynamicAllocation.executorIdleTimeout", str(c.get("executorIdleTimeout", "120s")))
        # 队列
        if c.get("queue"):
            conf.set("spark.yarn.queue", str(c["queue"]))
        # Hive metastore
        if c.get("hiveMetastoreUris"):
            conf.set("spark.hadoop.hive.metastore.uris", str(c["hiveMetastoreUris"]))
        # 其他自定义 spark conf(sparkConf 对象:key -> value)
        for k, v in (c.get("sparkConf") or {}).items():
            conf.set(str(k), str(v))
        # driver 日志落盘:log4j 指向生成的配置文件
        conf.set(
            "spark.driver.extraJavaOptions",
            "-Dlog4j.configuration=file:%s" % self._log4j_props,
        )
        spark = SparkSession.builder.config(conf=conf).enableHiveSupport().getOrCreate()
        spark.sparkContext.setLogLevel("INFO")
        return spark

    # ── 状态 ──────────────────────────────────────────────────
    def status(self) -> Dict[str, Any]:
        st = {
            "enabled": self.enabled,
            "state": self._session_state,
            "config": {
                "master": self.cfg.get("master", "yarn"),
                "appName": self.cfg.get("appName", "db-proxy-spark"),
                "queue": self.cfg.get("queue", "default"),
                "allowWrite": bool(self.cfg.get("allowWrite", False)),
                "defaultLimit": int(self.cfg.get("defaultLimit", 1000)),
                "maxLimit": int(self.cfg.get("maxLimit", 10000)),
            },
        }
        if self._spark is not None:
            try:
                st["appId"] = self._spark.sparkContext.applicationId
            except Exception:
                pass
            try:
                st["appName"] = self._spark.sparkContext.appName
            except Exception:
                pass
        if self._last_error:
            st["lastError"] = self._last_error
        return st

    @property
    def enabled(self) -> bool:
        return bool(self.cfg.get("enabled", False))

    # ── 值 JSON 化 ────────────────────────────────────────────
    @staticmethod
    def _json_value(v: Any) -> Any:
        from datetime import date, datetime
        from decimal import Decimal

        if v is None or isinstance(v, (bool, int, float, str)):
            return v
        if isinstance(v, datetime):
            return v.strftime("%Y-%m-%d %H:%M:%S")
        if isinstance(v, date):
            return v.strftime("%Y-%m-%d")
        if isinstance(v, Decimal):
            return float(v) if v == v.to_integral_value() else float(v)
        if isinstance(v, (bytes, bytearray)):
            try:
                return v.decode("utf-8", errors="replace")
            except Exception:
                return str(v)
        if isinstance(v, dict):
            return {str(k): SparkEngine._json_value(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [SparkEngine._json_value(x) for x in v]
        if hasattr(v, "asDict"):
            return {str(k): SparkEngine._json_value(x) for k, x in v.asDict().items()}
        return str(v)

    # ── SQL 执行 ──────────────────────────────────────────────
    def _refresh_tables(self, sql: str) -> List[str]:
        """对 SQL 中涉及的表执行 REFRESH TABLE(metastore 元数据失效后刷新缓存)。

        表不存在时静默跳过(避免 show/desc 等非表 SQL 抛错)。返回实际刷新列表。
        """
        refreshed: List[str] = []
        catalog = self._spark.catalog
        for t in _extract_tables(sql):
            try:
                if "." in t:
                    db, tbl = t.split(".", 1)
                    catalog.refreshTable(db.strip("`") + "." + tbl.strip("`"))
                else:
                    catalog.refreshTable(t)
                refreshed.append(t)
            except Exception:
                pass
        return refreshed

    def execute_sql(
        self, sql: str, write_unlocked: bool = False, timeout_ms: int = 600000
    ) -> Dict[str, Any]:
        if not self.enabled:
            raise RuntimeError("spark engine not enabled (datasources.json spark.enabled=false)")
        self._ensure_initialized()
        clean = _strip_comments(sql)
        if not clean:
            raise ValueError("empty sql")
        if len(clean) > int(self.cfg.get("maxSqlLen", 65536)):
            raise ValueError("sql too long")
        # 写限制:白名单只读放行;写语句需 allowWrite + writeUnlocked
        if is_write_sql(clean):
            if not (bool(self.cfg.get("allowWrite", False)) and write_unlocked):
                raise PermissionError("write operation not allowed (read-only)")
        limit = int(self.cfg.get("defaultLimit", 1000))
        max_limit = int(self.cfg.get("maxLimit", 10000))
        m = re.search(r"\bLIMIT\s+(\d+)\b", clean, re.IGNORECASE)
        if m:
            limit = int(m.group(1))
        if limit > max_limit:
            limit = max_limit
        # 去掉末尾分号(Spark SQL 解析器不接受)
        code = clean.rstrip(";").strip()

        start = time.time()
        self._audit("sql db=spark sql=%s" % code[:300])
        with self._lock:
            try:
                df = self._spark.sql(code)
                # 强制行数上限:Spark 端 limit 惰性,collect 前再取 limit+1 判断截断
                rows = df.limit(limit + 1).collect()
                truncated = len(rows) > limit
                rows = rows[:limit]
                columns = df.columns
                data = [dict(zip(columns, [self._json_value(r[i]) for i in range(len(columns))])) for r in rows]
                cost_ms = int((time.time() - start) * 1000)
                self._audit("sql done rows=%d cost=%dms" % (len(rows), cost_ms))
                return {
                    "columns": columns,
                    "rows": data,
                    "costMs": cost_ms,
                    "truncated": truncated,
                }
            except Exception as e:
                # 常驻 session 元数据缓存过期:底层 HDFS 文件被重写/覆盖后,
                # Spark 仍按旧文件列表读取 → SparkFileNotFoundException。
                # 自动 REFRESH 涉及的表并重试一次,规避"REFRESH TABLE"手动操作。
                msg = str(e)
                if _is_file_not_found(msg):
                    try:
                        refreshed = self._refresh_tables(code)
                        self._audit("auto refresh tables after FileNotFound: %s" % refreshed)
                        df = self._spark.sql(code)
                        rows = df.limit(limit + 1).collect()
                        truncated = len(rows) > limit
                        rows = rows[:limit]
                        columns = df.columns
                        data = [dict(zip(columns, [self._json_value(r[i]) for i in range(len(columns))])) for r in rows]
                        cost_ms = int((time.time() - start) * 1000)
                        self._audit("sql retry OK rows=%d cost=%dms" % (len(rows), cost_ms))
                        return {
                            "columns": columns,
                            "rows": data,
                            "costMs": cost_ms,
                            "truncated": truncated,
                        }
                    except Exception as e2:
                        self._audit("sql retry FAILED after refresh: %s" % e2)
                        raise RuntimeError(_format_spark_error(e2))
                self._audit("sql FAILED: %s\n%s" % (e, traceback.format_exc()))
                raise RuntimeError(_format_spark_error(e))

    # ── PySpark 代码执行(信任模式 + 审计)──────────────────────
    def execute_code(self, code: str, timeout_ms: int = 600000) -> Dict[str, Any]:
        if not self.enabled:
            raise RuntimeError("spark engine not enabled (datasources.json spark.enabled=false)")
        self._ensure_initialized()
        if len(code) > int(self.cfg.get("maxSqlLen", 65536)):
            raise ValueError("code too long")
        start = time.time()
        self._audit("pycode >>>\n%s" % code[:2000])
        # 信任模式:执行于受限命名空间,提供 spark/sc;约定 result 变量承载结果
        namespace: Dict[str, Any] = {"spark": self._spark, "sc": self._spark.sparkContext}
        captured: List[str] = []

        def _print(*args, **kwargs):
            captured.append(" ".join(str(a) for a in args))

        namespace["print"] = _print
        namespace["show"] = _print

        with self._lock:
            try:
                exec(compile(code, "<pyspark>", "exec"), namespace)  # noqa: S102 信任模式
                result = namespace.get("result")
                cost_ms = int((time.time() - start) * 1000)
                if result is not None:
                    # DataFrame → 表格
                    if hasattr(result, "columns") and hasattr(result, "collect"):
                        rows = result.collect()
                        columns = result.columns
                        data = [
                            dict(zip(columns, [self._json_value(r[i]) for i in range(len(columns))]))
                            for r in rows
                        ]
                        out: Dict[str, Any] = {"columns": columns, "rows": data, "truncated": False}
                    elif isinstance(result, (list, tuple)) and result and isinstance(result[0], dict):
                        columns = list(result[0].keys())
                        out = {"columns": columns, "rows": result, "truncated": False}
                    else:
                        out = {"columns": ["result"], "rows": [{"result": self._json_value(result)}], "truncated": False}
                else:
                    out = {
                        "columns": ["stdout"],
                        "rows": [{"stdout": line} for line in captured] or [{"stdout": "(no output)"}],
                        "truncated": False,
                    }
                out["costMs"] = cost_ms
                self._audit("pycode done cost=%dms result=%s" % (cost_ms, str(out.get("columns"))))
                return out
            except Exception as e:
                self._audit("pycode FAILED: %s\n%s" % (e, traceback.format_exc()))
                raise

    # ── 日志透传 ──────────────────────────────────────────────
    def read_logs(self, offsets: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
        """增量读取 spark 日志:按文件各自记录读取位置,返回各文件新增内容。

        offsets: { "jvm": 上次读取的 jvm 文件字节数, "audit": 上次读取的 audit 字节数 }
        返回 { content, offsets: 新的读取位置, files: 各文件当前大小 }。
        per-file offset 避免合并 offset 在文件追加后漂移导致漏读。
        """
        offsets = offsets or {}
        files = {
            "jvm": self._jvm_log,
            "audit": self._audit_file,
        }
        content = ""
        new_offsets: Dict[str, int] = {}
        file_sizes: Dict[str, int] = {}
        for name, fp in files.items():
            try:
                size = os.path.getsize(fp)
            except OSError:
                size = 0
            file_sizes[name] = size
            prev = int(offsets.get(name, 0))
            if prev < 0:
                prev = 0
            if prev >= size:
                new_offsets[name] = size
                continue
            try:
                with open(fp, "r", encoding="utf-8", errors="replace") as f:
                    f.seek(prev)
                    content += f.read()
            except OSError:
                pass
            new_offsets[name] = size
        return {
            "content": content,
            "offsets": new_offsets,
            "files": file_sizes,
        }


# 模块级单例:由 main.py 在启动时用配置初始化
_engine: Optional[SparkEngine] = None


def init_engine(cfg: Optional[Dict[str, Any]], base_dir: str) -> SparkEngine:
    global _engine
    _engine = SparkEngine(cfg or {}, base_dir)
    return _engine


def get_engine() -> SparkEngine:
    if _engine is None:
        raise RuntimeError("spark engine not initialized")
    return _engine
