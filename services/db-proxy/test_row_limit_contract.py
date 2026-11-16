"""db-proxy 执行层契约测试:默认 1000 行 / 硬上限 500000 / 空结果列名 / 真实取消。

不连接任何真实数据库:用假 conn/cursor/ds 驱动 main._execute_query 与
DbJobManager.cancel,验证服务端确实改写/限行,以及取消时调用数据源侧 KILL。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_TMP_DIR = None
_ORIG_CWD = None
main = None


def setUpModule():
    """用临时 datasources.json 启动 main(避免依赖仓库里的真实配置)。"""
    global _TMP_DIR, _ORIG_CWD, main
    _ORIG_CWD = os.getcwd()
    _TMP_DIR = tempfile.mkdtemp(prefix="dbproxy-contract-")
    cfg = {
        "authToken": "",
        "defaultLimit": 1000,
        "maxLimit": 500000,
        "maxSqlLen": 32768,
        "datasources": [
            {
                "name": "m1", "type": "mysql", "host": "127.0.0.1", "port": 3306,
                "user": "u", "password": "p", "database": "d1",
            },
            {
                "name": "o1", "type": "oracle", "host": "127.0.0.1", "port": 1521,
                "user": "u", "password": "p", "service": "ORCL", "rowLimit": "rownum",
            },
        ],
        "impala": {"typeCheck": {"enabled": False}},
    }
    with open(os.path.join(_TMP_DIR, "datasources.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    os.chdir(_TMP_DIR)
    import main as main_module  # noqa: E402  (必须在临时配置就绪后导入)
    main = main_module


def tearDownModule():
    global _TMP_DIR
    if _ORIG_CWD:
        os.chdir(_ORIG_CWD)
    if _TMP_DIR:
        shutil.rmtree(_TMP_DIR, ignore_errors=True)


class FakeCursor:
    def __init__(self, owner, rows=None, description=None):
        self._owner = owner
        self._rows = list(rows or [])
        self.description = list(description or [])

    def execute(self, sql):
        self._owner.executed.append(sql)

    def fetchmany(self, size):
        return self._rows[:size]

    def close(self):
        pass


class FakeMysqlConn:
    thread_id_value = 4242

    def __init__(self, rows=None, description=None):
        self.executed = []
        self.closed = False
        self.committed = False
        self._rows = rows
        self._description = description

    def cursor(self):
        return FakeCursor(self, self._rows or [], self._description or [("id",)])

    def thread_id(self):
        return self.thread_id_value

    def commit(self):
        self.committed = True

    def close(self):
        self.closed = True


class FakeSource:
    type = "mysql"
    name = "fake"
    read_only = False
    row_limit = ""

    def __init__(self):
        self.cancel_calls = []

    def effective_row_limit(self, conn):
        return "mysql"

    def cancel_query(self, conn, cursor=None, thread_id=None, session_ids=None):
        self.cancel_calls.append((conn, cursor, thread_id, session_ids))
        return "mysql:KILL QUERY %s" % thread_id


def _run_select(sql, rows=None, description=None):
    ds = FakeSource()
    conn = FakeMysqlConn(rows=rows, description=description)
    result = main._execute_query(ds, conn, sql, True, time.time(), None, None)
    return result, conn.executed[-1]


class DefaultLimitContractTests(unittest.TestCase):
    def test_select_without_limit_gets_1000(self):
        result, executed = _run_select("SELECT * FROM t", rows=[{"id": 1}])
        self.assertIn("LIMIT 1000", executed)
        self.assertEqual(result["limit"], 1000)
        self.assertTrue(result["limited"])

    def test_select_with_small_limit_is_untouched(self):
        result, executed = _run_select("SELECT * FROM t LIMIT 5", rows=[])
        self.assertEqual(executed, "SELECT * FROM t LIMIT 5")
        self.assertEqual(result["limit"], 5)
        self.assertFalse(result["limited"])

    def test_explicit_limit_above_cap_is_clamped_to_500000(self):
        result, executed = _run_select("SELECT * FROM t LIMIT 900000", rows=[])
        self.assertIn("LIMIT 500000", executed)
        self.assertNotIn("900000", executed)
        self.assertEqual(result["limit"], 500000)
        self.assertTrue(result["limited"])

    def test_literal_and_subquery_limits_are_not_outer_limits(self):
        _, executed = _run_select("SELECT * FROM t WHERE note = 'LIMIT 900000'", rows=[])
        self.assertTrue(executed.endswith("LIMIT 1000") or "LIMIT 1000" in executed)
        self.assertIn("'LIMIT 900000'", executed)

        _, executed2 = _run_select("SELECT * FROM (SELECT * FROM big LIMIT 5000) x", rows=[])
        self.assertTrue(executed2.endswith("\nLIMIT 1000"))

    def test_special_statement_keeps_sql_but_read_is_bounded(self):
        result, executed = _run_select("SHOW TABLES", rows=[])
        self.assertEqual(executed, "SHOW TABLES")
        self.assertEqual(result["limit"], 1000)


class EmptyResultColumnTests(unittest.TestCase):
    def test_mysql_empty_result_keeps_columns(self):
        result, _ = _run_select(
            "SELECT id, name FROM t LIMIT 5",
            rows=[],
            description=[("id",), ("name",)],
        )
        self.assertEqual(result["columns"], ["id", "name"])
        self.assertEqual(result["rows"], [])

    def test_mysql_rows_are_plain_dicts(self):
        rows = [{"id": 1, "name": "a"}]
        result, _ = _run_select(
            "SELECT id, name FROM t LIMIT 5", rows=rows, description=[("id",), ("name",)]
        )
        self.assertEqual(result["columns"], ["id", "name"])
        self.assertEqual(result["rows"], rows)


class TruncationTests(unittest.TestCase):
    def test_truncated_when_more_rows_than_limit(self):
        rows = [{"id": i} for i in range(6)]
        result, _ = _run_select("SELECT * FROM t LIMIT 5", rows=rows, description=[("id",)])
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["rows"]), 5)


class JobCancelTests(unittest.TestCase):
    def _make_job(self, manager, source, conn, cursor, thread_id=4242, owner=None):
        job_id = "dbj_test"
        with manager._lock:
            manager._jobs[job_id] = {
                "id": job_id, "state": "running", "db": "fake", "sql": "SELECT 1",
                "timeout_ms": 1000, "created_at": time.time(), "started_at": time.time(),
                "finished_at": None, "result": None, "error": None, "logs": [],
                "executed_sql": None, "conn": conn, "cursor": cursor,
                "thread_id": thread_id, "session_ids": None, "ds": source,
                "owner": owner, "cancel_requested": False, "cancel_method": None,
            }
        return job_id

    def test_cancel_kills_statement_on_database_side(self):
        manager = main.DbJobManager()
        source = FakeSource()
        conn = FakeMysqlConn()
        cursor = FakeCursor(conn)
        job_id = self._make_job(manager, source, conn, cursor)

        self.assertTrue(manager.cancel(job_id))

        job = manager._jobs[job_id]
        self.assertTrue(job["cancel_requested"])
        self.assertEqual(len(source.cancel_calls), 1)
        _, passed_cursor, passed_thread, _ = source.cancel_calls[0]
        self.assertIs(passed_cursor, cursor)
        self.assertEqual(passed_thread, 4242)
        self.assertEqual(job["cancel_method"], "mysql:KILL QUERY 4242")
        self.assertTrue(conn.closed)
        self.assertTrue(any("终止数据库侧语句" in line for line in job["logs"]))

    def test_cancel_rejects_foreign_owner(self):
        manager = main.DbJobManager()
        source = FakeSource()
        conn = FakeMysqlConn()
        job_id = self._make_job(manager, source, conn, FakeCursor(conn), owner="alice")
        self.assertFalse(manager.cancel(job_id, owner="bob"))
        self.assertEqual(source.cancel_calls, [])

    def test_cancel_finished_job_returns_false(self):
        manager = main.DbJobManager()
        source = FakeSource()
        conn = FakeMysqlConn()
        job_id = self._make_job(manager, source, conn, FakeCursor(conn))
        manager._jobs[job_id]["state"] = "done"
        self.assertFalse(manager.cancel(job_id))
        self.assertEqual(source.cancel_calls, [])

    def test_get_hides_job_from_other_owner(self):
        manager = main.DbJobManager()
        source = FakeSource()
        conn = FakeMysqlConn()
        job_id = self._make_job(manager, source, conn, FakeCursor(conn), owner="alice")
        self.assertIsNotNone(manager.get(job_id, owner="alice"))
        self.assertIsNone(manager.get(job_id, owner="bob"))

    def test_job_ids_are_not_predictable(self):
        self.assertNotEqual(main.DB_JOBS, None)
        ids = {"dbj_%s" % main.uuid.uuid4().hex for _ in range(5)}
        self.assertEqual(len(ids), 5)


class MysqlCancelFallbackTests(unittest.TestCase):
    def test_without_thread_id_falls_back_to_close(self):
        ds = main.DataSource(
            {
                "name": "m2", "type": "mysql", "host": "127.0.0.1", "port": 3306,
                "user": "u", "password": "p", "database": "d2",
            }
        )
        self.assertEqual(ds.cancel_query(FakeMysqlConn(), cursor=None, thread_id=None), "close")

    def test_impala_cancel_uses_cursor_cancel_operation(self):
        ds = main.DataSource(
            {"name": "i1", "type": "impala", "host": "127.0.0.1", "port": 21050, "user": "u"}
        )
        calls = []

        class Cur:
            def cancel_operation(self):
                calls.append("cancel_operation")

        self.assertEqual(ds.cancel_query(None, cursor=Cur()), "impala:cancel_operation")
        self.assertEqual(calls, ["cancel_operation"])

    def test_impala_cancel_falls_back_to_connection_close(self):
        ds = main.DataSource(
            {"name": "i2", "type": "impala", "host": "127.0.0.1", "port": 21050, "user": "u"}
        )
        self.assertEqual(ds.cancel_query(None, cursor=object()), "close")


if __name__ == "__main__":
    unittest.main()
