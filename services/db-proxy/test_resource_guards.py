"""db-proxy 元数据资源护栏与跨库搜索并发回归测试(不连接真实数据源)。"""

from __future__ import annotations

import asyncio
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import main


class FakeDataSource:
    def __init__(self, name, host="host", port=3306, kind="mysql"):
        self.name = name
        self.host = host
        self.port = port
        self.type = kind
        self.service = "db"


class BoundedSearchTests(unittest.TestCase):
    def test_datasources_are_deduplicated_by_connection_identity(self):
        sources = [
            FakeDataSource("a"),
            FakeDataSource("b"),  # 同实例的另一个逻辑源,不重复扫
            FakeDataSource("c", host="other"),
        ]
        self.assertEqual([x.name for x in main._distinct_search_datasources(sources)], ["a", "c"])

    def test_search_runs_in_parallel_but_respects_executor_worker_bound(self):
        sources = [FakeDataSource(str(i), host=str(i)) for i in range(4)]
        lock = threading.Lock()
        active = 0
        maximum = 0

        def probe(ds, keyword):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
            time.sleep(0.04)
            with lock:
                active -= 1
            return [{"db": ds.name, "table": keyword}]

        original = main._search_one_instance
        main._search_one_instance = probe
        pool = ThreadPoolExecutor(max_workers=2)
        try:
            started = time.monotonic()
            rows, complete, successful, total = main._run_bounded_table_search(
                "t", datasources=sources, deadline_seconds=1, executor=pool
            )
            elapsed = time.monotonic() - started
        finally:
            main._search_one_instance = original
            pool.shutdown(wait=True)

        self.assertTrue(complete)
        self.assertEqual((successful, total), (4, 4))
        self.assertEqual(len(rows), 4)
        self.assertGreater(maximum, 1)
        self.assertLessEqual(maximum, 2)
        self.assertLess(elapsed, 0.15, "four scans should complete in two worker waves")

    def test_deadline_returns_without_waiting_and_marks_partial(self):
        sources = [FakeDataSource(str(i), host=str(i)) for i in range(2)]
        started = threading.Event()
        release = threading.Event()

        def probe(ds, keyword):
            started.set()
            release.wait(timeout=1)
            return [{"db": ds.name, "table": keyword}]

        original = main._search_one_instance
        main._search_one_instance = probe
        pool = ThreadPoolExecutor(max_workers=2)
        try:
            rows, complete, successful, total = main._run_bounded_table_search(
                "t", datasources=sources, deadline_seconds=0.02, executor=pool
            )
            self.assertTrue(started.is_set())
            self.assertFalse(complete)
            self.assertLess(total, 3)
            self.assertLess(successful, total)
            self.assertEqual(rows, [])
        finally:
            release.set()
            main._search_one_instance = original
            pool.shutdown(wait=True)

    def test_partial_result_is_not_cached_but_complete_empty_result_is(self):
        original_auth = main.require_auth
        original_run = main._run_bounded_table_search
        try:
            main.require_auth = lambda _token: None
            main._SEARCH_CACHE.clear()
            main._run_bounded_table_search = lambda _kw: ([{"db": "d", "table": "t"}], False, 1, 2)
            partial = main.search_tables("partial", x_db_token=None)
            self.assertEqual(partial["data"], [{"db": "d", "table": "t"}])
            self.assertIsNone(main._SEARCH_CACHE.get("st:partial"))

            main._run_bounded_table_search = lambda _kw: ([], True, 2, 2)
            complete = main.search_tables("empty", x_db_token=None)
            self.assertEqual(complete["data"], [])
            self.assertEqual(main._SEARCH_CACHE.get("st:empty"), [])
        finally:
            main.require_auth = original_auth
            main._run_bounded_table_search = original_run
            main._SEARCH_CACHE.clear()


class ResourceMiddlewareTests(unittest.TestCase):
    @staticmethod
    def request(path, method="GET"):
        return SimpleNamespace(url=SimpleNamespace(path=path), method=method)

    def test_metadata_limit_returns_429_without_entering_handler(self):
        original = main._query_semaphore
        semaphore = threading.BoundedSemaphore(1)
        self.assertTrue(semaphore.acquire(blocking=False))
        main._query_semaphore = semaphore
        called = []

        async def next_handler(_request):
            called.append(True)
            return "ok"

        try:
            response = asyncio.run(main.database_resource_guard(self.request("/schema"), next_handler))
            self.assertEqual(response.status_code, 429)
            self.assertEqual(called, [])
        finally:
            semaphore.release()
            main._query_semaphore = original

    def test_metadata_slot_is_released_after_handler(self):
        original = main._query_semaphore
        semaphore = threading.BoundedSemaphore(1)
        main._query_semaphore = semaphore

        async def next_handler(_request):
            self.assertFalse(semaphore.acquire(blocking=False), "metadata handler must hold the shared slot")
            return "ok"

        try:
            self.assertEqual(
                asyncio.run(main.database_resource_guard(self.request("/explain", "POST"), next_handler)),
                "ok",
            )
            self.assertTrue(semaphore.acquire(blocking=False), "middleware must release its slot")
            semaphore.release()
        finally:
            main._query_semaphore = original

    def test_search_requests_have_a_separate_nonblocking_limit(self):
        original = main._search_request_semaphore
        semaphore = threading.BoundedSemaphore(1)
        self.assertTrue(semaphore.acquire(blocking=False))
        main._search_request_semaphore = semaphore
        called = []

        async def next_handler(_request):
            called.append(True)
            return "ok"

        try:
            response = asyncio.run(
                main.database_resource_guard(self.request("/search/tables"), next_handler)
            )
            self.assertEqual(response.status_code, 429)
            self.assertEqual(called, [])
        finally:
            semaphore.release()
            main._search_request_semaphore = original


if __name__ == "__main__":
    unittest.main()
