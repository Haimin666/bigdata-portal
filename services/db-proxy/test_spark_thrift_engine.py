import io
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
try:
    from spark_thrift_engine import SparkThriftEngine
except ModuleNotFoundError:
    SparkThriftEngine = None


class BeelineProcess:
    def __init__(self, stdout="", stderr="", returncode=0, blocked=False,
                 timeout=False, ignore_terminate=False):
        self.stdout = io.StringIO(stdout)
        self.stderr = io.StringIO(stderr)
        self.returncode = None
        self.exit_code = returncode
        self.started = threading.Event()
        self.finished = threading.Event()
        self.blocked = blocked
        self.timeout = timeout
        self.ignore_terminate = ignore_terminate
        self.terminated = False
        self.killed = False

    def wait(self, timeout=None):
        self.started.set()
        if self.timeout and not self.terminated:
            raise subprocess.TimeoutExpired("beeline", timeout)
        if self.ignore_terminate and not self.killed:
            raise subprocess.TimeoutExpired("beeline", timeout)
        if self.blocked and not self.finished.wait(2):
            raise AssertionError("cancel did not stop the process")
        self.returncode = self.exit_code
        return self.returncode

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        if not self.ignore_terminate:
            self.finished.set()

    def kill(self):
        self.killed = True
        self.finished.set()


class SparkThriftEngineTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(SparkThriftEngine, "SparkThriftEngine adapter is missing")
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

    def engine(self, **cfg):
        return SparkThriftEngine({"enabled": True, **cfg}, self.temp_dir.name)

    def test_csv2_preserves_quoted_commas_quotes_newlines_and_unicode(self):
        process = BeelineProcess('id,label,note\n1,"北京,上海","a ""quote"""\n'
                                 '2,"two\nlines",NULL\n3,,\\N\n')
        with patch("spark_thrift_engine.subprocess.Popen", return_value=process):
            result = self.engine().execute_sql("SHOW TABLES")
        self.assertEqual(result["columns"], ["id", "label", "note"])
        self.assertEqual(result["rows"], [
            {"id": "1", "label": "北京,上海", "note": 'a "quote"'},
            {"id": "2", "label": "two\nlines", "note": None},
            {"id": "3", "label": "", "note": None},
        ])
        self.assertFalse(result["truncated"])
        self.assertGreaterEqual(result["costMs"], 0)

    def test_empty_command_output_returns_empty_table(self):
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()):
            self.assertEqual(self.engine().execute_sql("CREATE TEMP VIEW v AS SELECT 1")["rows"], [])

    def test_csv2_result_retains_only_configured_limit(self):
        process = BeelineProcess("id\n1\n2\n3\n")
        with patch("spark_thrift_engine.subprocess.Popen", return_value=process):
            result = self.engine(defaultLimit=2).execute_sql("SHOW TABLES")
        self.assertEqual(result["rows"], [{"id": "1"}, {"id": "2"}])
        self.assertTrue(result["truncated"])

    def test_default_command_uses_spark_home_local_jdbc_csv2_and_root(self):
        with patch.dict(os.environ, {"SPARK_HOME": "/opt/spark", "JAVA_TOOL_OPTIONS": "-Xmx128m"}), \
                patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            self.engine().execute_sql("SHOW DATABASES")
        args = popen.call_args.args[0]
        self.assertEqual(args[0], "/opt/spark/bin/beeline")
        self.assertEqual(args[args.index("-u") + 1], "jdbc:hive2://127.0.0.1:10001/default")
        self.assertEqual(args[args.index("-n") + 1], "root")
        self.assertEqual(args[args.index("-e") + 1], "SHOW DATABASES")
        for arg in ("--outputformat=csv2", "--showHeader=true", "--silent=true", "--force=false"):
            self.assertIn(arg, args)
        self.assertIn("-Ddisable.quoting.for.sv=false", popen.call_args.kwargs["env"]["JAVA_TOOL_OPTIONS"])
        self.assertIn("-Xmx128m", popen.call_args.kwargs["env"]["JAVA_TOOL_OPTIONS"])
        self.assertFalse(popen.call_args.kwargs.get("shell", False))

    def test_explicit_command_configuration_is_used(self):
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            self.engine(beelinePath="/custom/beeline", jdbcUrl="jdbc:hive2://local:10002/warehouse",
                        user="analyst").execute_sql("SELECT 1")
        args = popen.call_args.args[0]
        self.assertEqual(args[0], "/custom/beeline")
        self.assertEqual(args[args.index("-u") + 1], "jdbc:hive2://local:10002/warehouse")
        self.assertEqual(args[args.index("-n") + 1], "analyst")
        self.assertNotIn("-p", args)

    def test_password_configuration_is_rejected_without_launching_or_leaking(self):
        with patch("spark_thrift_engine.subprocess.Popen") as popen:
            with self.assertRaisesRegex(ValueError, "password") as caught:
                self.engine(password="fake-password").execute_sql("SELECT 1")
        self.assertNotIn("fake-password", str(caught.exception))
        popen.assert_not_called()

    def test_disabled_engine_does_not_launch_beeline(self):
        with patch("spark_thrift_engine.subprocess.Popen") as popen:
            with self.assertRaisesRegex(RuntimeError, "not enabled"):
                self.engine(enabled=False).execute_sql("SELECT 1")
        popen.assert_not_called()

    def test_nonzero_exit_raises_original_diagnostic_and_clears_running_state(self):
        process = BeelineProcess("", "Error: Table missing (SQLState=42S02)\n", returncode=1)
        engine = self.engine()
        with patch("spark_thrift_engine.subprocess.Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "Table missing"):
                engine.execute_sql("SELECT * FROM missing")
        self.assertEqual(engine.status()["state"], "error")
        self.assertFalse(engine.status()["busy"])

    def test_start_failure_redacts_password_in_exception_and_status(self):
        engine = self.engine()
        with patch("spark_thrift_engine.subprocess.Popen", side_effect=OSError("password=jdbc-secret unavailable")):
            with self.assertRaises(RuntimeError) as caught:
                engine.execute_sql("SELECT 1")
        self.assertNotIn("jdbc-secret", str(caught.exception))
        self.assertNotIn("jdbc-secret", str(engine.status()))

    def test_timeout_terminates_process_and_reports_timeout(self):
        process = BeelineProcess(timeout=True)
        engine = self.engine()
        with patch("spark_thrift_engine.subprocess.Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "超时|timeout"):
                engine.execute_sql("SELECT 1", timeout_ms=1)
        self.assertTrue(process.terminated)
        self.assertFalse(engine.status()["busy"])

    def test_termination_escalates_to_kill_when_beeline_does_not_exit(self):
        process = BeelineProcess(timeout=True, ignore_terminate=True)
        with patch("spark_thrift_engine.subprocess.Popen", return_value=process):
            with self.assertRaises(RuntimeError):
                self.engine().execute_sql("SELECT 1", timeout_ms=1)
        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)

    def test_cancel_stops_active_process_without_waiting_for_execution_lock(self):
        process = BeelineProcess("id\n1\n", "executing\n", blocked=True)
        engine = self.engine()
        errors = []

        def execute():
            try:
                engine.execute_sql("SELECT 1", timeout_ms=0)
            except RuntimeError as error:
                errors.append(str(error))

        with patch("spark_thrift_engine.subprocess.Popen", return_value=process):
            worker = threading.Thread(target=execute)
            worker.start()
            self.assertTrue(process.started.wait(1))
            self.assertTrue(engine.status()["busy"])
            self.assertIn("executing", engine.read_logs()["content"])
            engine.cancel()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertTrue(process.terminated)
        self.assertEqual(len(errors), 1)
        self.assertRegex(errors[0], "取消|cancel")
        self.assertFalse(engine.status()["busy"])

    def test_secret_redaction_covers_logs_status_and_failure(self):
        engine = self.engine()
        process = BeelineProcess("", "failed password=jdbc-secret\n", returncode=1)
        with patch("spark_thrift_engine.subprocess.Popen", return_value=process):
            with self.assertRaises(RuntimeError) as caught:
                engine.execute_sql("SELECT 1")
        for output in (str(caught.exception), str(engine.status()), engine.read_logs()["content"]):
            self.assertNotIn("jdbc-secret", output)

    def test_jdbc_secrets_are_rejected_before_they_can_enter_process_arguments(self):
        for jdbc in ("jdbc:hive2://local/default;password=jdbc-secret",
                     "jdbc:hive2://user:jdbc-secret@local/default"):
            with self.subTest(jdbc=jdbc):
                engine = self.engine(jdbcUrl=jdbc)
                with patch("spark_thrift_engine.subprocess.Popen") as popen:
                    with self.assertRaisesRegex(ValueError, "credential"):
                        engine.execute_sql("SELECT 1")
                popen.assert_not_called()
                self.assertNotIn("jdbc-secret", str(engine.status()))

    def test_malformed_csv_fails_instead_of_returning_successful_rows(self):
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess("id,name\n1\n")):
            with self.assertRaisesRegex(RuntimeError, "CSV2"):
                self.engine().execute_sql("SHOW TABLES")

    def test_nonzero_exit_includes_stdout_diagnostic(self):
        process = BeelineProcess("Error: stdout table missing\n", "", returncode=1)
        with patch("spark_thrift_engine.subprocess.Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "stdout table missing"):
                self.engine().execute_sql("SELECT * FROM missing")

    def test_export_runs_csv_insert_without_collecting_source_rows(self):
        engine = self.engine(defaultLimit=1)
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            result = engine.export_sql("SELECT * FROM source;", "job-1")
        self.assertRegex(result["hdfsPath"], r"^hdfs:///tmp/db-proxy-spark-exports/spark_export_job-1_[0-9a-f]+$")
        args = popen.call_args.args[0]
        sql = args[args.index("-e") + 1]
        self.assertIn("INSERT OVERWRITE DIRECTORY '", sql)
        self.assertIn("USING CSV OPTIONS (header 'true')", sql)
        self.assertTrue(sql.endswith("SELECT * FROM source"))
        self.assertNotIn("LIMIT", sql)
        self.assertEqual(set(result), {"hdfsPath", "costMs"})

    def test_export_accepts_semicolon_comment_markers_and_write_words_inside_strings(self):
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()):
            result = self.engine().export_sql("-- start\nWITH x AS (SELECT 'a;--/* INSERT' AS value) SELECT * FROM x; -- end", "safe")
        self.assertIn("/spark_export_safe_", result["hdfsPath"])

    def test_export_rejects_multiple_statements_and_writes_before_launch(self):
        for sql in ("SELECT 1; DROP TABLE x", "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
                    "DELETE FROM x", "SHOW TABLES", "SELECT 1;;", "SELECT 'unclosed"):
            with self.subTest(sql=sql), patch("spark_thrift_engine.subprocess.Popen") as popen:
                with self.assertRaises(ValueError):
                    self.engine().export_sql(sql, "safe")
                popen.assert_not_called()

    def test_export_sanitizes_job_id_and_quotes_configured_path(self):
        engine = self.engine(exportPath="hdfs:///exports/team's files")
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            result = engine.export_sql("SELECT 1", "../unsafe'; DROP")
        self.assertNotIn("..", result["hdfsPath"])
        self.assertRegex(result["hdfsPath"], r"/spark_export_[A-Za-z0-9_-]+$")
        args = popen.call_args.args[0]
        sql = args[args.index("-e") + 1]
        self.assertIn("team\\'s files", sql)

    def test_export_rejects_non_hdfs_or_unsafe_roots(self):
        for root in ("file:///tmp/export", "hdfs:///root/../escape", "hdfs:///root\nignored",
                     "hdfs:///root?query=x", "hdfs:///root#fragment"):
            with self.subTest(root=root), patch("spark_thrift_engine.subprocess.Popen") as popen:
                with self.assertRaises(ValueError):
                    self.engine(exportPath=root).export_sql("SELECT 1", "safe")
                popen.assert_not_called()

    def test_log_offsets_are_incremental_and_count_utf8_bytes(self):
        engine = self.engine()
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess("id\n北京\n", "诊断\n")):
            engine.execute_sql("SHOW TABLES")
        first = engine.read_logs()
        self.assertIn("诊断", first["content"])
        self.assertEqual(set(first["offsets"]), {"jvm", "audit"})
        self.assertEqual(first["offsets"], first["files"])
        self.assertGreater(first["offsets"]["jvm"], len("id\n北京\n诊断\n"))
        self.assertEqual(engine.read_logs(first["offsets"])["content"], "")

    def test_schema_sql_uses_same_thrift_transport(self):
        engine = self.engine()
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess("namespace\ndefault\n")) as popen:
            result = engine.execute_schema_sql("SHOW DATABASES")
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index("-e") + 1], "SHOW DATABASES")
        self.assertEqual(result["rows"], [{"namespace": "default"}])


if __name__ == "__main__":
    unittest.main()
