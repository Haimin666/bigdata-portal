import unittest
import threading

from spark_engine import SparkEngine, collect_limited_rows


class QueryLimitTests(unittest.TestCase):
    def test_large_spark_sql_result_obeys_default_limit_instead_of_exporting(self):
        class DataFrame:
            columns = ["id"]

            def __init__(self):
                self.requested_limit = None
                self.count_calls = 0
                self.export_calls = 0
                self.write = self

            def count(self):
                self.count_calls += 1
                return 600001

            def limit(self, count):
                self.requested_limit = count
                return self

            def collect(self):
                return [(value,) for value in range(self.requested_limit)]

            def mode(self, _mode):
                return self

            def option(self, _key, _value):
                return self

            def csv(self, _path):
                self.export_calls += 1

        class Spark:
            def __init__(self, dataframe):
                self.dataframe = dataframe

            def sql(self, _sql):
                return self.dataframe

        dataframe = DataFrame()
        engine = SparkEngine.__new__(SparkEngine)
        engine.cfg = {"enabled": True, "defaultLimit": 1000, "maxLimit": 500000}
        engine._lock = threading.Lock()
        engine._spark = Spark(dataframe)
        engine._cancel_flag = threading.Event()
        engine._ensure_initialized = lambda: None
        engine._begin_job = lambda: "test-job"
        engine._end_job = lambda: None
        engine._audit = lambda _message: None
        engine._raise_if_cancelled = lambda: None

        result = engine.execute_sql("SELECT id FROM source", timeout_ms=0)

        self.assertEqual(len(result["rows"]), 1000)
        self.assertTrue(result["truncated"])
        self.assertNotIn("hdfsPath", result)
        self.assertEqual(dataframe.requested_limit, 1001)
        self.assertEqual(dataframe.count_calls, 0)
        self.assertEqual(dataframe.export_calls, 0)

    def test_large_pyspark_dataframe_obeys_default_limit_instead_of_exporting(self):
        class DataFrame:
            columns = ["id"]

            def __init__(self):
                self.requested_limit = None
                self.export_calls = 0
                self.write = self

            def count(self):
                return 600001

            def limit(self, count):
                self.requested_limit = count
                return self

            def collect(self):
                return [(value,) for value in range(self.requested_limit)]

            def mode(self, _mode):
                return self

            def option(self, _key, _value):
                return self

            def csv(self, _path):
                self.export_calls += 1

        class Spark:
            sparkContext = object()

        dataframe = DataFrame()
        spark = Spark()
        spark.dataframe = dataframe
        engine = SparkEngine.__new__(SparkEngine)
        engine.cfg = {"enabled": True, "defaultLimit": 1000, "maxLimit": 500000}
        engine._lock = threading.Lock()
        engine._spark = spark
        engine._cancel_flag = threading.Event()
        engine._ensure_initialized = lambda: None
        engine._begin_job = lambda: "test-job"
        engine._end_job = lambda: None
        engine._audit = lambda _message: None
        engine._raise_if_cancelled = lambda: None
        engine._json_value = lambda value: value

        result = engine.execute_code("result = spark.dataframe", timeout_ms=0)

        self.assertEqual(len(result["rows"]), 1000)
        self.assertTrue(result["truncated"])
        self.assertNotIn("hdfsPath", result)
        self.assertEqual(dataframe.requested_limit, 1001)
        self.assertEqual(dataframe.export_calls, 0)

    def test_special_statement_reads_bounded_iterator_without_dataframe_limit(self):
        class CommandResult:
            def __init__(self):
                self.consumed = 0

            def limit(self, _count):
                raise AssertionError("special command DataFrame must not be wrapped in limit()")

            def toLocalIterator(self):
                for value in range(100):
                    self.consumed += 1
                    yield (value,)

        result = CommandResult()
        rows = collect_limited_rows(result, 3, pushdown=False)

        self.assertEqual(rows, [(0,), (1,), (2,), (3,)])
        self.assertEqual(result.consumed, 4)

    def test_select_uses_spark_limit_pushdown(self):
        class SelectResult:
            def __init__(self):
                self.requested_limit = None

            def limit(self, count):
                self.requested_limit = count
                return self

            def collect(self):
                return [(1,), (2,)]

        result = SelectResult()
        rows = collect_limited_rows(result, 1, pushdown=True)

        self.assertEqual(result.requested_limit, 2)
        self.assertEqual(rows, [(1,), (2,)])


if __name__ == "__main__":
    unittest.main()
