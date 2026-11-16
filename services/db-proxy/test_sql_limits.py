"""行数限制语义单测:默认 1000 行、显式上限硬顶 500000、作用域与注释感知。"""

from __future__ import annotations

import unittest

from sql_limits import (
    DEFAULT_ROWS,
    MAX_ROWS,
    effective_limits,
    mask_sql,
    plan_row_limit,
)


class MaskTests(unittest.TestCase):
    def test_mask_preserves_length_and_offsets(self):
        sql = "SELECT '--x' AS a, 1 /* LIMIT 9 */ FROM t -- LIMIT 5\nWHERE b='q'"
        masked = mask_sql(sql)
        self.assertEqual(len(masked), len(sql))
        self.assertNotIn("LIMIT 9", masked)
        self.assertNotIn("LIMIT 5", masked)
        self.assertNotIn("'--x'", masked)
        self.assertIn("FROM t", masked)

    def test_mask_handles_escaped_quotes_and_backticks(self):
        sql = "SELECT 'it''s' , \"a\"\"b\", `we``ird` FROM t"
        masked = mask_sql(sql)
        self.assertEqual(len(masked), len(sql))
        self.assertIn("FROM t", masked)
        self.assertNotIn("it''s", masked)


class DefaultLimitTests(unittest.TestCase):
    def test_appends_default_limit_on_new_line(self):
        plan = plan_row_limit("SELECT * FROM t", mode="mysql")
        self.assertTrue(plan.appended)
        self.assertFalse(plan.clamped)
        self.assertEqual(plan.limit, DEFAULT_ROWS)
        self.assertTrue(plan.sql.endswith("\nLIMIT 1000"))

    def test_appended_limit_survives_trailing_line_comment(self):
        plan = plan_row_limit("SELECT * FROM t -- 只看几行", mode="mysql")
        self.assertTrue(plan.appended)
        # 换行保证 LIMIT 不在注释里
        self.assertIn("\nLIMIT 1000", plan.sql)
        self.assertTrue(plan.sql.strip().endswith("LIMIT 1000"))

    def test_special_statements_are_untouched(self):
        for sql in ("SHOW TABLES", "DESC t", "EXPLAIN SELECT 1"):
            plan = plan_row_limit(sql, mode="mysql")
            self.assertEqual(plan.sql, sql)
            self.assertFalse(plan.rewritten)
            self.assertEqual(plan.limit, DEFAULT_ROWS)

    def test_oracle_rownum_wraps_for_11g(self):
        plan = plan_row_limit("SELECT * FROM t ORDER BY a", mode="rownum")
        self.assertTrue(plan.appended)
        self.assertIn("WHERE ROWNUM <= 1000", plan.sql)
        self.assertIn("SELECT * FROM (\n", plan.sql)

    def test_oracle_fetch_appends_fetch_first(self):
        plan = plan_row_limit("SELECT * FROM t", mode="fetch")
        self.assertTrue(plan.appended)
        self.assertIn("\nFETCH FIRST 1000 ROWS ONLY", plan.sql)


class ExplicitLimitTests(unittest.TestCase):
    def test_explicit_limit_below_cap_is_respected(self):
        plan = plan_row_limit("SELECT * FROM t LIMIT 10", mode="mysql")
        self.assertFalse(plan.rewritten)
        self.assertEqual(plan.limit, 10)
        self.assertEqual(plan.sql, "SELECT * FROM t LIMIT 10")

    def test_explicit_limit_above_cap_is_clamped(self):
        plan = plan_row_limit("SELECT * FROM t LIMIT 900000", mode="mysql")
        self.assertTrue(plan.clamped)
        self.assertEqual(plan.limit, MAX_ROWS)
        self.assertIn("LIMIT 500000", plan.sql)
        self.assertNotIn("900000", plan.sql)

    def test_limit_inside_string_literal_is_ignored(self):
        sql = "SELECT * FROM t WHERE note = 'LIMIT 900000'"
        plan = plan_row_limit(sql, mode="mysql")
        self.assertTrue(plan.appended)
        self.assertEqual(plan.limit, DEFAULT_ROWS)
        self.assertIn("LIMIT 1000", plan.sql)

    def test_limit_inside_subquery_does_not_count_as_outer_limit(self):
        sql = "SELECT * FROM (SELECT * FROM big LIMIT 5000) x"
        plan = plan_row_limit(sql, mode="mysql")
        self.assertTrue(plan.appended)
        self.assertEqual(plan.limit, DEFAULT_ROWS)
        self.assertTrue(plan.sql.endswith("\nLIMIT 1000"))

    def test_limit_inside_comment_is_ignored(self):
        sql = "SELECT * FROM t /* LIMIT 1 */"
        plan = plan_row_limit(sql, mode="mysql")
        self.assertTrue(plan.appended)
        self.assertEqual(plan.limit, DEFAULT_ROWS)

    def test_mysql_offset_comma_form(self):
        plan = plan_row_limit("SELECT * FROM t LIMIT 20, 30", mode="mysql")
        self.assertFalse(plan.rewritten)
        self.assertEqual(plan.limit, 30)

    def test_mysql_offset_form(self):
        plan = plan_row_limit("SELECT * FROM t LIMIT 30 OFFSET 20", mode="mysql")
        self.assertEqual(plan.limit, 30)

    def test_oracle_fetch_explicit(self):
        plan = plan_row_limit("SELECT * FROM t FETCH FIRST 20 ROWS ONLY", mode="fetch")
        self.assertFalse(plan.rewritten)
        self.assertEqual(plan.limit, 20)

    def test_oracle_fetch_over_cap_is_clamped(self):
        plan = plan_row_limit("SELECT * FROM t FETCH FIRST 700000 ROWS ONLY", mode="fetch")
        self.assertTrue(plan.clamped)
        self.assertEqual(plan.limit, MAX_ROWS)
        self.assertIn("FETCH FIRST 500000 ROWS ONLY", plan.sql)

    def test_oracle_rownum_semantics(self):
        plan = plan_row_limit("SELECT * FROM t WHERE ROWNUM <= 20", mode="rownum")
        self.assertEqual(plan.limit, 20)
        strict = plan_row_limit("SELECT * FROM t WHERE ROWNUM < 20", mode="rownum")
        self.assertEqual(strict.limit, 19)

    def test_oracle_rownum_over_cap_is_clamped(self):
        plan = plan_row_limit("SELECT * FROM t WHERE ROWNUM <= 800000", mode="rownum")
        self.assertTrue(plan.clamped)
        self.assertIn("ROWNUM <= 500000", plan.sql)

    def test_non_constant_limit_is_bounded_by_cap(self):
        plan = plan_row_limit("SELECT * FROM t LIMIT ?", mode="mysql")
        self.assertEqual(plan.limit, MAX_ROWS)
        self.assertFalse(plan.rewritten)


class MultiStatementTests(unittest.TestCase):
    def test_multi_statement_is_not_rewritten(self):
        sql = "SELECT 1; SELECT 2"
        plan = plan_row_limit(sql, mode="mysql")
        self.assertEqual(plan.sql, sql)
        self.assertFalse(plan.rewritten)
        self.assertEqual(plan.limit, DEFAULT_ROWS)

    def test_single_statement_with_terminator_keeps_terminator(self):
        plan = plan_row_limit("SELECT * FROM t;", mode="mysql")
        self.assertTrue(plan.appended)
        self.assertTrue(plan.sql.endswith("LIMIT 1000;"))


class EffectiveLimitTests(unittest.TestCase):
    def test_cap_cannot_exceed_hard_cap(self):
        default, cap = effective_limits(2000, 10_000_000)
        self.assertEqual(cap, MAX_ROWS)
        self.assertEqual(default, 2000)

    def test_default_cannot_exceed_cap(self):
        default, cap = effective_limits(900_000, 50_000)
        self.assertEqual(cap, 50_000)
        self.assertEqual(default, 50_000)

    def test_garbage_falls_back(self):
        default, cap = effective_limits("abc", None)
        self.assertEqual((default, cap), (DEFAULT_ROWS, MAX_ROWS))

    def test_product_defaults(self):
        self.assertEqual(effective_limits(None, None), (1000, 500_000))


if __name__ == "__main__":
    unittest.main()
