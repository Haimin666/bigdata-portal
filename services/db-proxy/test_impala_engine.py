import unittest
import os
import tempfile

import impala_engine


@unittest.skipUnless(impala_engine.sqlglot is not None, "sqlglot is required")
class ImpalaTypeCheckTests(unittest.TestCase):
    def test_resolves_unqualified_literals_and_join_columns_through_ctes(self):
        sql = """
        WITH order_m_cyc AS (
          SELECT id AS bill_id, bill_no AS biz_order_no
          FROM bill
          WHERE active_flag = 1 AND status_code = 2
        ), tmp_cyc AS (
          SELECT c.pay_sch_id_sh
          FROM order_m_cyc a
          JOIN mapping c ON a.biz_order_no = c.pay_sch_no_zf
        )
        SELECT tmp.pay_sch_id_sh
        FROM (SELECT * FROM tmp_cyc) tmp
        JOIN order_m_cyc t1 ON tmp.pay_sch_id_sh = t1.bill_id
        """
        schema = {
            ("db", "bill"): {
                "id": "BIGINT",
                "bill_no": "STRING",
                "active_flag": "STRING",
                "status_code": "STRING",
            },
            ("db", "mapping"): {
                "pay_sch_id_sh": "STRING",
                "pay_sch_no_zf": "BIGINT",
            },
        }
        logs = []

        result = impala_engine.fix_sql_types(sql, schema, logs)

        self.assertEqual(result.n_changes, 4, logs)
        self.assertIn("active_flag = '1'", result.fixed_sql)
        self.assertIn("status_code = '2'", result.fixed_sql)
        self.assertIn(
            "CAST(a.biz_order_no AS STRING) = CAST(c.pay_sch_no_zf AS STRING)",
            result.fixed_sql,
        )
        self.assertIn(
            "CAST(tmp.pay_sch_id_sh AS STRING) = CAST(t1.bill_id AS STRING)",
            result.fixed_sql,
        )

    def test_persisted_schema_is_reused_without_describe(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = os.path.join(temp_dir, "schema.json")
            cache = impala_engine.ImpalaSchemaCache(path)
            cache.put_tables("warehouse", "db", ["bill"])
            cache.put_table("warehouse", "db", "bill", {"id": "BIGINT", "label": "STRING"})

            restored = impala_engine.ImpalaSchemaCache(path)
            logs = []

            class NoQueryConnection:
                def cursor(self):
                    raise AssertionError("cached metadata should not issue DESCRIBE")

            schema = impala_engine.fetch_schema(
                NoQueryConnection(), "SELECT id FROM db.bill", logs,
                restored, "warehouse", "db",
            )

            self.assertEqual(schema, {("db", "bill"): {"id": "BIGINT", "label": "STRING"}})
            self.assertEqual(restored.get_tables("warehouse", "db"), ["bill"])
            self.assertTrue(any("本地缓存" in line for line in logs))

    def test_refresh_replaces_cached_table_columns(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = impala_engine.ImpalaSchemaCache(os.path.join(temp_dir, "schema.json"))
            cache.put_table("warehouse", "db", "bill", {"id": "BIGINT"})

            class Cursor:
                def execute(self, sql):
                    self.sql = sql

                def fetchall(self):
                    return [("id", "BIGINT", ""), ("new_field", "STRING", "")]

                def close(self):
                    pass

            class Connection:
                def cursor(self):
                    return Cursor()

            engine = impala_engine.ImpalaEngine(schema_cache=cache)
            updated = engine.table_columns(Connection(), "warehouse", "db", "bill", refresh=True)

            self.assertEqual(updated, {"id": "BIGINT", "new_field": "STRING"})
            self.assertEqual(cache.get_table("warehouse", "db", "bill"), updated)


if __name__ == "__main__":
    unittest.main()
