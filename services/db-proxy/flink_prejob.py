# -*- coding: utf-8 -*-
"""Flink PreJob 提交服务(yarn-per-job 模式)。

与交互式通道(FlinkEngine,常驻 YARN Session 共享会话)互补:
PreJob 把用户 Flink SQL 脚本包装成 pyflink 提交脚本,通过发行版
`flink run -t yarn-per-job -d -py` 提交为**独立 YARN 作业**,
作业与交互会话完全隔离、互不影响。提供状态查询(YARN REST)、
日志(yarn logs)、停止(yarn application -kill)。

适用场景:正式的 CDC→Paimon/Kafka 管道、批量 SQL 作业;
交互探索请走 /flink/query(共享会话,秒回)。

配置段(datasources.json -> "flink" -> "prejob"):
{
  "enabled": true,
  "flinkHome": "/opt/streamx/flink/flink-1.17.2",   # 发行版 CLI(需含 bin/flink)
  "pythonBin": "/root/whm/py38/bin/python3.8",       # 提交端 python(pyflink)
  "javaHome": "/root/whm/jdk/jdk-11.0.32+9",
  "hadoopConfDir": "/etc/hadoop/conf",
  "queue": "default",                                # 缺省 YARN 队列
  "yarnRmUrl": "http://hadoop-nn-1.bigdata.shiqiao.com:8088",  # 状态查询
  "jobsDir": "flink-prejobs",                        # 脚本+记录持久化目录(相对 db-proxy)
  "maxConcurrent": 5,                                # 同时运行上限
  "submitTimeout": 120,                              # 提交等待秒
  "jars": [...],                                     # connector jar,缺省回退 flink.pipelineJars
  "catalogs": [...]                                  # 自动注册 catalog,缺省回退 flink.catalogs
}

提交脚本是纯 SQL(无 Python UDF)时,executor 不需要 python 环境,
yarn-per-job 的 JobGraph 全 Java,TaskManager 无需 pyarch。
"""

import json
import os
import re
import subprocess
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

log = None  # main.py 注入 logging.getLogger("db-proxy")


def _setup_logger(logger):
    global log
    log = logger


_APP_ID_RE = re.compile(r"application_\d+_\d+")


class FlinkPreJobManager:
    """yarn-per-job 提交器:脚本生成 + flink CLI 提交 + YARN 状态/日志/停止。"""

    def __init__(self, cfg: Dict[str, Any], base_dir: str, fallback: Optional[Dict[str, Any]] = None) -> None:
        self.cfg = cfg or {}
        self.base_dir = base_dir
        self.enabled = bool(self.cfg.get("enabled", False))
        self._lock = threading.Lock()
        self._jobs_dir = os.path.join(base_dir, str(self.cfg.get("jobsDir", "flink-prejobs")))
        os.makedirs(self._jobs_dir, exist_ok=True)
        self._jobs_file = os.path.join(self._jobs_dir, "prejobs.json")
        self._max_concurrent = int(self.cfg.get("maxConcurrent", 5))
        self._submit_timeout = int(self.cfg.get("submitTimeout", 120))
        self._flink_home = str(self.cfg.get("flinkHome", "")).strip()
        self._python_bin = str(self.cfg.get("pythonBin", "")).strip() or "python3"
        self._java_home = str(self.cfg.get("javaHome", "")).strip()
        self._hadoop_conf_dir = str(self.cfg.get("hadoopConfDir", "")).strip() or "/etc/hadoop/conf"
        self._queue = str(self.cfg.get("queue", "")).strip() or "default"
        self._rm_url = str(self.cfg.get("yarnRmUrl", "")).strip().rstrip("/")
        # 写权限:prejob 段优先,回退 flink 段顶层 allowWrite(S2:prejob 必须与交互引擎一致受控)
        self._allow_write = bool(self.cfg.get("allowWrite", (fallback or {}).get("allowWrite", False)))
        # connector jar / catalog:prejob 段优先,回退 flink 段(fallback)
        self._jars = self.cfg.get("jars") or (fallback or {}).get("pipelineJars") or []
        self._catalogs = self.cfg.get("catalogs") or (fallback or {}).get("catalogs") or []

    # ── 持久化 ──────────────────────────────────────────
    def _load_jobs(self) -> Dict[str, Dict[str, Any]]:
        try:
            with open(self._jobs_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _save_jobs(self, jobs: Dict[str, Dict[str, Any]]) -> None:
        tmp = self._jobs_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(jobs, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self._jobs_file)

    # ── 脚本生成 ────────────────────────────────────────
    def _build_script(self, sql: str) -> str:
        from flink_engine import split_flink_sql

        statements = split_flink_sql(sql)
        stmt_lines = ["    tenv.execute_sql(%s)" % repr(s) for s in statements]
        if not stmt_lines:
            raise ValueError("empty sql")

        jar_list = []
        for j in self._jars:
            j = str(j).strip()
            if not j:
                continue
            if not j.startswith("file:"):
                j = "file://" + j
            jar_list.append(j)
        jars_expr = repr(";".join(jar_list))

        cat_lines = []
        for ddl in self._catalogs:
            ddl = str(ddl).strip()
            if ddl:
                cat_lines.append("    tenv.execute_sql(%s)" % repr(ddl))

        script = (
            "# -*- coding: utf-8 -*-\n"
            "# 由 db-proxy FlinkPreJob 服务自动生成(yarn-per-job 提交),勿手改\n"
            "import os\n"
            "\n"
            "os.environ['JAVA_HOME'] = %s\n"
            "os.environ['HADOOP_CONF_DIR'] = %s\n"
            "\n"
            "import pyflink  # noqa: E402\n"
            "_PYFLINK_HOME = os.path.dirname(os.path.abspath(pyflink.__file__))\n"
            "os.environ['FLINK_HOME'] = _PYFLINK_HOME\n"
            "os.environ['FLINK_LIB_DIR'] = os.path.join(_PYFLINK_HOME, 'lib')\n"
            "os.environ['FLINK_OPT_DIR'] = os.path.join(_PYFLINK_HOME, 'opt')\n"
            "\n"
            "from pyflink.common import Configuration  # noqa: E402\n"
            "from pyflink.table import EnvironmentSettings, TableEnvironment  # noqa: E402\n"
            "\n"
            "\n"
            "def main():\n"
            "    config = Configuration()\n"
            "    config.set_string('execution.target', 'yarn-per-job')\n"
            "    config.set_string('pipeline.jars', %s)\n"
            "    settings = EnvironmentSettings.new_instance().in_streaming_mode()"
            ".with_configuration(config).build()\n"
            "    tenv = TableEnvironment.create(settings)\n"
            "%s\n"
            "%s\n"
            "    print('PREJOB_SCRIPT_DONE')\n"
            "\n"
            "\n"
            "if __name__ == '__main__':\n"
            "    main()\n"
        ) % (
            repr(self._java_home),
            repr(self._hadoop_conf_dir),
            jars_expr,
            "\n".join(cat_lines),
            "\n".join(stmt_lines),
        )
        return script

    # ── 提交 ────────────────────────────────────────────
    def submit(self, name: str, sql: str, queue: Optional[str] = None,
               extra_conf: Optional[Dict[str, str]] = None,
               write_unlocked: bool = False,
               resources: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.enabled:
            raise PermissionError("flink prejob disabled (datasources.json flink.prejob.enabled=false)")
        # S2:与交互引擎一致的写判定 —— prejob 提交前逐条检查,受 allowWrite 且需门户解锁(write_unlocked)
        from flink_engine import _clean_sql, is_write_sql, split_flink_sql

        statements = split_flink_sql(sql)
        if not statements:
            raise ValueError("empty sql")
        for stmt in statements:
            if is_write_sql(_clean_sql(stmt)) and not (self._allow_write and write_unlocked):
                raise PermissionError(
                    "flink write is disabled (datasources.json flink.allowWrite=false 或未解锁), "
                    "prejob submit rejected: %s" % _clean_sql(stmt)[:80]
                )
        with self._lock:
            jobs = self._load_jobs()
            running = [j for j in jobs.values()
                       if j.get("status") in ("SUBMITTING", "SUBMITTED", "ACCEPTED", "RUNNING")]
            if len(running) >= self._max_concurrent:
                raise RuntimeError("too many concurrent prejob (max=%d)" % self._max_concurrent)

            job_id = "pj-" + time.strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6]
            script_path = os.path.join(self._jobs_dir, "main_%s.py" % job_id)
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(self._build_script(sql))

            record: Dict[str, Any] = {
                "jobId": job_id,
                "name": name or job_id,
                "sql": sql,
                "appId": "",
                "status": "SUBMITTING",
                "finalStatus": "UNDEFINED",
                "trackingUrl": "",
                "queue": queue or self._queue,
                "resources": resources or {},
                "enabled": True,
                "submittedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                "scriptPath": script_path,
                "error": "",
            }
            jobs[job_id] = record
            self._save_jobs(jobs)

        # 提交放到锁外执行(耗时,避免阻塞其他请求)
        try:
            cmd = self._build_cmd(record)
            if log:
                log.info("prejob submit: %s :: %s", job_id, " ".join(cmd))
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=self._submit_timeout,
                cwd=self.base_dir, env=self._build_env(),
            )
            output = (proc.stdout or "") + "\n" + (proc.stderr or "")
            m = _APP_ID_RE.search(output)
            if m:
                record["appId"] = m.group(0)
                record["status"] = "SUBMITTED"
                record["error"] = ""
            else:
                record["status"] = "SUBMIT_FAILED"
                record["error"] = output[-2000:]
            record["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            self._persist(record)
            return self._public(record, detail=True)
        except Exception as e:
            record["status"] = "SUBMIT_FAILED"
            record["error"] = "%s: %s" % (type(e).__name__, e)
            record["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            self._persist(record)
            if log:
                log.error("prejob submit failed: %s :: %s", job_id, e)
            raise

    def _build_cmd(self, record: Dict[str, Any]) -> List[str]:
        flink_bin = os.path.join(self._flink_home, "bin", "flink")
        if not os.path.exists(flink_bin):
            raise FileNotFoundError("flink CLI not found: %s (prejob.flinkHome)" % flink_bin)
        cmd = [
            flink_bin, "run",
            "-t", "yarn-per-job",
            "-d",
            "-D", "python.client.executable=%s" % self._python_bin,
            "-D", "yarn.application.name=%s" % str(record.get("name", "flink-prejob"))[:100],
            "-yqu", record.get("queue") or self._queue,
        ]
        # 资源配置(parallelism / JM-TM 内存 / slots),缺省给 Flink 默认
        res = record.get("resources") or {}
        parallelism = res.get("parallelism")
        if parallelism:
            cmd += ["-p", str(parallelism)]
            cmd += ["-D", "pipeline.parallelism=%s" % parallelism]
        jm_mem = res.get("jobManagerMemory")
        if jm_mem:
            cmd += ["-D", "jobmanager.memory.process.size=%s" % jm_mem]
        tm_mem = res.get("taskManagerMemory")
        if tm_mem:
            cmd += ["-D", "taskmanager.memory.process.size=%s" % tm_mem]
        slots = res.get("slotsPerTaskManager")
        if slots:
            cmd += ["-D", "taskmanager.numberOfTaskSlots=%s" % slots]
        cmd += ["-py", record.get("scriptPath", "")]
        return cmd

    def _build_env(self) -> Dict[str, str]:
        env = dict(os.environ)
        if self._java_home:
            env["JAVA_HOME"] = self._java_home
            bin_dir = os.path.join(self._java_home, "bin")
            if bin_dir not in env.get("PATH", ""):
                env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
        env["HADOOP_CONF_DIR"] = self._hadoop_conf_dir
        return env

    def _persist(self, record: Dict[str, Any]) -> None:
        with self._lock:
            jobs = self._load_jobs()
            jobs[record["jobId"]] = record
            self._save_jobs(jobs)

    # ── 状态/日志/停止 ──────────────────────────────────
    def list_jobs(self) -> List[Dict[str, Any]]:
        with self._lock:
            jobs = self._load_jobs()
            for r in jobs.values():
                self._refresh(r)
            self._save_jobs(jobs)
        result = [self._public(r) for r in jobs.values()]
        terminal = {"FINISHED", "FAILED", "KILLED", "SUBMIT_FAILED"}
        result.sort(key=lambda x: (x["status"] in terminal, x["submittedAt"]), reverse=False)
        return result

    def job_status(self, job_id: str) -> Dict[str, Any]:
        with self._lock:
            jobs = self._load_jobs()
            r = jobs.get(job_id)
            if not r:
                raise KeyError("prejob not found: %s" % job_id)
            self._refresh(r)
            self._save_jobs(jobs)
            # 不回传 sql(可能含连接串),仅列表字段
            return self._public(r, detail=False)

    def logs(self, job_id: str, tail: int = 200) -> Dict[str, Any]:
        with self._lock:
            jobs = self._load_jobs()
            r = jobs.get(job_id)
            if not r:
                raise KeyError("prejob not found: %s" % job_id)
        app_id = r.get("appId", "")
        if not app_id:
            return {"appId": "", "logs": "", "error": r.get("error", "")}
        try:
            proc = subprocess.run(
                ["yarn", "logs", "-applicationId", app_id],
                capture_output=True, text=True, timeout=30, env=self._build_env(),
            )
            content = (proc.stdout or "") + "\n" + (proc.stderr or "")
            lines = content.splitlines()
            return {"appId": app_id, "logs": "\n".join(lines[-tail:]), "error": ""}
        except Exception as e:
            return {"appId": app_id, "logs": "", "error": "%s: %s" % (type(e).__name__, e)}

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            jobs = self._load_jobs()
            r = jobs.get(job_id)
            if not r:
                raise KeyError("prejob not found: %s" % job_id)
        app_id = r.get("appId", "")
        if not app_id:
            raise RuntimeError("no application id for %s" % job_id)
        try:
            proc = subprocess.run(
                ["yarn", "application", "-kill", app_id],
                capture_output=True, text=True, timeout=30, env=self._build_env(),
            )
            output = (proc.stdout or "") + (proc.stderr or "")
            ok = "Killed application" in output
            if ok:
                r["status"] = "KILLED"
                r["finalStatus"] = "KILLED"
                r["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
                self._persist(r)
            return ok
        except Exception as e:
            raise RuntimeError("%s: %s" % (type(e).__name__, e))

    def disable(self, job_id: str) -> bool:
        """下线:停止当前运行并标记停用(enabled=False)。未运行则仅置标记。"""
        with self._lock:
            jobs = self._load_jobs()
            r = jobs.get(job_id)
            if not r:
                raise KeyError("prejob not found: %s" % job_id)
            r["enabled"] = False
            r["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            self._persist(r)
        try:
            if r.get("appId") and r.get("status") not in (
                "SUBMIT_FAILED", "FINISHED", "FAILED", "KILLED",
            ):
                self.cancel(job_id)
        except Exception as e:
            if log:
                log.warning("prejob disable: stop failed: %s :: %s", job_id, e)
        return True

    def enable(self, job_id: str) -> Dict[str, Any]:
        """上线:按已持久化的 sql/queue/resources 重新提交并标记启用。"""
        with self._lock:
            jobs = self._load_jobs()
            r = jobs.get(job_id)
            if not r:
                raise KeyError("prejob not found: %s" % job_id)
            sql = r.get("sql", "")
            name = r.get("name", job_id)
            queue = r.get("queue", None)
            resources = r.get("resources", {})
        if not sql:
            raise RuntimeError("no sql definition for %s" % job_id)
        return self.submit(
            name, sql, queue=queue, resources=resources, write_unlocked=True,
        )

    def update(self, job_id: str, name: Optional[str] = None,
               sql: Optional[str] = None, queue: Optional[str] = None,
               resources: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """编辑任务定义(sql/name/queue/resources 持久化)。已运行需先下线再上线生效。"""
        with self._lock:
            jobs = self._load_jobs()
            r = jobs.get(job_id)
            if not r:
                raise KeyError("prejob not found: %s" % job_id)
            if name is not None:
                r["name"] = name or r.get("name", "")
            if sql is not None:
                r["sql"] = sql
                # 同步重写脚本文件
                try:
                    with open(r["scriptPath"], "w", encoding="utf-8") as f:
                        f.write(self._build_script(sql))
                except Exception as e:
                    if log:
                        log.error("prejob update: rewrite script failed: %s", e)
            if queue is not None:
                r["queue"] = queue
            if resources is not None:
                r["resources"] = resources
            r["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            self._persist(r)
            return self._public(r, detail=True)

    def _refresh(self, record: Dict[str, Any]) -> None:
        app_id = record.get("appId", "")
        if not app_id or not self._rm_url:
            return
        if record.get("status") in ("SUBMIT_FAILED", "FINISHED", "FAILED", "KILLED"):
            return
        try:
            import urllib.request
            url = "%s/ws/v1/cluster/apps/%s" % (self._rm_url, app_id)
            with urllib.request.urlopen(url, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            app = data.get("app", {})
            record["status"] = str(app.get("state", "UNKNOWN"))
            record["finalStatus"] = str(app.get("finalStatus", "UNDEFINED"))
            record["trackingUrl"] = str(app.get("trackingUrl", ""))
            diag = str(app.get("diagnostics", "") or "")
            if diag:
                record["error"] = diag[-2000:]
            record["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
        except Exception as e:
            if log:
                log.info("prejob refresh failed: %s :: %s", app_id, e)

    def _public(self, r: Dict[str, Any], detail: bool = False) -> Dict[str, Any]:
        out = {
            "jobId": r.get("jobId", ""),
            "name": r.get("name", ""),
            "appId": r.get("appId", ""),
            "status": r.get("status", "UNKNOWN"),
            "finalStatus": r.get("finalStatus", "UNDEFINED"),
            "trackingUrl": r.get("trackingUrl", ""),
            "queue": r.get("queue", ""),
            "resources": r.get("resources", {}),
            "enabled": bool(r.get("enabled", True)),
            "submittedAt": r.get("submittedAt", ""),
            "updatedAt": r.get("updatedAt", ""),
            "error": r.get("error", ""),
        }
        if detail:
            out["sql"] = r.get("sql", "")
        return out

    def status(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "mode": "yarn-per-job",
            "flinkHome": self._flink_home,
            "pythonBin": self._python_bin,
            "queue": self._queue,
            "yarnRmUrl": self._rm_url,
            "maxConcurrent": self._max_concurrent,
            "jobsDir": self._jobs_dir,
        }
