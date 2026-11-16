"""Scope-aware row-limit planning for the relational db-proxy engines.

Product contract (fixed by the portal, not by datasource config):

* an unqualified read returns **at most 1000 rows** by default;
* an explicit ``LIMIT``/``FETCH FIRST``/``ROWNUM`` may raise that, but never
  beyond the **hard cap of 500000 rows**;
* the canvas SQL itself is never modified on the client — the server appends or
  clamps the limit only for the statement it is about to execute.

Everything here works on a *masked* copy of the SQL (comments, string literals
and quoted identifiers replaced by spaces at identical positions), so a
``LIMIT`` that only appears inside a comment/literal is never mistaken for a
real row limit, and an appended clause can never be swallowed by a trailing
``--`` comment.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Tuple

#: 默认返回行数（无显式上限时服务端追加）
DEFAULT_ROWS = 1000
#: 显式上限的硬上限
MAX_ROWS = 500_000

SELECT_START_RE = re.compile(r"^\s*(?:SELECT|WITH)\b", re.IGNORECASE)
MULTI_STATEMENT_TAIL_RE = re.compile(r"\S")


@dataclass(frozen=True)
class RowLimitPlan:
    """Result of planning the row limit for one statement."""

    sql: str
    limit: int
    #: 显式上限超过硬上限，已被改写为硬上限
    clamped: bool = False
    #: 服务端主动追加了行数限制
    appended: bool = False

    @property
    def rewritten(self) -> bool:
        return self.clamped or self.appended


def mask_sql(sql: str) -> str:
    """Return a same-length copy with comments, literals and quoted identifiers blanked.

    Positions are preserved one-to-one so callers can slice the original SQL with
    offsets found on the masked copy. Handles ``'..''..'``, backslash escapes,
    ``"..."``, `` `...` ``, ``--`` line comments, ``#`` line comments and
    ``/* ... */`` block comments.
    """
    chars = list(sql or "")
    i = 0
    n = len(chars)
    while i < n:
        ch = chars[i]
        if ch == "-" and i + 1 < n and chars[i + 1] == "-":
            j = sql.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                chars[k] = " "
            i = j
            continue
        if ch == "#":
            j = sql.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                chars[k] = " "
            i = j
            continue
        if ch == "/" and i + 1 < n and chars[i + 1] == "*":
            j = sql.find("*/", i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, min(j, n)):
                chars[k] = " "
            i = j
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            j = i + 1
            while j < n:
                if chars[j] == "\\" and quote == "'":
                    j += 2
                    continue
                if chars[j] == quote:
                    if j + 1 < n and chars[j + 1] == quote:
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            for k in range(i, min(j, n)):
                chars[k] = " "
            i = j
            continue
        i += 1
    return "".join(chars)


def clamp_int(value, fallback: int, minimum: int, maximum: int) -> int:
    """Coerce ``value`` into ``[minimum, maximum]``, falling back on garbage input."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


def effective_limits(default_limit=None, max_limit=None) -> Tuple[int, int]:
    """Normalise the configured pair into ``(default, cap)`` honouring the hard cap."""
    cap = clamp_int(max_limit, MAX_ROWS, 1, MAX_ROWS)
    default = clamp_int(default_limit, DEFAULT_ROWS, 1, cap)
    return default, cap


def _statement_bounds(masked: str) -> Tuple[int, int]:
    """Return ``(start, end)`` of the single statement, or ``(-1, -1)`` when multi-statement."""
    semi = masked.find(";")
    if semi < 0:
        return 0, len(masked)
    if MULTI_STATEMENT_TAIL_RE.search(masked[semi + 1:]):
        return -1, -1
    return 0, semi


def _top_level_mask(masked: str, start: int, end: int) -> str:
    """Blank out everything nested inside parentheses, keeping top-level text."""
    chars = list(masked[start:end])
    depth = 0
    for idx, ch in enumerate(chars):
        if ch == "(":
            depth += 1
            chars[idx] = " "
        elif ch == ")":
            depth = max(0, depth - 1)
            chars[idx] = " "
        elif depth > 0:
            chars[idx] = " "
    return "".join(chars)


def _literal_start(text: str, pattern: str, flags: int = 0) -> int:
    match = re.search(pattern, text, flags)
    return match.start() if match else -1


def _mysql_limit(top: str, start: int, sql: str, cap: int) -> Optional[RowLimitPlan]:
    """Handle MySQL/Doris ``LIMIT count`` / ``LIMIT offset, count`` / ``LIMIT count OFFSET n``."""
    matches = list(re.finditer(r"\bLIMIT\b", top, re.IGNORECASE))
    if not matches:
        return None
    match = matches[-1]
    tail = top[match.end():]
    offset = re.search(r"\bOFFSET\b", tail, re.IGNORECASE)
    expression = tail[: offset.start()] if offset else tail
    comma = expression.rfind(",")
    segment = expression[comma + 1:] if comma >= 0 else expression
    segment_base = match.end() + (comma + 1 if comma >= 0 else 0)
    literal = re.search(r"\d+", segment)
    if not literal:
        # 非常量表达式（绑定变量/函数）：无法安全改写，按硬上限有界读取
        return RowLimitPlan(sql=sql, limit=cap)
    count_text = literal.group(0)
    literal_start = start + segment_base + literal.start()
    count = int(count_text)
    if count > cap:
        return RowLimitPlan(
            sql=sql[:literal_start] + str(cap) + sql[literal_start + len(count_text):],
            limit=cap,
            clamped=True,
        )
    return RowLimitPlan(sql=sql, limit=max(1, count))


def _fetch_limit(top: str, start: int, sql: str, cap: int) -> Optional[RowLimitPlan]:
    """Handle Oracle 12c+ ``FETCH FIRST|NEXT n ROWS ONLY``."""
    match = None
    for candidate in re.finditer(r"\bFETCH\s+(?:FIRST|NEXT)\b", top, re.IGNORECASE):
        match = candidate
    if match is None:
        return None
    tail = top[match.end():]
    literal = re.search(r"\d+", tail)
    if not literal:
        return RowLimitPlan(sql=sql, limit=cap)
    count_text = literal.group(0)
    literal_start = start + match.end() + literal.start()
    count = int(count_text)
    if count > cap:
        return RowLimitPlan(
            sql=sql[:literal_start] + str(cap) + sql[literal_start + len(count_text):],
            limit=cap,
            clamped=True,
        )
    return RowLimitPlan(sql=sql, limit=max(1, count))


def _rownum_limit(top: str, start: int, sql: str, cap: int) -> Optional[RowLimitPlan]:
    """Handle Oracle 11g ``ROWNUM <= n`` / ``ROWNUM < n`` predicates."""
    match = None
    for candidate in re.finditer(r"\bROWNUM\s*(<=|<)\s*(\d+)", top, re.IGNORECASE):
        match = candidate
    if match is None:
        return None
    operator, count_text = match.group(1), match.group(2)
    count = int(count_text)
    literal_start = start + match.start(2)
    if count > cap:
        return RowLimitPlan(
            sql=sql[:literal_start] + str(cap) + sql[literal_start + len(count_text):],
            limit=cap,
            clamped=True,
        )
    returned = count if operator == "<=" else max(0, count - 1)
    return RowLimitPlan(sql=sql, limit=max(1, returned))


def plan_row_limit(
    sql: str,
    mode: str = "mysql",
    default_limit: int = DEFAULT_ROWS,
    max_limit: int = MAX_ROWS,
) -> RowLimitPlan:
    """Return the statement to execute plus the bounded read size.

    ``mode`` is ``mysql`` (MySQL/Doris/Impala ``LIMIT``), ``fetch`` (Oracle 12c+)
    or ``rownum`` (Oracle 11g). Non-``SELECT``/``WITH`` statements and
    multi-statement input are returned untouched — callers still bound their
    result read with ``plan.limit``.
    """
    default, cap = effective_limits(default_limit, max_limit)
    original = sql or ""
    masked = mask_sql(original)
    start, end = _statement_bounds(masked)
    if start < 0 or not SELECT_START_RE.match(masked[start:end]):
        return RowLimitPlan(sql=original, limit=default)

    top = _top_level_mask(masked, start, end)
    if mode == "fetch":
        detected = _fetch_limit(top, start, original, cap)
    elif mode == "rownum":
        detected = _rownum_limit(top, start, original, cap)
    else:
        detected = _mysql_limit(top, start, original, cap)
    if detected is not None:
        return detected

    # 无顶层显式上限：追加默认限制。换行分隔，避免被末尾 `-- 注释` 吞掉。
    body = original[:end].rstrip()
    suffix = original[end:]
    if mode == "fetch":
        return RowLimitPlan(
            sql=body + "\nFETCH FIRST %d ROWS ONLY" % default + suffix,
            limit=default,
            appended=True,
        )
    if mode == "rownum":
        return RowLimitPlan(
            sql="SELECT * FROM (\n" + body + "\n) WHERE ROWNUM <= %d" % default + suffix,
            limit=default,
            appended=True,
        )
    return RowLimitPlan(sql=body + "\nLIMIT %d" % default + suffix, limit=default, appended=True)


#: 语义化别名，便于调用点读成 action
apply_row_limit = plan_row_limit
