# -*- coding: utf-8 -*-
"""PyFlink 引擎(内嵌常驻,连接 YARN Session)。

与 spark_engine.py 同构:db-proxy 进程内常驻 TableEnvironment,
连接已部署的 Flink YARN Session(execution.target=yarn-session),
SQL 查询直接提交到集群,避免 SQL Gateway 那层 REST 的冷启动/卡顿。

支持**流批双模式**:
- 批模式(batch):即席查询,结果秒回,适合查 Paimon/CDC 快照
- 流模式(stream):流式任务,INSERT INTO sink 提交后后台常驻运行,
  可查状态/停止,适合流-流 join、CDC→Kafka/Paimon 管道

支持脚本式执行(与 Flink SQL Client 一致):
  SET 'key' = 'value';
  CREATE CATALOG xxx WITH (...);
  USE CATALOG `xxx`;
  CREATE TABLE ... WITH (connector = 'mysql-cdc' / 'paimon' / 'kafka' ...);
  SELECT ...;
按 `;` 分割逐条执行,最后一条查询语句的结果返回给前端。

要求:
- apache-flink==1.17.2(pip 安装)
- Java 11(PyFlink 1.17 需要;javaHome 配置项指定,不污染系统环境变量)
- HADOOP_CONF_DIR 可访问(连 YARN 用)
- connector jar(paimon / mysql-cdc / kafka 等)通过 pipelineJars 配置加载

配置段(datasources.json -> "flink"):
{
  "enabled": true,
  "javaHome": "/root/whm/jdk/jdk-11.0.32+9",
  "flinkHome": "",                      # 留空自动用 pyflink 自带 1.17.2 运行时
                                        # (覆盖系统遗留的旧 FLINK_HOME,如 /opt/flink-1.10.1)
  "hiveLib": "",                        # CDH hive lib 目录,留空自动探测
                                        # /opt/cloudera/parcels/CDH-*/lib/hive/lib
                                        # (paimon hive catalog 必需)
  "yarnAppId": "application_xxx",          # 常驻 YARN Session 的 application id
  "sessionName": "db-proxy-flink-session",
  "queue": "default",                       # 提交 job 的 YARN 队列(可选)
  "defaultLimit": 1000,
  "maxLimit": 10000,
  "queryTimeout": 300,                      # 查询结果收集超时(秒),防流式源阻塞
  "allowWrite": false,                      # true 才允许 DDL/DML,默认只读
  "pipelineJars": [                         # connector jar,file:// 或绝对路径
    "file:///opt/streamx/flink/flink-1.17.2/lib/paimon-flink-1.17-0.8.2.jar",
    "file:///opt/streamx/flink/flink-1.17.2/lib/flink-sql-connector-mysql-cdc-2.4.2.jar"
  ],
  "connectors": { ... }                     # 连接器注册表,见 flink_connectors.py
}
"""

import glob
import os
import re
import time
import threading
from typing import Any, Dict, List, Optional, Tuple

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


def split_flink_sql(script: str) -> List[str]:
    """按 `;` 分割 Flink SQL 脚本,跳过单引号字符串与注释内的分号。"""
    statements: List[str] = []
    cur: List[str] = []
    in_str = False
    in_line_comment = False
    i, n = 0, len(script)
    while i < n:
        c = script[i]
        nxt = script[i + 1] if i + 1 < n else ""
        if in_line_comment:
            cur.append(c)
            if c == "\n":
                in_line_comment = False
            i += 1
            continue
        if c == "-" and nxt == "-":
            in_line_comment = True
            cur.append(c)
            i += 1
            continue
        if c == "'":
            in_str = not in_str
            cur.append(c)
            i += 1
            continue
        if c == ";" and not in_str:
            s = "".join(cur).strip()
            if s:
                statements.append(s)
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    s = "".join(cur).strip()
    if s:
        statements.append(s)
    return statements


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
        self._t_env_batch = None               # 批环境(即席查询)
        self._t_env_stream = None              # 流环境(流式任务)
        self._jobs: Dict[str, Dict[str, Any]] = {}   # jobId -> 任务信息
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
        self._apply_flink_home()
        self._apply_hive_lib()

    def _apply_hive_lib(self) -> None:
        """进程内把 CDH Hive Metastore client jar 注入 HADOOP_CLASSPATH。

        paimon 'metastore'='hive' 建 catalog 需要 hive-metastore 等类
        (NoClassDefFoundError: org/apache/hadoop/hive/metastore/api/...)。
        pyflink gateway 的 classpath 由 construct_hadoop_classpath() 拼接,
        第一项就是 HADOOP_CLASSPATH 环境变量 —— 注入 CDH hive lib 目录即可,
        仅当前进程生效,不动系统/集群配置。
        """
        hive_lib = str(self.cfg.get("hiveLib", "")).strip()
        if not hive_lib:
            matches = glob.glob("/opt/cloudera/parcels/CDH-*/lib/hive/lib")
            hive_lib = matches[0] if matches else ""
        if not hive_lib or not os.path.isdir(hive_lib):
            if log:
                log.warning("flink hive lib not found, paimon hive catalog may fail: %s",
                            self.cfg.get("hiveLib", "(auto)"))
            return
        cp = hive_lib.rstrip("/") + "/*"   # Java classpath 通配符,展开目录下全部 jar
        existing = os.environ.get("HADOOP_CLASSPATH", "").strip()
        if cp in existing:
            return
        os.environ["HADOOP_CLASSPATH"] = cp + (os.pathsep + existing if existing else "")
        if log:
            log.info("flink HADOOP_CLASSPATH += %s", cp)

    def _apply_flink_home(self) -> None:
        """进程内覆盖 FLINK_HOME/LIB/OPT,强制指向 pyflink 自带 1.17.2 运行时。

        根因:客户机环境遗留 FLINK_HOME=/opt/flink-1.10.1/,pyflink 的
        find_flink_home() 优先信任环境变量 → gateway JVM classpath 全变成
        1.10.1 旧 jar,PythonEnvUtils 解析失败(JavaPackage not callable)。
        这里在创建引擎前覆盖,仅当前进程生效,不动系统/集群环境变量。
        """
        flink_home = str(self.cfg.get("flinkHome", "")).strip()
        if not flink_home:
            try:
                import pyflink
                flink_home = os.path.dirname(os.path.abspath(pyflink.__file__))
            except Exception:
                flink_home = ""
        if not flink_home or not os.path.isdir(flink_home):
            if log:
                log.warning("flink flinkHome not found, keep existing FLINK_HOME=%s",
                            os.environ.get("FLINK_HOME"))
            return
        os.environ["FLINK_HOME"] = flink_home
        for key, sub in (("FLINK_LIB_DIR", "lib"), ("FLINK_OPT_DIR", "opt")):
            d = os.path.join(flink_home, sub)
            if os.path.isdir(d):
                os.environ[key] = d
        if log:
            log.info("flink FLINK_HOME=%s LIB=%s OPT=%s",
                     os.environ.get("FLINK_HOME"),
                     os.environ.get("FLINK_LIB_DIR"),
                     os.environ.get("FLINK_OPT_DIR"))

    def _build_base_config(self):
        """构造连接 YARN Session 的公共 Configuration。"""
        from pyflink.common import Configuration

        config = Configuration()
        config.set_string("execution.target", "yarn-session")
        yarn_app_id = str(self.cfg.get("yarnAppId", "")).strip()
        if yarn_app_id:
            config.set_string("yarn.application.id", yarn_app_id)
        queue = str(self.cfg.get("queue", "")).strip()
        if queue:
            config.set_string("yarn.application.queue", queue)
        # connector jar(paimon / mysql-cdc / kafka ...)
        jars = self.cfg.get("pipelineJars") or []
        if isinstance(jars, str):
            jars = [j for j in jars.replace(";", ",").split(",") if j.strip()]
        if jars:
            jar_list = []
            for j in jars:
                j = j.strip()
                if not j:
                    continue
                if not j.startswith("file:"):
                    j = "file://" + j
                jar_list.append(j)
            config.set_string("pipeline.jars", ";".join(jar_list))
            if log:
                log.info("flink pipeline.jars=%d", len(jar_list))
        return config

    def _ensure_initialized(self, mode: str = "batch") -> None:
        """按模式懒加载 TableEnvironment。mode=batch|stream。"""
        key = "batch" if mode != "stream" else "stream"
        with self._init_lock:
            t_env = self._t_env_batch if key == "batch" else self._t_env_stream
            if t_env is not None:
                return
            self._apply_java()
            self._session_state = "starting"
            t0 = time.time()
            try:
                env = self._build_env(key)
                if key == "batch":
                    self._t_env_batch = env
                else:
                    self._t_env_stream = env
                self._session_state = "idle"
                self._audit(
                    "flink %s session created in %.1fs (yarnAppId=%s)"
                    % (key, time.time() - t0, self.cfg.get("yarnAppId", ""))
                )
            except Exception as e:
                self._session_state = "error"
                self._last_error = "%s: %s" % (type(e).__name__, e)
                raise

    def _build_env(self, mode: str):
        from pyflink.table import EnvironmentSettings, TableEnvironment

        config = self._build_base_config()
        builder = EnvironmentSettings.new_instance().with_configuration(config)
        if mode == "stream":
            builder.in_streaming_mode()
        else:
            builder.in_batch_mode()
        env = TableEnvironment.create(builder.build())
        self._register_default_catalogs(env)
        return env

    def _register_default_catalogs(self, t_env) -> None:
        """自动注册 datasources.json flink.catalogs 里的 catalog,重启不丢。

        根因:CREATE CATALOG 注册在 TableEnvironment 内存态,db-proxy 重启后
        全部丢失,导致 `USE CATALOG xxx` 报 "does not exist"。
        配置示例(flink 段):
          "catalogs": [
            "CREATE CATALOG paimon_hive_store WITH ('type'='paimon', 'metastore'='hive', 'uri'='...', 'warehouse'='hdfs://...')"
          ],
          "defaultCatalog": "paimon_hive_store"
        """
        ddl_list = self.cfg.get("catalogs") or []
        if isinstance(ddl_list, str):
            ddl_list = [ddl_list]
        for ddl in ddl_list:
            ddl = str(ddl).strip()
            if not ddl:
                continue
            try:
                t_env.execute_sql(ddl)
                if log:
                    log.info("flink auto catalog ok: %.100s", ddl)
            except Exception as e:
                if log:
                    log.warning("flink auto catalog failed: %.100s :: %s", ddl, e)
        default_catalog = str(self.cfg.get("defaultCatalog", "")).strip()
        if default_catalog:
            try:
                t_env.use_catalog(default_catalog)
                if log:
                    log.info("flink default catalog set: %s", default_catalog)
            except Exception as e:
                if log:
                    log.warning("flink use default catalog failed: %s :: %s", default_catalog, e)

    def _t_env(self, mode: str):
        return self._t_env_stream if mode == "stream" else self._t_env_batch

    # ── 查询/脚本执行 ─────────────────────────────────────
    def execute_script(self, script: str, limit: int = 0, mode: str = "batch") -> Dict[str, Any]:
        """执行 Flink SQL 脚本(多条语句,`;` 分隔)。

        - SET 'k' = 'v'            → 会话配置
        - USE [CATALOG] `x`        → 切换 catalog / database
        - CREATE CATALOG / TABLE   → DDL(受 allowWrite 控制)
        - SELECT / SHOW / DESC     → 查询,最后一条的结果返回

        mode=batch:即席查询,结果返回;mode=stream:流式执行,
        若含 INSERT INTO 则提交为常驻任务(返回 jobId)。
        """
        self._ensure_initialized(mode)
        with self._lock:
            statements = split_flink_sql(script)
            if not statements:
                raise ValueError("empty sql")
            # 写语句白名单检查(逐条)
            for stmt in statements:
                clean = _clean_sql(stmt)
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
            last_result: Optional[Dict[str, Any]] = None
            submitted_job_id: Optional[str] = None
            try:
                for stmt in statements:
                    res = self._exec_one(stmt, limit, mode)
                    if res is None:
                        continue
                    # 流模式下 INSERT INTO 提交任务 → 返回 job 标记
                    if isinstance(res, dict) and res.get("_jobSubmitted"):
                        submitted_job_id = res["_jobSubmitted"]
                        last_result = res
                    else:
                        last_result = res
                cost_ms = int((time.time() - t0) * 1000)
                if last_result is None:
                    last_result = {
                        "columns": [],
                        "rows": [],
                        "costMs": cost_ms,
                        "truncated": False,
                        "message": "ok (%d statements)" % len(statements),
                    }
                else:
                    last_result["costMs"] = cost_ms
                if submitted_job_id:
                    last_result["jobId"] = submitted_job_id
                    last_result["mode"] = "stream"
                self._audit(
                    "execute_script[%s] ok in %dms (%d stmts) :: %.120s"
                    % (mode, cost_ms, len(statements), _clean_sql(script))
                )
                return last_result
            except Exception as e:
                self._audit("execute_script[%s] failed :: %.120s :: %s" % (mode, _clean_sql(script), e))
                raise
            finally:
                self._current_job_client = None

    def _exec_one(self, stmt: str, limit: int, mode: str) -> Optional[Dict[str, Any]]:
        """执行单条语句。查询类返回结果 dict;SET/USE/DDL 返回 None。"""
        t_env = self._t_env(mode)
        stmt_s = stmt.strip()

        # SET 'key' = 'value'
        m = re.match(r"^SET\s+'([^']+)'\s*=\s*(.+)$", stmt_s, re.IGNORECASE)
        if m:
            key = m.group(1)
            value = m.group(2).strip().strip("'")
            t_env.get_config().set(key, value)
            if log:
                log.info("flink SET %s = %s", key, value)
            return None

        # USE CATALOG `x`
        m = re.match(r"^USE\s+CATALOG\s+`?([\w-]+)`?\s*$", stmt_s, re.IGNORECASE)
        if m:
            t_env.use_catalog(m.group(1))
            return None

        # USE `db`
        m = re.match(r"^USE\s+`?([\w-]+)`?\s*$", stmt_s, re.IGNORECASE)
        if m:
            t_env.use_database(m.group(1))
            return None

        # 查询类
        is_query = bool(re.match(r"^\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN)\b", stmt_s, re.IGNORECASE))

        if is_query:
            result = t_env.execute_sql(stmt_s)
            try:
                self._current_job_client = result.get_job_client()
            except Exception:
                self._current_job_client = None
            columns = _extract_columns_schema(result)
            rows, truncated = self._collect_rows(result, limit, mode)
            return {"columns": columns, "rows": rows, "truncated": truncated}

        # DML:INSERT INTO ...(流模式下提交常驻任务)
        is_dml_insert = bool(re.match(r"^\s*INSERT\s+INTO\b", stmt_s, re.IGNORECASE))
        if is_dml_insert:
            result = t_env.execute_sql(stmt_s)
            job_client = None
            try:
                job_client = result.get_job_client()
            except Exception:
                pass
            if job_client is not None:
                try:
                    job_id = str(job_client.get_job_id())
                except Exception:
                    job_id = "job-" + str(int(time.time() * 1000))
                self._jobs[job_id] = {
                    "jobId": job_id,
                    "sql": _clean_sql(stmt_s)[:200],
                    "status": "SUBMITTED",
                    "mode": mode,
                    "submittedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "job_client": job_client,
                }
                self._current_job_client = job_client
                self._audit("flink stream job submitted: %s :: %.120s" % (job_id, stmt_s))
                return {"_jobSubmitted": job_id, "columns": [], "rows": [], "truncated": False}
            return None

        # 其他 DDL(CREATE / DROP / USE ...)
        result = t_env.execute_sql(stmt_s)
        try:
            self._current_job_client = result.get_job_client()
        except Exception:
            self._current_job_client = None
        return None

    def _collect_rows(self, result, limit: int, mode: str) -> Tuple[List[List[Any]], bool]:
        """收集结果行,带超时与取消(防 CDC/kafka 流式源无限阻塞)。

        流模式下 SELECT 通常也是无限流,超时后 cancel 并返回已收行。
        """
        collected: List[List[Any]] = []
        stop = threading.Event()
        job_client = None
        try:
            job_client = result.get_job_client()
        except Exception:
            pass

        def worker():
            try:
                for row in result.collect():
                    if stop.is_set() or self._cancel_flag.is_set():
                        break
                    collected.append([_fmt_value(v) for v in row])
                    if len(collected) >= limit:
                        break
            except Exception:
                pass  # 超时/取消后 collect 抛错属预期

        t = threading.Thread(target=worker, daemon=True)
        t.start()
        t.join(self._query_timeout)
        truncated = False
        if t.is_alive():
            # 超时:停止收集,尝试取消 job
            truncated = True
            stop.set()
            self._cancel_flag.set()
            if job_client is not None:
                try:
                    job_client.cancel()
                except Exception:
                    pass
            t.join(5)
        if len(collected) >= limit:
            truncated = True
        return collected, truncated

    # ── 流式任务管理 ──────────────────────────────────────
    def submit_stream_job(self, script: str) -> Dict[str, Any]:
        """提交流式任务(脚本执行,INSERT INTO 提交后台常驻)。"""
        result = self.execute_script(script, mode="stream")
        job_id = result.get("jobId")
        if job_id:
            self._refresh_job_status(job_id)
        return result

    def list_jobs(self) -> List[Dict[str, Any]]:
        for job_id in list(self._jobs.keys()):
            self._refresh_job_status(job_id)
        jobs = []
        for job_id, j in self._jobs.items():
            jobs.append({
                "jobId": job_id,
                "sql": j.get("sql", ""),
                "status": j.get("status", "UNKNOWN"),
                "submittedAt": j.get("submittedAt", ""),
                "mode": j.get("mode", "stream"),
            })
        # 状态非终态的排前面
        terminal = {"FINISHED", "FAILED", "CANCELED"}
        jobs.sort(key=lambda x: (x["status"] in terminal, x["submittedAt"]), reverse=False)
        return jobs

    def job_status(self, job_id: str) -> Dict[str, Any]:
        self._refresh_job_status(job_id)
        j = self._jobs.get(job_id)
        if not j:
            raise KeyError("job not found: %s" % job_id)
        return {
            "jobId": job_id,
            "sql": j.get("sql", ""),
            "status": j.get("status", "UNKNOWN"),
            "submittedAt": j.get("submittedAt", ""),
            "mode": j.get("mode", "stream"),
        }

    def stop_job(self, job_id: str) -> bool:
        with self._lock:
            j = self._jobs.get(job_id)
            if not j:
                raise KeyError("job not found: %s" % job_id)
            jc = j.get("job_client")
            if jc is None:
                return False
            try:
                jc.cancel()
                j["status"] = "CANCELLING"
                self._audit("flink stream job cancel requested: %s" % job_id)
                return True
            except Exception as e:
                if log:
                    log.info("flink cancel failed: %s", e)
                return False

    def _refresh_job_status(self, job_id: str) -> None:
        j = self._jobs.get(job_id)
        if not j:
            return
        jc = j.get("job_client")
        if jc is None:
            return
        try:
            status = str(jc.get_job_status())
            j["status"] = status
        except Exception:
            pass

    # ── 兼容 ──────────────────────────────────────────────
    def execute_sql(self, sql: str, limit: int = 0, mode: str = "batch") -> Dict[str, Any]:
        """兼容单条 SQL(内部走脚本解析)。"""
        return self.execute_script(sql, limit, mode=mode)

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
            "batchEnv": self._t_env_batch is not None,
            "streamEnv": self._t_env_stream is not None,
            "activeJobs": len(self._jobs),
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
