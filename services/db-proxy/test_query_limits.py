import unittest

from spark_engine import collect_limited_rows


class QueryLimitTests(unittest.TestCase):
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
