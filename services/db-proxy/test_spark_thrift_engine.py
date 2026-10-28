import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import spark_thrift_engine
try:
    from spark_thrift_engine import SparkThriftEngine
except ModuleNotFoundError:
    SparkThriftEngine = None


class BeelineProcess:
    processes = {}

    def __init__(self, stdout="", stderr="", returncode=0, blocked=False,
                 timeout=False, ignore_terminate=False):
        self.stdout = tempfile.TemporaryFile(buffering=0)
        self.stderr = tempfile.TemporaryFile(buffering=0)
        self.stdout.write(stdout.encode("utf-8"))
        self.stderr.write(stderr.encode("utf-8"))
        self.stdout.seek(0)
        self.stderr.seek(0)
        self.returncode = None
        self.exit_code = returncode
        self.started = threading.Event()
        self.finished = threading.Event()
        self.blocked = blocked
        self.timeout = timeout
        self.ignore_terminate = ignore_terminate
        self.terminated = False
        self.killed = False
        self.pid = 100000 + len(self.processes)
        self.processes[self.pid] = self

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
        def kill_group(pid, sig):
            process = BeelineProcess.processes[pid]
            (process.terminate if sig == signal.SIGTERM else process.kill)()
        group_patch = patch("spark_thrift_engine.os.killpg", side_effect=kill_group)
        self.kill_group = group_patch.start()
        self.addCleanup(group_patch.stop)

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

    def test_query_rows_are_not_echoed_to_logs_but_stderr_progress_is(self):
        process = BeelineProcess("secret_result\nprivate-value\n", "Query abc: 10% Complete\n")
        engine = self.engine()
        with patch("spark_thrift_engine.subprocess.Popen", return_value=process):
            engine.execute_sql("SELECT private-value")
        logs = engine.read_logs()["content"]
        self.assertIn("Query abc: 10% Complete", logs)
        self.assertNotIn("private-value", logs)

    def test_empty_command_output_returns_empty_table(self):
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()):
            self.assertEqual(self.engine().execute_sql("CREATE TEMP VIEW v AS SELECT 1")["rows"], [])

    def test_csv2_result_retains_only_configured_limit(self):
        process = BeelineProcess("id\n1\n2\n3\n")
        with patch("spark_thrift_engine.subprocess.Popen", return_value=process):
            result = self.engine(defaultLimit=2).execute_sql("SHOW TABLES")
        self.assertEqual(result["rows"], [{"id": "1"}, {"id": "2"}])
        self.assertTrue(result["truncated"])

    def test_select_without_limit_gets_default_limit_before_trailing_comment(self):
        with patch("spark_thrift_engine.subprocess.Popen",
                   return_value=BeelineProcess("value\n1\n2\n")) as popen:
            self.engine(defaultLimit=25).execute_sql("SELECT 1 -- keep this comment")
        args = popen.call_args.args[0]
        sql = args[args.index("-e") + 1]
        self.assertEqual(sql, "SELECT 1 LIMIT 25 -- keep this comment\n;")

    def test_default_limit_marks_full_result_as_potentially_truncated(self):
        with patch("spark_thrift_engine.subprocess.Popen",
                   return_value=BeelineProcess("value\n1\n2\n")):
            result = self.engine(defaultLimit=2).execute_sql("SELECT value FROM source")
        self.assertTrue(result["truncated"])

    def test_explicit_limit_is_capped_at_max_limit(self):
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            self.engine(maxLimit=50).execute_sql("SELECT 1 LIMIT 1000;")
        args = popen.call_args.args[0]
        sql = args[args.index("-e") + 1]
        self.assertEqual(sql, "SELECT 1 LIMIT 50;")

    def test_smaller_explicit_limit_is_preserved(self):
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            self.engine(maxLimit=50).execute_sql("SELECT 1 LIMIT 20")
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index("-e") + 1], "SELECT 1 LIMIT 20\n;")

    def test_limit_all_is_replaced_with_configured_maximum(self):
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            self.engine(maxLimit=50).execute_sql("SELECT 1 LIMIT ALL;")
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index("-e") + 1], "SELECT 1 LIMIT 50;")

    def test_foldable_limit_expression_is_capped_without_a_duplicate_limit(self):
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            self.engine(maxLimit=50).execute_sql(
                "SELECT 1 LIMIT length('LIMIT 10') -- trailing note")
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index("-e") + 1],
                         "SELECT 1 LIMIT LEAST((length('LIMIT 10')), 50) "
                         "-- trailing note\n;")

    def test_default_limit_is_inserted_before_offset_and_preserves_comments(self):
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            self.engine(defaultLimit=25).execute_sql("SELECT 1 -- before offset\nOFFSET 5")
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index("-e") + 1],
                         "SELECT 1 LIMIT 25 -- before offset\nOFFSET 5\n;")

    def test_explicit_limit_and_offset_are_preserved(self):
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            self.engine(maxLimit=50).execute_sql("SELECT 1 LIMIT 20 OFFSET 5")
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index("-e") + 1], "SELECT 1 LIMIT 20 OFFSET 5\n;")

    def test_semicolons_in_strings_and_comments_do_not_look_like_statements(self):
        sql = "SELECT ';' AS value /* ; */ -- ;\n"
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            self.engine(defaultLimit=25).execute_sql(sql)
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index("-e") + 1],
                         "SELECT ';' AS value LIMIT 25 /* ; */ -- ;\n;")

    def test_multiple_statements_are_rejected_before_beeline_launch(self):
        with patch("spark_thrift_engine.subprocess.Popen") as popen:
            with self.assertRaisesRegex(ValueError, "one SQL statement"):
                self.engine().execute_sql("SELECT 1; SELECT 2")
        popen.assert_not_called()

    def test_limit_in_comment_or_string_does_not_suppress_default_limit(self):
        sql = "SELECT 'LIMIT 2' AS note /* LIMIT 3 */ -- LIMIT 4\n"
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            self.engine(defaultLimit=25).execute_sql(sql)
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index("-e") + 1],
                         "SELECT 'LIMIT 2' AS note LIMIT 25 /* LIMIT 3 */ -- LIMIT 4\n;")

    def test_nested_limit_does_not_suppress_outer_default_limit(self):
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            self.engine(defaultLimit=25).execute_sql("WITH x AS (SELECT 1 LIMIT 3) SELECT * FROM x")
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index("-e") + 1],
                         "WITH x AS (SELECT 1 LIMIT 3) SELECT * FROM x LIMIT 25\n;")

    def test_show_desc_and_explain_are_not_rewritten(self):
        for sql in ("SHOW DATABASES", "DESC db.table", "EXPLAIN SELECT 1"):
            with self.subTest(sql=sql), patch(
                    "spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
                self.engine().execute_sql(sql)
                args = popen.call_args.args[0]
                self.assertEqual(args[args.index("-e") + 1], sql + "\n;")

    def test_default_command_uses_spark_home_local_jdbc_csv2_and_root(self):
        with patch.dict(os.environ, {"SPARK_HOME": "/opt/spark", "JAVA_TOOL_OPTIONS": "-Xmx128m"}), \
                patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess()) as popen:
            self.engine().execute_sql("SHOW DATABASES")
        args = popen.call_args.args[0]
        self.assertEqual(args[0], "/opt/spark/bin/beeline")
        self.assertEqual(args[args.index("-u") + 1], "jdbc:hive2://127.0.0.1:10001/default")
        self.assertEqual(args[args.index("-n") + 1], "root")
        self.assertEqual(args[args.index("-e") + 1], "SHOW DATABASES\n;")
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
        self.assertEqual(args[args.index("-e") + 1], "SELECT 1 LIMIT 1000\n;")
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
        logged = threading.Event()
        original_log = engine._log

        def observe_log(name, text):
            original_log(name, text)
            if "executing" in text:
                logged.set()

        def execute():
            try:
                engine.execute_sql("SELECT 1", timeout_ms=0)
            except RuntimeError as error:
                errors.append(str(error))

        with patch("spark_thrift_engine.subprocess.Popen", return_value=process), \
                patch.object(engine, "_log", side_effect=observe_log):
            worker = threading.Thread(target=execute)
            worker.start()
            try:
                self.assertTrue(process.started.wait(1))
                self.assertTrue(logged.wait(1))
                self.assertTrue(engine.status()["busy"])
                self.assertIn("executing", engine.read_logs()["content"])
            finally:
                engine.cancel()
                worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertTrue(process.terminated)
        self.assertEqual(len(errors), 1)
        self.assertRegex(errors[0], "取消|cancel")
        self.assertFalse(engine.status()["busy"])
        self.kill_group.assert_any_call(process.pid, signal.SIGTERM)
        self.kill_group.assert_any_call(process.pid, signal.SIGKILL)
        self.assertTrue(process.stdout.closed)
        self.assertTrue(process.stderr.closed)

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
                     "jdbc:hive2://user:jdbc-secret@local/default",
                     'jdbc:hive2://user:"jdbc-secret suffix,& tail"@local/default'):
            with self.subTest(jdbc=jdbc):
                engine = self.engine(jdbcUrl=jdbc)
                with patch("spark_thrift_engine.subprocess.Popen") as popen:
                    with self.assertRaisesRegex(ValueError, "credential"):
                        engine.execute_sql("SELECT 1")
                popen.assert_not_called()
                self.assertNotIn("jdbc-secret", str(engine.status()))
                self.assertNotIn("suffix", str(engine.status()))

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
        self.assertTrue(sql.endswith("SELECT * FROM source\n;"))
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
        self.assertEqual(first["offsets"]["jvm"], len("诊断\n".encode("utf-8")))
        self.assertNotIn("北京", first["content"])
        self.assertEqual(engine.read_logs(first["offsets"])["content"], "")

    def test_schema_sql_uses_same_thrift_transport(self):
        engine = self.engine()
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess("namespace\ndefault\n")) as popen:
            result = engine.execute_schema_sql("SHOW DATABASES")
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index("-e") + 1], "SHOW DATABASES\n;")
        self.assertEqual(result["rows"], [{"namespace": "default"}])

    def test_secret_assignments_redact_spaces_and_delimiters_completely(self):
        for assignment in ('password="alpha beta,gamma&delta"',
                           "token='alpha beta,gamma&delta'", "pwd=alpha beta,gamma&delta"):
            with self.subTest(assignment=assignment):
                engine = self.engine(jdbcUrl="jdbc:hive2://local/default;" + assignment)
                for value in (engine.status()["config"]["jdbcUrl"], engine._redact(assignment)):
                    for fragment in ("alpha", "beta", "gamma", "delta"):
                        self.assertNotIn(fragment, value)
                engine._log("jvm", assignment + "\n")
                self.assertNotIn("delta", engine.read_logs()["content"])

    def test_logs_keep_bounded_tail_and_monotonic_offsets_across_overflow(self):
        engine = self.engine()
        with patch.object(spark_thrift_engine, "MAX_LOG_BYTES", 64, create=True), \
                patch.object(spark_thrift_engine, "LOG_READ_BYTES", 16, create=True):
            engine._log("jvm", "a" * 50)
            first = engine.read_logs()
            engine._log("jvm", "b" * 50)
            replay = engine.read_logs({"jvm": 0})
            self.assertLessEqual(len(engine._logs["jvm"]), 64)
            self.assertLessEqual(len(replay["content"].encode("utf-8")), 16)
            self.assertEqual(replay["files"]["jvm"], 100)
            self.assertGreater(replay["offsets"]["jvm"], first["offsets"]["jvm"])
            self.assertEqual(replay["content"], "a" * 14 + "b" * 2)
            engine._log("audit", "c" * 100)
            self.assertLessEqual(len(engine._logs["audit"]), 64)
            self.assertLessEqual(len(engine.read_logs()["content"].encode("utf-8")), 32)

    def test_long_diagnostic_line_and_returned_errors_are_bounded(self):
        engine = self.engine()
        with patch("spark_thrift_engine.subprocess.Popen",
                   return_value=BeelineProcess(stderr="x" * 100000 + "\n", returncode=1)):
            with self.assertRaises(RuntimeError) as caught:
                engine.execute_sql("SELECT 1")
        self.assertLess(len(str(caught.exception).encode("utf-8")), 4096)
        self.assertLess(len(engine.read_logs()["content"].encode("utf-8")), 16384)

    def test_posix_timeout_uses_own_session_and_kills_process_group(self):
        process = BeelineProcess(timeout=True, ignore_terminate=True)
        with patch("spark_thrift_engine.subprocess.Popen", return_value=process) as popen:
            with self.assertRaisesRegex(RuntimeError, "timeout"):
                self.engine().execute_sql("SELECT 1", timeout_ms=1)
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.kill_group.assert_any_call(process.pid, signal.SIGTERM)
        self.kill_group.assert_any_call(process.pid, signal.SIGKILL)
        self.assertTrue(process.stdout.closed)
        self.assertTrue(process.stderr.closed)

    def test_output_reader_shutdown_has_bounded_wait_even_if_pipe_stays_open(self):
        class StuckReader:
            def __init__(self, **kwargs):
                pass

            def start(self):
                pass

            def join(self, timeout=None):
                if timeout is None:
                    raise AssertionError("reader shutdown must have a deadline")

            def is_alive(self):
                return True

        engine = self.engine()
        process = BeelineProcess()
        with patch("spark_thrift_engine.subprocess.Popen", return_value=process), \
                patch("spark_thrift_engine.threading.Thread", StuckReader):
            with self.assertRaisesRegex(RuntimeError, "reader|output"):
                engine.execute_sql("SELECT 1")
        self.assertFalse(engine.status()["busy"])
        self.assertTrue(process.stdout.closed)
        self.kill_group.assert_any_call(process.pid, signal.SIGKILL)

    def test_csv_fields_at_eight_mib_are_supported(self):
        value = "x" * (8 * 1024 * 1024)
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess("value\n" + value + "\n")):
            result = self.engine().execute_sql("SELECT value FROM source")
        self.assertEqual(result["rows"], [{"value": value}])

    def test_csv_field_above_eight_mib_reports_explicit_limit(self):
        value = "x" * (8 * 1024 * 1024 + 1)
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess("value\n" + value + "\n")):
            with self.assertRaisesRegex(RuntimeError, "8 MiB"):
                self.engine().execute_sql("SELECT value FROM source")

    def test_csv_field_limit_counts_utf8_bytes(self):
        value = "界" * (8 * 1024 * 1024 // 3 + 1)
        with patch("spark_thrift_engine.subprocess.Popen", return_value=BeelineProcess("value\n" + value + "\n")):
            with self.assertRaisesRegex(RuntimeError, "8 MiB"):
                self.engine().execute_sql("SELECT value FROM source")

    def test_real_pipe_readers_exit_when_a_descendant_keeps_pipe_open(self):
        process = BeelineProcess()
        process.stdout.close()
        reader_fd, writer_fd = os.pipe()
        process.stdout = os.fdopen(reader_fd, "rb", buffering=0)
        self.addCleanup(os.close, writer_fd)
        created = []
        real_thread = threading.Thread

        def create_reader(**kwargs):
            thread = real_thread(**kwargs)
            created.append(thread)
            return thread

        engine = self.engine()
        started = time.monotonic()
        with patch("spark_thrift_engine.subprocess.Popen", return_value=process), \
                patch("spark_thrift_engine.threading.Thread", side_effect=create_reader), \
                patch.object(spark_thrift_engine, "READER_WAIT_SECONDS", 0.05):
            with self.assertRaisesRegex(RuntimeError, "output readers"):
                engine.execute_sql("SELECT 1")
        self.assertLess(time.monotonic() - started, 1)
        self.assertTrue(all(not thread.is_alive() for thread in created))
        self.assertTrue(process.stdout.closed)
        self.assertFalse(engine.status()["busy"])


if __name__ == "__main__":
    unittest.main()
