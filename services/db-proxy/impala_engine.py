"""Impala execution helpers shared by the db-proxy HTTP endpoints.

The original implementation lives in ``new_stingray/tmp/impala_query.py`` as a
CLI.  This module keeps its useful parts (DESCRIBE driven literal fixes and
optional AI retries) free of CLI/stdout concerns so the portal can return
diagnostics with the query result.
"""

from __future__ import annotations

import json
import random
import re
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

try:
    import sqlglot
    from sqlglot import exp as sg_exp
except ImportError:  # pragma: no cover - optional until an Impala source is configured
    sqlglot = None  # type: ignore
    sg_exp = None  # type: ignore

try:
    from impala.dbapi import connect as impyla_connect
except ImportError:  # pragma: no cover - optional until an Impala source is configured
    impyla_connect = None  # type: ignore


SQL_DIALECT = "hive"
_NUM_WIDTH = {
    "tinyint": 0,
    "smallint": 1,
    "int": 2,
    "integer": 2,
    "bigint": 3,
    "float": 4,
    "double": 5,
    "decimal": 6,
}
_STR_WIDTH = {"char": 0, "varchar": 1, "string": 2}
_TYPE_TOKENS = frozenset(
    {
        "char", "varchar", "string", "boolean", "bool", "tinyint", "smallint",
        "int", "integer", "bigint", "float", "double", "decimal", "timestamp",
        "date", "array", "struct", "map",
    }
)
_INT_STRING_RE = re.compile(r"^[+-]?\d+$")
_NUM_STRING_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


@dataclass(frozen=True)
class TypeInfo:
    family: str
    width: int
    raw: str


@dataclass
class FixResult:
    fixed_sql: str
    n_changes: int
    warnings: List[str]


@dataclass
class AiConfig:
    enabled: bool = False
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    timeout: int = 60
    max_attempts: int = 3


def _bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _ai_config(cfg: Dict[str, Any]) -> AiConfig:
    raw = cfg.get("aiFix") or cfg.get("ai") or {}
    if not isinstance(raw, dict):
        return AiConfig()
    try:
        timeout = max(1, int(raw.get("timeout", 60)))
    except (TypeError, ValueError):
        timeout = 60
    try:
        attempts = max(0, min(5, int(raw.get("maxAttempts", 3))))
    except (TypeError, ValueError):
        attempts = 3
    base = str(raw.get("baseUrl", raw.get("base_url", "")) or "").strip().rstrip("/")
    key = str(raw.get("apiKey", raw.get("api_key", "")) or "").strip()
    return AiConfig(
        enabled=_bool(raw.get("enabled"), False) and bool(base and key),
        base_url=base,
        api_key=key,
        model=str(raw.get("model", "") or "").strip(),
        timeout=timeout,
        max_attempts=attempts,
    )


def normalize_type(type_str: str) -> TypeInfo:
    raw = (type_str or "").strip().lower()
    base = raw.split("(", 1)[0].split("<", 1)[0].strip()
    if base in _STR_WIDTH:
        return TypeInfo("str", _STR_WIDTH[base], raw)
    if base in _NUM_WIDTH:
        return TypeInfo("num", _NUM_WIDTH[base], raw)
    if base in ("boolean", "bool"):
        return TypeInfo("bool", 0, raw)
    return TypeInfo("other", 0, raw)


def _looks_like_type(token: str) -> bool:
    base = (token or "").strip().lower().split("(", 1)[0].split("<", 1)[0].strip()
    return base in _TYPE_TOKENS


def extract_tables(sql: str) -> List[Tuple[str, str]]:
    if sqlglot is None or sg_exp is None:
        return []
    try:
        tree = sqlglot.parse_one(sql, dialect=SQL_DIALECT)
    except Exception:
        return []
    if tree is None:
        return []
    ctes = {str(x.alias).lower() for x in tree.find_all(sg_exp.CTE) if x.alias}
    out: List[Tuple[str, str]] = []
    seen = set()
    for table in tree.find_all(sg_exp.Table):
        name = str(table.name or "").lower()
        db = str(table.db or "").lower()
        if not name or (not db and name in ctes):
            continue
        key = (db, name)
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


def _parse_describe_rows(rows: List[Any]) -> Optional[Dict[str, str]]:
    if not rows:
        return None
    cols: Dict[str, str] = {}
    start = 1 if str(rows[0][0] if rows[0] else "").strip().lower() in {"col_name", "name", "# col_name"} else 0
    for row in rows[start:]:
        if not row:
            continue
        cells = [str(c).strip() if c is not None else "" for c in row]
        if not cells or not cells[0] or cells[0].startswith("#"):
            continue
        if len(cells) >= 2 and _looks_like_type(cells[1]):
            cols[cells[0].lower()] = cells[1]
        elif len(cells) >= 3 and _looks_like_type(cells[2]):
            cols[cells[0].lower()] = cells[2]
    return cols or None


def _parse_describe_formatted(rows: List[Any]) -> Optional[Dict[str, str]]:
    cols: Dict[str, str] = {}
    current = None
    for row in rows:
        text = " ".join(str(c) for c in row if c is not None)
        if "Column Name:" in text:
            current = text.split("Column Name:", 1)[1].strip()
        elif current and "Type:" in text:
            typ = text.split("Type:", 1)[1].strip()
            if typ:
                cols[current.lower()] = typ
            current = None
    return cols or None


def describe_table(conn: Any, db: str, table: str) -> Optional[Dict[str, str]]:
    target = (db + "." if db else "") + table
    cur = conn.cursor()
    cur.execute("DESCRIBE " + target)
    rows = list(cur.fetchall())
    cols = _parse_describe_rows(rows)
    if cols is None:
        cur.execute("DESCRIBE FORMATTED " + target)
        cols = _parse_describe_formatted(list(cur.fetchall()))
    try:
        cur.close()
    except Exception:
        pass
    return cols


def fetch_schema(conn: Any, sql: str, logs: List[str]) -> Dict[Tuple[str, str], Dict[str, str]]:
    schema: Dict[Tuple[str, str], Dict[str, str]] = {}
    tables = extract_tables(sql)
    logs.append("[type-check] tables: " + repr(tables))
    if not tables:
        logs.append("[type-check] no tables resolved; original SQL will run")
    for db, table in tables:
        target = (db + "." if db else "") + table
        try:
            cols = describe_table(conn, db, table)
        except Exception as exc:
            logs.append("[type-check] DESCRIBE %s failed: %s" % (target, str(exc) or exc.__class__.__name__))
            continue
        if cols:
            schema[(db, table)] = cols
            logs.append("[type-check] DESCRIBE %s -> %d column(s)" % (target, len(cols)))
        else:
            logs.append("[type-check] DESCRIBE %s returned no types" % target)
    return schema


def _alias_map(tree: Any) -> Dict[str, Tuple[str, str]]:
    ctes = {str(x.alias).lower() for x in tree.find_all(sg_exp.CTE) if x.alias}
    out: Dict[str, Tuple[str, str]] = {}
    for table in tree.find_all(sg_exp.Table):
        name = str(table.name or "").lower()
        db = str(table.db or "").lower()
        if not name or (not db and name in ctes):
            continue
        key = (db, name)
        alias = str(table.alias or name).lower()
        out[alias] = key
        out.setdefault(name, key)
    return out


def _resolve_col(col: Any, aliases: Dict[str, Tuple[str, str]], schema: Dict[Tuple[str, str], Dict[str, str]]) -> Optional[TypeInfo]:
    if sg_exp is None or not isinstance(col, sg_exp.Column):
        return None
    name = str(col.name or "").lower()
    table = str(col.table or "").lower()
    candidates: List[Dict[str, str]] = []
    if table and table in aliases:
        key = aliases[table]
        candidates = [v for k, v in schema.items() if k[0].lower() == key[0] and k[1].lower() == key[1]]
    elif not table:
        candidates = [cols for cols in schema.values() if name in cols]
    if len(candidates) == 1 and name in candidates[0]:
        return normalize_type(candidates[0][name])
    return None


def _literal_fix(lit: Any, typ: TypeInfo) -> Tuple[Optional[Any], Optional[str]]:
    if typ.family == "num" and getattr(lit, "is_string", False):
        value = str(lit.name)
        if _INT_STRING_RE.match(value) or _NUM_STRING_RE.match(value):
            return sg_exp.Literal.number(value), "string literal %r -> numeric %s" % (value, value)
    if typ.family == "str" and getattr(lit, "is_number", False) and not getattr(lit, "is_string", False):
        return sg_exp.Literal.string(str(lit.name)), "numeric literal %s -> string '%s'" % (lit.name, lit.name)
    return None, None


def fix_sql_types(sql: str, schema: Dict[Tuple[str, str], Dict[str, str]], logs: List[str]) -> FixResult:
    if sqlglot is None or sg_exp is None:
        return FixResult(sql, 0, ["sqlglot is not installed"])
    try:
        tree = sqlglot.parse_one(sql, dialect=SQL_DIALECT)
    except Exception as exc:
        return FixResult(sql, 0, ["parse skipped: %s" % (str(exc) or exc.__class__.__name__)])
    aliases = _alias_map(tree)
    changes = 0
    warnings: List[str] = []
    comparison_types = (sg_exp.EQ, sg_exp.NEQ, sg_exp.LT, sg_exp.LTE, sg_exp.GT, sg_exp.GTE)
    for cls in comparison_types:
        for pred in tree.find_all(cls):
            left, right = pred.this, pred.expression
            if isinstance(left, sg_exp.Column) and isinstance(right, sg_exp.Literal):
                new, reason = _literal_fix(right, _resolve_col(left, aliases, schema)) if _resolve_col(left, aliases, schema) else (None, None)
                if new is not None:
                    pred.set("expression", new)
                    changes += 1
                    logs.append("[type-fix] %s" % reason)
            elif isinstance(right, sg_exp.Column) and isinstance(left, sg_exp.Literal):
                new, reason = _literal_fix(left, _resolve_col(right, aliases, schema)) if _resolve_col(right, aliases, schema) else (None, None)
                if new is not None:
                    pred.set("this", new)
                    changes += 1
                    logs.append("[type-fix] %s" % reason)
            elif isinstance(left, sg_exp.Column) and isinstance(right, sg_exp.Column):
                lt, rt = _resolve_col(left, aliases, schema), _resolve_col(right, aliases, schema)
                if lt and rt and {lt.family, rt.family} == {"str", "num"}:
                    if lt.family == "num" and not isinstance(left, sg_exp.Cast):
                        pred.set("this", sg_exp.cast(left.copy(), "STRING"))
                        changes += 1
                        logs.append("[type-fix] cast numeric comparison column to STRING")
                    elif rt.family == "num" and not isinstance(right, sg_exp.Cast):
                        pred.set("expression", sg_exp.cast(right.copy(), "STRING"))
                        changes += 1
                        logs.append("[type-fix] cast numeric comparison column to STRING")
    for inn in tree.find_all(sg_exp.In):
        if not isinstance(inn.this, sg_exp.Column):
            continue
        typ = _resolve_col(inn.this, aliases, schema)
        if not typ:
            continue
        exprs = []
        changed = False
        for expr in list(inn.expressions):
            new, reason = _literal_fix(expr, typ) if isinstance(expr, sg_exp.Literal) else (None, None)
            if new is not None:
                exprs.append(new)
                changed = True
                changes += 1
                logs.append("[type-fix] %s" % reason)
            else:
                exprs.append(expr)
        if changed:
            inn.set("expressions", exprs)
    if not changes:
        logs.append("[type-fix] no safe rewrite")
        return FixResult(sql, 0, warnings)
    return FixResult(tree.sql(dialect=SQL_DIALECT), changes, warnings)


def schema_summary(schema: Dict[Tuple[str, str], Dict[str, str]]) -> str:
    lines = []
    for (db, table), cols in sorted(schema.items()):
        prefix = (db + "." if db else "") + table
        lines.extend("%s.%s:%s" % (prefix, col, typ) for col, typ in sorted(cols.items()))
    return "\n".join(lines)


def _extract_sql(text: str) -> Optional[str]:
    value = (text or "").strip()
    if value.startswith("```"):
        lines = value.splitlines()[1:]
        if lines and lines[-1].strip() == "```":
            lines.pop()
        value = "\n".join(lines).strip()
    if not value:
        return None
    first = value.split(None, 1)[0].upper()
    return value if first in {"SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "SHOW", "DESC", "DESCRIBE", "EXPLAIN"} else None


class ImpalaEngine:
    def __init__(self, cfg: Optional[Dict[str, Any]] = None) -> None:
        self.cfg = cfg or {}
        self.type_check_enabled = _bool((self.cfg.get("typeCheck") or {}).get("enabled"), True)
        self.ai = _ai_config(self.cfg)

    @property
    def available(self) -> bool:
        return impyla_connect is not None

    @property
    def type_check_available(self) -> bool:
        return self.type_check_enabled and sqlglot is not None and sg_exp is not None

    def connect(self, host: str, port: int, user: str, password: str, database: str, connect_timeout: int, query_timeout: int):
        if impyla_connect is None:
            raise RuntimeError("impyla is not installed; install services/db-proxy/requirements.txt")
        hosts = [x.strip() for x in str(host).split(",") if x.strip()]
        if not hosts:
            raise ValueError("Impala hosts is empty")
        return impyla_connect(
            host=random.choice(hosts),
            port=port,
            user=user,
            password=password,
            database=database or None,
            timeout=query_timeout or connect_timeout,
            auth_mechanism=str(self.cfg.get("authMechanism", "PLAIN")),
        )

    def prepare_sql(self, conn: Any, sql: str, logs: List[str]) -> Tuple[str, Optional[str]]:
        if not self.type_check_enabled:
            logs.append("[type-check] disabled by config")
            return sql, None
        schema = fetch_schema(conn, sql, logs)
        summary = schema_summary(schema) or None
        result = fix_sql_types(sql, schema, logs)
        logs.extend("[type-check] warning: " + x for x in result.warnings)
        if result.n_changes:
            logs.append("[type-fix] rewrote %d expression(s)" % result.n_changes)
            logs.append("[type-fix] SQL: " + result.fixed_sql)
            return result.fixed_sql, summary
        return sql, summary

    def is_read_only_sql(self, sql: str) -> bool:
        if sqlglot is None or sg_exp is None:
            return False
        try:
            statements = sqlglot.parse(sql, dialect=SQL_DIALECT)
        except Exception:
            return False
        if len(statements) != 1 or statements[0] is None:
            return False
        tree = statements[0]
        query_type = getattr(sg_exp, "Query", None)
        if query_type is None or not isinstance(tree, query_type):
            return False
        forbidden = (sg_exp.Insert, sg_exp.Update, sg_exp.Delete, sg_exp.Create, sg_exp.Drop, sg_exp.Alter)
        return all(next(tree.find_all(kind), None) is None for kind in forbidden)

    def rewrite_sql(self, sql: str, error: str, schema: Optional[str], logs: List[str], attempt: int) -> Optional[str]:
        if not self.ai.enabled:
            return None
        if sqlglot is None or sg_exp is None:
            logs.append("[ai-fix] skipped: sqlglot is required to validate rewritten SQL")
            return None
        if attempt > self.ai.max_attempts:
            logs.append("[ai-fix] retry limit reached")
            return None
        logs.append("[ai-fix] attempt %d/%d: %s" % (attempt, self.ai.max_attempts, error[:500]))
        body = {
            "model": self.ai.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": "Fix the Impala SQL with the smallest safe change. Preserve query intent, tables, filters, and projections; never change a read-only query to a write. Reply only with the complete SQL statement, without markdown or explanation."},
                {"role": "user", "content": "Error:\n%s\n\nSQL:\n%s\n\nSchema:\n%s" % (error, sql, schema or "(schema unavailable)")},
            ],
        }
        req = urllib.request.Request(
            self.ai.base_url + "/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.ai.api_key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.ai.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            content = payload["choices"][0]["message"]["content"]
            fixed = _extract_sql(content)
        except Exception as exc:
            logs.append("[ai-fix] unavailable: %s" % (str(exc) or exc.__class__.__name__))
            return None
        if not fixed or fixed.strip() == sql.strip():
            logs.append("[ai-fix] model returned no usable change")
            return None
        logs.append("[ai-fix] proposed SQL: " + fixed)
        return fixed

    def status(self) -> Dict[str, Any]:
        return {
            "enabled": True,
            "driverAvailable": self.available,
            "typeCheck": self.type_check_available,
            "typeCheckConfigured": self.type_check_enabled,
            "aiFix": {"enabled": self.ai.enabled and sqlglot is not None, "configured": self.ai.enabled, "model": self.ai.model, "maxAttempts": self.ai.max_attempts},
        }
