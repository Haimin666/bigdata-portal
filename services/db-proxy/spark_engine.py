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
    "SparkFileNotFoundException",
    "File does not exist",
    "path does not exist",
    "NoSuchFileException",
    "readCurrentFileNotFoundError",
    "It is possible the underlying files have been updated",
    "Could not locate",
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


def _infer_stage_status(num: int, done: int, failed: int, active: int, job_statuses: Dict[int, str]) -> str:
    """从 statusTracker 的 stage 计数推断状态(SparkStageInfo 无 status 字段)。

    已完成优先;其次看所属 job 是否失败;再按活跃 task 判断运行中。
    """
    if num > 0 and done >= num:
        return "SUCCEEDED"
    if any(s in ("FAILED", "KILLED") for s in job_statuses.values()):
        return "FAILED"
    if active > 0:
        return "RUNNING"
    if done > 0 or failed > 0:
        return "RUNNING"
    return "PENDING"


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
        self._current_job_group: Optional[str] = None  # 当前执行中的 Spark jobGroup(可取消)
        self._last_job_group: Optional[str] = None  # 最近一次查询的 jobGroup(查询结束后仍可追溯 stage)
        self._last_stage_snapshot: Optional[Dict[str, Any]] = None  # 最近一次有 stage 的快照(会话停止时兜底)
        self._stages_lock = threading.Lock()  # 保护 _last_stage_snapshot 读写
        self._audit_lock = threading.Lock()  # 串行化 audit 文件追加(执行/保活/HTTP 多线程)
        self._cancel_flag = threading.Event()  # 手动/超时取消标记
        self._keepalive_thread: Optional[threading.Thread] = None
        self._log_dir = os.path.join(base_dir, str(cfg.get("logDir", "spark-logs")))
        os.makedirs(self._log_dir, exist_ok=True)
        self._audit_file = os.path.join(self._log_dir, "spark-audit.log")
        self._jvm_log = os.path.join(self._log_dir, "spark-jvm.log")
        self._log4j_props = os.path.join(self._log_dir, "log4j.properties")
        self._write_log4j_props()
    # ── 保活 ──────────────────────────────────────────────────
    def _start_keepalive(self) -> None:
        """后台保活线程:周期执行轻量 SQL(select 1),维持常驻 session 存活。

        解决:公司网关固定 60s 读超时,首次查询冷启动(30~90s)会被网关掐断返回 504;
        且 YARN 空闲回收会停掉 SparkContext。保活后 session 一直就绪,用户查询秒回。
        若 context 已被外部 stop,execute 触发 isStopped 自动重建(见 _ensure_initialized)。
        """
        if self._keepalive_thread is not None:
            return
        interval = int(self.cfg.get("keepaliveInterval", 300))  # 秒;0=关闭
        if interval <= 0:
            return

        def loop() -> None:
            while True:
                time.sleep(interval)
                try:
                    if self._spark is None:
                        continue  # 尚未初始化,等待首次使用
                    # 轻量保活查询;context 死时 collect 抛异常 → 走 except 重建
                    self._spark.sql("select 1").collect()
                    # 成功不写 audit(避免每 5 分钟刷一条噪音);失败才记
                except Exception as e:
                    self._audit("spark keepalive failed: %s" % str(e)[:200])
                    try:
                        if self._spark is not None:
                            self._spark.stop()
                    except Exception:
                        pass
                    self._spark = None  # 下次查询/保活自动重建

        self._keepalive_thread = threading.Thread(target=loop, daemon=True, name="spark-keepalive")
        self._keepalive_thread.start()
        log.info("spark keepalive started (interval=%ss)", interval)

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
            with self._audit_lock:  # 多线程(执行线程/保活线程/HTTP 日志读取)追加不互相截断
                with open(self._audit_file, "a", encoding="utf-8") as f:
                    f.write(line)
        except Exception:
            pass
        log.info("spark audit: %s", msg)

    def _context_stopped(self) -> bool:
        """安全判断 SparkContext 是否已停止。

        pyspark 的 Python SparkContext 没有 isStopped 属性(那是 Java 侧
        `_jsc.sc().isStopped()`),直接访问会抛 AttributeError —— 曾导致
        stages_status/snapshot 常年静默失败。这里走 Java 侧并兜底:
        异常/存疑时按存活处理,不破坏调用方。
        """
        if self._spark is None:
            return True
        try:
            jsc = self._spark.sparkContext._jsc
            if jsc is None:  # Python 侧 stop() 已把 _jsc 置空
                return True
            return bool(jsc.sc().isStopped())
        except Exception:
            return False

    def _ensure_initialized(self) -> None:
        """首次使用时创建 SparkSession(懒加载,避免 db-proxy 启动即依赖 spark)。

        持锁完成初始化:并发请求会阻塞等待首个创建完成(SparkSession 创建耗时较长,
        串行队列语义下多请求同时到达时,后续请求等第一个建完即可复用)。
        """
        with self._init_lock:
            # 兜底:context 被外部 stop(异常中断/YARN 回收)→ 置空走重建,避免
            # "Cannot call methods on a stopped SparkContext" 卡死后续查询
            if self._spark is not None and self._context_stopped():
                log.warning("spark context is stopped, rebuilding session")
                self._spark = None
            if self._spark is not None:
                return
            self._session_state = "starting"
            t0 = time.time()
            try:
                self._spark = self._build_session()
                self._session_state = "idle"
                self._start_keepalive()
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
        # 动态资源:配置了 executorInstances(固定数量)时关闭动态分配,常驻 N 个 executor;
        # 否则保持 dynamicAllocation(后端默认)。
        fixed = int(c.get("executorInstances") or 0)
        if fixed > 0:
            conf.set("spark.dynamicAllocation.enabled", "false")
            conf.set("spark.executor.instances", str(fixed))
        elif c.get("maxExecutors"):
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
    def set_executors(self, n: int) -> None:
        """前端设置固定 executor 数量(方案A):更新 cfg 并停掉当前会话。

        不立即重建:下一次查询(_ensure_initialized)检测到 context 已停止,
        自动用新配置重建 session(冷启动 30~90s,设置后首次查询变慢但无副作用)。
        """
        n = int(n)
        if n < 0:
            raise ValueError("executorInstances 必须 >= 0")
        with self._init_lock:
            prev = self.cfg.get("executorInstances")
            if n == 0:
                # 0=自适应(动态分配):移除固定数量配置,恢复 maxExecutors 动态伸缩
                self.cfg.pop("executorInstances", None)
            else:
                self.cfg["executorInstances"] = n
            if self._spark is not None:
                try:
                    self._spark.stop()
                except Exception:
                    pass
                self._spark = None
                self._session_state = "disabled"
            self._audit("set_executors: %s -> %s, session will rebuild on next query" % (prev, n))

    def status(self) -> Dict[str, Any]:
        st = {
            "enabled": self.enabled,
            "state": self._session_state,
            "config": {
                "master": self.cfg.get("master", "yarn"),
                "appName": self.cfg.get("appName", "db-proxy-spark"),
                "queue": self.cfg.get("queue", "default"),
                "executorInstances": int(self.cfg.get("executorInstances") or 0),
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

    # ── 执行包装:jobGroup + 超时 + 可取消 ─────────────────────
    def _begin_job(self) -> str:
        """为当前请求建立 Spark jobGroup(支持 cancelJobGroup 取消),返回 group id。"""
        gid = "dbp-%d-%d" % (int(time.time() * 1000), threading.get_ident())
        self._current_job_group = gid
        self._cancel_flag.clear()
        # 新查询开始:丢弃上一查询的 stage 快照与 group 回查,避免新旧 stage 在面板上混杂
        with self._stages_lock:
            self._last_stage_snapshot = None
        self._last_job_group = None
        try:
            # interruptOnCancel:取消时中断 driver 侧线程,让 collect() 快速返回而非卡死
            self._spark.sparkContext.setJobGroup(gid, "db-proxy query", interruptOnCancel=True)
        except Exception:
            pass
        return gid

    def _end_job(self) -> None:
        gid = self._current_job_group
        if gid:
            # 查询结束:把该 jobGroup 的 stage 汇总写入 audit 日志并缓存快照(完成后仍可追溯)
            self._snapshot_and_log_stages(gid)
        self._current_job_group = None
        self._last_job_group = gid or self._last_job_group  # 保留供 /spark/stages 查询结束后继续回读
        self._cancel_flag.clear()
        try:
            self._spark.sparkContext.clearJobGroup()
        except Exception:
            pass

    def cancel(self) -> bool:
        """取消当前正在执行的 job(手动停止 / 超时触发)。返回是否确有活动 job。"""
        gid = self._current_job_group
        if not gid or self._spark is None:
            return False
        self._cancel_flag.set()
        try:
            self._spark.sparkContext.cancelJobGroup(gid)
        except Exception:
            pass
        return True

    def _raise_if_cancelled(self) -> None:
        """执行中途(如 collect 返回后)检查是否被取消,抛可读错误。"""
        if self._cancel_flag.is_set():
            raise RuntimeError("查询已停止(用户取消或超时)")

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
            gid = self._begin_job()
            timer: Optional[threading.Timer] = None
            if timeout_ms and timeout_ms > 0:
                # 超时自动取消(Spark cancelJobGroup 中断 collect),避免查询卡死占锁
                timer = threading.Timer(timeout_ms / 1000.0, self.cancel)
                timer.daemon = True
                timer.start()
            try:
                df = self._spark.sql(code)
                # 强制行数上限:Spark 端 limit 惰性,collect 前再取 limit+1 判断截断
                rows = df.limit(limit + 1).collect()
                self._raise_if_cancelled()
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
                    # 超时/手动取消置位时不重试(避免超时后继续执行慢查询)
                    if self._cancel_flag.is_set():
                        self._audit("file-not-found detected but skipped (cancel_flag set)")
                    else:
                        try:
                            refreshed = self._refresh_tables(code)
                            self._audit("auto refresh tables after FileNotFound: %s" % refreshed)
                            df = self._spark.sql(code)
                            rows = df.limit(limit + 1).collect()
                            self._raise_if_cancelled()
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
                if self._cancel_flag.is_set():
                    self._audit("sql CANCELLED (manual or timeout) after %dms" % (int((time.time() - start) * 1000)))
                    raise RuntimeError("查询已停止(用户取消或超时)")
                self._audit("sql FAILED: %s\n%s" % (e, traceback.format_exc()))
                raise RuntimeError(_format_spark_error(e))
            finally:
                if timer:
                    timer.cancel()
                self._end_job()

    # ── PySpark 代码执行(信任模式 + 审计)──────────────────────
    def execute_code(
        self, code: str, timeout_ms: int = 600000, write_unlocked: bool = False
    ) -> Dict[str, Any]:
        if not self.enabled:
            raise RuntimeError("spark engine not enabled (datasources.json spark.enabled=false)")
        self._ensure_initialized()
        if len(code) > int(self.cfg.get("maxSqlLen", 65536)):
            raise ValueError("code too long")
        # 信任模式:任意 Python 等价于全量写权限,必须 allowWrite + writeUnlocked
        if not (bool(self.cfg.get("allowWrite", False)) and write_unlocked):
            raise PermissionError("pyspark execution not allowed (read-only)")
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
            self._begin_job()
            timer: Optional[threading.Timer] = None
            if timeout_ms and timeout_ms > 0:
                timer = threading.Timer(timeout_ms / 1000.0, self.cancel)
                timer.daemon = True
                timer.start()
            try:
                exec(compile(code, "<pyspark>", "exec"), namespace)  # noqa: S102 信任模式
                result = namespace.get("result")
                cost_ms = int((time.time() - start) * 1000)
                if self._cancel_flag.is_set():
                    self._audit("pycode CANCELLED after %dms" % cost_ms)
                    raise RuntimeError("查询已停止(用户取消或超时)")
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
                if self._cancel_flag.is_set():
                    self._audit("pycode CANCELLED (manual or timeout) after %dms" % (int((time.time() - start) * 1000)))
                    raise RuntimeError("查询已停止(用户取消或超时)")
                self._audit("pycode FAILED: %s\n%s" % (e, traceback.format_exc()))
                raise
            finally:
                if timer:
                    timer.cancel()
                self._end_job()

    # ── Stage 进度(statusTracker)──────────────────────────────
    def _snapshot_and_log_stages(self, gid: str) -> None:
        """查询结束时:把该 jobGroup 的 stage 汇总写成 [stage] 行写入 audit 日志,并缓存快照。

        供前端日志面板解析展示(完成后仍可追溯);不依赖 log4j 是否生效。
        [stage] 行格式: [stage] done stage=<id> status=<STATUS> tasks=<done>/<total> name=<name>
        """
        try:
            if self._context_stopped():
                return
            st = self._spark.sparkContext.statusTracker()
            jobs: Dict[int, str] = {}
            stage_ids: set = set()
            for jid in st.getJobIdsForGroup(gid):
                info = st.getJobInfo(jid)
                if info is None:
                    continue
                jobs[jid] = str(getattr(info, "status", "UNKNOWN") or "UNKNOWN")
                stage_ids.update(getattr(info, "stageIds", []) or [])
            stages: List[Dict[str, Any]] = []
            for sid in sorted(stage_ids):
                info = st.getStageInfo(sid)
                if info is None:
                    continue
                num = int(getattr(info, "numTasks", 0) or 0)
                done = int(getattr(info, "numCompletedTasks", 0) or 0)
                failed = int(getattr(info, "numFailedTasks", 0) or 0)
                active = int(getattr(info, "numActiveTasks", 0) or 0)
                name = str(getattr(info, "name", "") or "")
                stages.append(
                    {
                        "stageId": sid,
                        "name": name,
                        "status": _infer_stage_status(num, done, failed, active, jobs),
                        "numTasks": num,
                        "completedTasks": done,
                        "failedTasks": failed,
                    }
                )
            for s in stages:
                self._audit(
                    "[stage] done stage=%d status=%s tasks=%d/%d name=%s"
                    % (s["stageId"], s["status"], s["completedTasks"], s["numTasks"], s["name"])
                )
            if not stages and jobs:
                # 有 job 但取不到 stage 信息:可能 status store 未及时就绪,或已被 retainedStages 回收
                self._audit("[stage] snapshot found %d job(s) but no stage info (store 未就绪/已回收)" % len(jobs))
            if stages:
                with self._stages_lock:
                    self._last_stage_snapshot = {
                        "activeJobs": [],
                        "stages": stages,
                        "numActiveJobs": 0,
                        "numActiveStages": 0,
                    }
        except Exception as e:
            # 错误打进 audit 日志(前端日志面板可见),而非仅 console
            self._audit("[stage] snapshot FAILED: %s" % str(e)[:300])
            log.warning("snapshot/log stages failed: %s", e)

    def stages_status(self) -> Dict[str, Any]:
        """Spark 活跃 job/stage 进度(供前端日志面板展示进度条)。

        依赖 sparkContext.statusTracker()(Spark 2.1+);local 模式 / session 未启动时降级为空。
        查询结束后通过保留最近 jobGroup + 缓存快照,仍能读到已完成 stage(可追溯);
        大查询受 spark.ui.retainedStages(默认 1000)限制,超限的旧 stage 会被回收。
        """
        empty: Dict[str, Any] = {"activeJobs": [], "stages": [], "numActiveJobs": 0, "numActiveStages": 0}
        try:
            if self._context_stopped():
                with self._stages_lock:
                    return self._last_stage_snapshot or dict(empty)
            st = self._spark.sparkContext.statusTracker()
            job_ids: set = set(st.getActiveJobIds())
            # 当前 jobGroup + 最近一次已完成 group:让已完成 stage 在查询结束后仍能读到
            for gid in (self._current_job_group, self._last_job_group):
                if gid:
                    job_ids.update(st.getJobIdsForGroup(gid))
            jobs: List[Dict[str, Any]] = []
            job_status: Dict[int, str] = {}
            stage_ids: set = set()
            for jid in sorted(job_ids):
                info = st.getJobInfo(jid)
                if info is None:
                    continue
                status = str(getattr(info, "status", "UNKNOWN") or "UNKNOWN")
                job_status[jid] = status
                jobs.append(
                    {
                        "jobId": jid,
                        "status": status,
                        "stageIds": list(getattr(info, "stageIds", []) or []),
                    }
                )
                stage_ids.update(getattr(info, "stageIds", []) or [])
            stages: List[Dict[str, Any]] = []
            for sid in sorted(stage_ids):
                info = st.getStageInfo(sid)
                if info is None:
                    continue
                num = int(getattr(info, "numTasks", 0) or 0)
                done = int(getattr(info, "numCompletedTasks", 0) or 0)
                failed = int(getattr(info, "numFailedTasks", 0) or 0)
                active = int(getattr(info, "numActiveTasks", 0) or 0)
                stages.append(
                    {
                        "stageId": sid,
                        "name": str(getattr(info, "name", "") or ""),
                        # SparkStageInfo 无 status 字段,由 task 计数 + 所属 job 状态推断
                        "status": _infer_stage_status(num, done, failed, active, job_status),
                        "numTasks": num,
                        "completedTasks": done,
                        "failedTasks": failed,
                    }
                )
            data: Dict[str, Any] = {
                "activeJobs": jobs,
                "stages": stages,
                "numActiveJobs": len([j for j in jobs if j["status"] == "RUNNING"]),
                "numActiveStages": len([s for s in stages if s["status"] == "RUNNING"]),
            }
            if stages:
                with self._stages_lock:
                    self._last_stage_snapshot = data
            return data
        except Exception as e:  # statusTracker 在部分部署/版本不可用,不影响查询本身
            with self._stages_lock:
                return self._last_stage_snapshot or {"error": str(e), **empty}

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
            prev = int(offsets.get(name, 0))
            if prev < 0:
                prev = 0
            if prev >= size:
                # 无新内容或文件被截断/轮转:位置重置到当前大小
                file_sizes[name] = size
                new_offsets[name] = size
                continue
            try:
                with open(fp, "r", encoding="utf-8", errors="replace") as f:
                    f.seek(prev)
                    chunk = f.read()
                content += chunk
                # 用实际读到的末尾作 offset:文件读取期间可能继续增长,
                # 用读前 getsize 会让 offset 偏小 → 下次重读尾部 → 上一 execution 日志漏进下一个
                end = prev + len(chunk.encode("utf-8"))
                file_sizes[name] = end
                new_offsets[name] = end
            except OSError:
                file_sizes[name] = size
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


# ── 异步任务管理 ─────────────────────────────────────────────
class SparkJobManager:
    """异步任务管理:提交即返回 jobId,后台线程执行,状态可查询/取消。

    动机:公司网关固定 60s 读超时,同步 HTTP 长请求(大查询可能跑数十分钟)
    必然被网关掐断返回 504。异步化后提交/查询/取消都是秒级往返,永不撞超时。
    同一 SparkSession 串行执行(引擎 _lock),多 job 天然排队,state 反映 queued。
    """

    def __init__(self, engine: Any, max_jobs: int = 200, ttl: int = 3600) -> None:
        self._engine = engine
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._seq = 0
        self._max_jobs = max_jobs
        self._ttl = ttl  # 完成后保留秒数

    def submit(self, sql: str, kind: str = "sql", write_unlocked: bool = False, timeout_ms: int = 600000) -> str:
        with self._lock:
            self._seq += 1
            job_id = "spk_%d_%04d" % (int(time.time()), self._seq)
            self._jobs[job_id] = {
                "id": job_id, "state": "queued", "sql": sql, "kind": kind,
                "write_unlocked": write_unlocked, "timeout_ms": timeout_ms,
                "created_at": time.time(), "started_at": None, "finished_at": None,
                "result": None, "error": None,
            }
        threading.Thread(target=self._run, args=(job_id,), daemon=True, name="spark-job-%s" % job_id).start()
        return job_id

    def _run(self, job_id: str) -> None:
        j = self._jobs.get(job_id)
        if not j:
            return
        j["state"] = "running"
        j["started_at"] = time.time()
        try:
            if j["kind"] == "pyspark":
                result = self._engine.execute_code(j["sql"], j["timeout_ms"], j["write_unlocked"])
            else:
                result = self._engine.execute_sql(j["sql"], j["write_unlocked"], j["timeout_ms"])
            j["result"] = result
            j["state"] = "done"
        except Exception as e:
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
                "id": j["id"], "state": j["state"], "sql": j["sql"][:500],
                "kind": j["kind"], "createdAt": j["created_at"],
                "startedAt": j["started_at"], "finishedAt": j["finished_at"],
                "result": j["result"], "error": j["error"],
            }

    def cancel(self, job_id: str) -> bool:
        """取消 queued/running 的 job。取消的是引擎当前执行中的 jobGroup
        (同 session 串行,同一时刻只有一个 job 在 execute,故 cancel 命中正在跑的 job)。"""
        with self._lock:
            j = self._jobs.get(job_id)
            if not j or j["state"] not in ("queued", "running"):
                return False
        try:
            self._engine.cancel()
            return True
        except Exception:
            return False

    def _gc(self) -> None:
        """清理:完成后超 ttl 的旧 job + 超上限时淘汰最旧完成项。"""
        with self._lock:
            now = time.time()
            stale = [
                i for i, j in self._jobs.items()
                if j["state"] in ("done", "failed") and (now - (j["finished_at"] or 0)) > self._ttl
            ]
            for i in stale:
                del self._jobs[i]
            done_ids = [i for i, j in self._jobs.items() if j["state"] in ("done", "failed")]
            overflow = len(done_ids) - self._max_jobs
            if overflow > 0:
                for i in sorted(done_ids, key=lambda x: self._jobs[x]["finished_at"] or 0)[:overflow]:
                    del self._jobs[i]
