# SQL 护栏:只读判定/多语句检测/表白名单/行数限制(原样迁出)

from __future__ import annotations
import re
from typing import List, Optional
from fastapi import HTTPException
from dbp_core import ALLOWED_TABLES, BACKTICK_TABLE_RE, DEFAULT_LIMIT, INVALID_LIMIT_RE, LIMIT_RE, MAX_LIMIT, TABLE_RE


READ_ONLY_SQL_RE = re.compile(
    r"^\s*(?:--[^\n]*\n\s*|/\*.*?\*/\s*)*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|WITH)\b",
    re.IGNORECASE | re.DOTALL,
)


def check_read_only_sql(sql: str) -> bool:
    """是否为查询类 SQL(SELECT/SHOW/DESC/EXPLAIN/WITH),用于区分查询/写执行路径。"""
    return bool(READ_ONLY_SQL_RE.match(sql))


def _strip_sql_literals(sql: str) -> str:
    """剥离注释与字符串字面量,用于语句/表名检查(避免字符串里的 FROM/JOIN/分号被误判)。"""
    s = re.sub(r"--[^\n]*|/\*[\s\S]*?\*/", "", sql)
    s = re.sub(r"'[^']*'", "''", s)
    s = re.sub(r'"[^"]*"', '""', s)
    return s


def check_single_statement(sql: str) -> None:
    """多语句注入防护:拒绝包含多个分号分隔语句的 SQL。
    允许末尾一个结尾分号(如 'SELECT 1;'),其余分号视为多语句。
    先剥离字符串/注释,避免 'SELECT \'a;b\'' 被误判。"""
    s = _strip_sql_literals(sql).strip()
    # 去掉末尾分号后,若仍含分号 → 多语句
    body = s.rstrip(";").rstrip()
    if ";" in body:
        raise HTTPException(
            status_code=403,
            detail="multiple statements not allowed",
        )


def check_tables_allowed(sql: str) -> None:
    """表级白名单:从 SQL 提取表名,不在白名单拒绝。"""
    if not ALLOWED_TABLES:
        return
    # 提取用剥离字符串/注释后的 SQL,避免 'from xxx' 字符串被误提取
    clean = _strip_sql_literals(sql)
    names: List[str] = []
    seen = set()

    def _add(n: Optional[str]) -> None:
        n = (n or "").replace("`", "").strip()
        if not n or n in seen:
            return
        seen.add(n)
        names.append(n)

    for m in TABLE_RE.finditer(clean):
        # 反引号双段 `db`.`tbl` → 拼完整名;单段/普通名取对应组
        if m.group(1) and m.group(2):
            _add(f"{m.group(1)}.{m.group(2)}")
        else:
            _add(m.group(3) or m.group(4))
    for m in BACKTICK_TABLE_RE.finditer(clean):
        if m.group(1) and m.group(2):
            _add(f"{m.group(1)}.{m.group(2)}")
        elif m.group(3) and m.group(4):
            _add(f"{m.group(3)}.{m.group(4)}")
    # 完整名(含 .)优先判定;裸名中若是某个完整名的库前缀,不单独判定(避免误拒)
    full_names = [t for t in names if "." in t]
    db_prefixes = {f.split(".", 1)[0] for f in full_names}
    bare_extra = [t for t in names if "." not in t and t not in db_prefixes]
    for table in full_names + bare_extra:
        bare = table.split(".", 1)[-1]
        # 支持 "库.表" 完整名或裸表名,任一匹配即通过
        if table in ALLOWED_TABLES or bare in ALLOWED_TABLES:
            continue
        raise HTTPException(
            status_code=403,
            detail=f"table '{table}' not in ALLOWED_TABLES",
        )


def enforce_limit(sql: str) -> int:
    """提取行数上限:MySQL LIMIT(含 offset,count)/ Oracle FETCH FIRST / ROWNUM。
    在剥离字符串/注释后的文本上匹配,防字面量误判;LIMIT 负数直接拒绝。"""
    clean = _strip_sql_literals(sql)
    if INVALID_LIMIT_RE.search(clean):
        raise HTTPException(status_code=400, detail="LIMIT 不接受负数或带符号数值,请使用正整数")
    m = LIMIT_RE.search(clean)
    if m:
        # LIMIT offset,count → 取 count(行数);其他形态取首个数字
        limit = int(m.group(2) or m.group(1) or m.group(3) or m.group(4))
        if limit > MAX_LIMIT:
            raise HTTPException(
                status_code=400, detail=f"row limit exceeds MAX_LIMIT({MAX_LIMIT})"
            )
        return limit
    return DEFAULT_LIMIT


def append_row_limit(sql: str, limit: int, row_limit: str) -> str:
    """按数据源的行数限制模式追加语法:
    - mysql:  SELECT ... LIMIT n
    - fetch:  SELECT ... FETCH FIRST n ROWS ONLY(12c+)
    - rownum: SELECT * FROM (SELECT ...) WHERE ROWNUM <= n(11g)
    """
    if row_limit == "rownum":
        return f"SELECT * FROM ({sql}) WHERE ROWNUM <= {limit}"
    if row_limit == "fetch":
        return f"{sql} FETCH FIRST {limit} ROWS ONLY"
    return f"{sql} LIMIT {limit}"
