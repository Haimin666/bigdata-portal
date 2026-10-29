"""SQL-only adapter over the historical persistent YARN SparkSession lifecycle."""

from contextlib import contextmanager
import re
import threading
import time
import uuid
from urllib.parse import unquote, urlsplit

from spark_engine import SparkEngine, collect_limited_rows, _format_spark_error
from spark_thrift_engine import _apply_row_limit, _mask_sql


class SparkSessionEngine:
    supports_job_cancellation = True

    def __init__(self, cfg: dict, base_dir: str):
        self.cfg = cfg
        self._engine = SparkEngine(cfg, base_dir)
        self._owner_lock = threading.Lock()
        self._owner_id = None
        self._active = False
        self._pending_cancelled_owners = set()
        self._query_token = None
        self._cancelled = threading.Event()

    @property
    def enabled(self):
        return self._engine.enabled

    def status(self):
        return self._engine.status()

    def stages_status(self):
        return self._engine.stages_status()

    def read_logs(self, offsets=None):
        return self._engine.read_logs(offsets)

    def set_executors(self, n):
        return self._engine.set_executors(n)

    def cancel(self, owner_id=None):
        with self._owner_lock:
            if owner_id is not None and (not self._active or owner_id != self._owner_id):
                self._pending_cancelled_owners.add(owner_id)
                return True
            if not self._active:
                return False
            self._cancelled.set()
            self._engine.cancel()
            return True

    def finish_job(self, owner_id):
        with self._owner_lock:
            self._pending_cancelled_owners.discard(owner_id)

    def _check_cancelled(self):
        if self._cancelled.is_set():
            raise RuntimeError('查询已停止(用户取消或超时)')

    def _validate_sql(self, sql):
        if not self.enabled:
            raise RuntimeError('spark engine not enabled (datasources.json spark.enabled=false)')
        if len(sql) > int(self.cfg.get('maxSqlLen', 65536)):
            raise ValueError('sql too long')
        masked = _mask_sql(sql)
        if not masked.strip():
            raise ValueError('empty sql')
        semicolon = masked.find(';')
        if semicolon >= 0:
            if masked[semicolon + 1:].strip():
                raise ValueError('SparkSession accepts only one SQL statement')
            sql = sql[:semicolon] + sql[semicolon + 1:]
        if not _mask_sql(sql).strip():
            raise ValueError('empty sql')
        return sql

    @contextmanager
    def _query(self, timeout_ms, owner_id, on_start):
        engine = self._engine
        with engine._lock:
            with self._owner_lock:
                self._owner_id = owner_id
                self._active = True
                self._cancelled.clear()
                token = self._query_token = object()
                if owner_id in self._pending_cancelled_owners:
                    self._pending_cancelled_owners.discard(owner_id)
                    self._cancelled.set()
            def cancel_current():
                with self._owner_lock:
                    if self._active and self._query_token is token:
                        self._cancelled.set()
                        engine.cancel()
            timer = None
            begun = False
            if timeout_ms and timeout_ms > 0:
                timer = threading.Timer(timeout_ms / 1000.0, cancel_current)
                timer.daemon = True
                timer.start()
            try:
                self._check_cancelled()
                engine._ensure_initialized()
                self._check_cancelled()
                engine._begin_job()
                begun = True
                if on_start:
                    on_start()
                self._check_cancelled()
                yield engine._spark
                self._check_cancelled()
            except Exception as exc:
                engine._audit('sql FAILED: %s' % exc)
                self._check_cancelled()
                raise RuntimeError(_format_spark_error(exc)) from exc
            finally:
                if timer:
                    timer.cancel()
                if begun:
                    engine._end_job()
                with self._owner_lock:
                    self._active = False
                    self._owner_id = None

    def execute_sql(self, sql, write_unlocked=False, timeout_ms=600000,
                    owner_id=None, on_start=None):
        code = self._validate_sql(sql)
        code, limit, limited = _apply_row_limit(
            code, self.cfg.get('defaultLimit', 1000), self.cfg.get('maxLimit', 500000))
        pushdown = bool(re.match(r'^\s*(SELECT|WITH)\b', _mask_sql(code), re.I))
        start = time.time()
        self._engine._audit('sql db=spark sql=%s' % code[:300])
        with self._query(timeout_ms, owner_id, on_start) as spark:
            df = spark.sql(code)
            rows = collect_limited_rows(df, limit, pushdown=pushdown)
            self._check_cancelled()
            result = {
                'columns': df.columns,
                'rows': [dict(zip(df.columns, [self._engine._json_value(row[i])
                                              for i in range(len(df.columns))]))
                         for row in rows[:limit]],
                'costMs': int((time.time() - start) * 1000),
                'truncated': len(rows) > limit or (limited and len(rows) >= limit),
            }
            self._engine._audit('sql done rows=%d cost=%dms' % (len(result['rows']), result['costMs']))
            return result

    def execute_schema_sql(self, sql, timeout_ms=600000):
        return self.execute_sql(sql, timeout_ms=timeout_ms)

    def export_sql(self, sql, job_id, timeout_ms=7200000, owner_id=None, on_start=None):
        code = self._validate_sql(sql)
        masked = _mask_sql(code)
        if not re.match(r'^\s*(SELECT|WITH)\b', masked, re.I):
            raise ValueError('HDFS export only supports SELECT/WITH queries')
        if re.search(r'\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|LOAD|OVERWRITE|INTO)\b',
                     masked, re.I):
            raise ValueError('HDFS export only supports read-only queries')
        root = str(self.cfg.get('exportPath') or 'hdfs:///tmp/db-proxy-spark-exports').rstrip('/')
        uri = urlsplit(root)
        if (uri.scheme != 'hdfs' or not uri.path.startswith('/') or uri.query or uri.fragment
                or uri.username or uri.password or any(ord(char) < 32 for char in root)
                or '..' in unquote(uri.path).split('/')):
            raise ValueError('spark.exportPath must be a safe absolute HDFS URI')
        safe_job_id = re.sub(r'[^A-Za-z0-9_-]', '_', str(job_id))[:100]
        export_id = '%s_%s' % (safe_job_id, uuid.uuid4().hex)
        final_path = '%s/spark_export_%s' % (root, export_id)
        staging_path = '%s/.staging_spark_export_%s' % (root, export_id)
        start = time.time()
        self._engine._audit('export start job=%s sql=%s path=%s' % (job_id, code[:300], final_path))
        with self._query(timeout_ms, owner_id, on_start) as spark:
            fs = staging = None
            try:
                df = spark.sql(code)
                hadoop_path = spark._jvm.org.apache.hadoop.fs.Path
                staging = hadoop_path(staging_path)
                target = hadoop_path(final_path)
                fs = staging.getFileSystem(spark._jsc.hadoopConfiguration())
                if fs.exists(target) or fs.exists(staging):
                    raise RuntimeError('HDFS export path already exists')
                (df.write.mode('errorifexists')
                    .option('header', 'true')
                    .option('encoding', 'UTF-8')
                    .csv(staging_path))
                self._check_cancelled()
                if not fs.rename(staging, target):
                    raise RuntimeError('failed to publish HDFS export path')
                result = {'hdfsPath': final_path, 'costMs': int((time.time() - start) * 1000)}
                self._engine._audit('export done job=%s path=%s' % (job_id, final_path))
                return result
            except Exception:
                if fs is not None and staging is not None:
                    try:
                        if fs.exists(staging):
                            fs.delete(staging, True)
                    except Exception:
                        pass
                raise
