#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""db-proxy 守卫逻辑自检(纯逻辑,无依赖,不连库)。

用法:python3 selfcheck_guards.py
复刻 main.py 中 /query 的守卫判定核心,防回归:
  1) 只读数据源(readOnly:true)拒绝非查询 SQL
  2) WITH 前缀 CTE-DML 不算只读(含注释前缀形态)
  3) /*! /*M! 可执行注释与 SELECT INTO OUTFILE/LOAD_FILE 走私不算只读
"""
import re

READ_ONLY_SQL_RE = re.compile(
    r"^\s*(?:--[^\n]*\n\s*|/\*.*?\*/\s*)*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|WITH)\b",
    re.IGNORECASE | re.DOTALL,
)


def is_select_of(clean_sql: str) -> bool:
    """复刻 fetch() 的 is_select 判定(与 main.py 保持一致)。"""
    is_select = bool(READ_ONLY_SQL_RE.match(clean_sql))
    no_comments = re.sub(r"--[^\n]*|/\*[\s\S]*?\*/", "", clean_sql).strip()
    if re.search(r"\*[Mm]?!", clean_sql) or re.search(
        r"\bINTO\s+(OUTFILE|DUMPFILE)\b|\bLOAD_FILE\s*\(", clean_sql, re.IGNORECASE
    ):
        is_select = False
    if is_select and re.match(r"^\s*WITH\b", no_comments, re.IGNORECASE):
        if re.search(
            r"\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b",
            no_comments,
            re.IGNORECASE,
        ):
            is_select = False
    return is_select


def would_block(read_only: bool, sql: str) -> bool:
    """readOnly:true 的数据源是否应拒绝该 SQL。"""
    return read_only and not is_select_of(sql.strip().rstrip(";").strip())


CASES = [
    # (read_only, sql, 是否应拦截)
    (True, "SELECT 1 FROM t", False),
    (True, "WITH c AS (SELECT 1) SELECT * FROM c", False),
    (True, "WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c", True),
    (True, "/* 注释 */ WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c", True),
    (True, "-- 注释\n WITH c AS (SELECT 1) UPDATE t SET a=1", True),
    (True, "/* 注释 */ SELECT 1 FROM t", False),
    (True, "INSERT INTO t VALUES(1)", True),
    (True, "/*! DROP TABLE t */", True),
    (True, "SELECT a INTO OUTFILE '/tmp/x' FROM t", True),
    (True, "SELECT LOAD_FILE('/etc/passwd')", True),
    (False, "INSERT INTO t VALUES(1)", False),
    (False, "/* x */ WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c", False),
]


def main() -> int:
    fail = 0
    for ro, sql, want in CASES:
        got = would_block(ro, sql)
        ok = got == want
        if not ok:
            fail += 1
        print("%s  readOnly=%s want=%s got=%s  %r" % ("PASS" if ok else "FAIL", ro, want, got, sql[:58]))
    if fail:
        print("%d/%d FAILED" % (fail, len(CASES)))
        return 1
    print("ALL %d PASSED" % len(CASES))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
