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
    from sqlglot.optimizer.scope import traverse_scope
except ImportError:  # pragma: no cover - optional until an Impala source is configured
    sqlglot = None  # type: ignore
    sg_exp = None  # type: ignore
    traverse_scope = None  # type: ignore

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
    logs.append("【类型校验】识别到待检查的表：%s。" % ("、".join((db + "." if db else "") + table for db, table in tables) or "无"))
    if not tables:
        logs.append("【类型校验】未识别到可检查的表，将继续执行原 SQL。")
    for db, table in tables:
        target = (db + "." if db else "") + table
        try:
            cols = describe_table(conn, db, table)
        except Exception as exc:
            logs.append("【类型校验】读取表结构失败：%s；原因：%s。" % (target, str(exc) or exc.__class__.__name__))
            continue
        if cols:
            schema[(db, table)] = cols
            logs.append("【类型校验】表结构读取成功：%s（%d 个字段）。" % (target, len(cols)))
        else:
            logs.append("【类型校验】未读取到表字段类型：%s。" % target)
    return schema


def _table_types(table: Any, schema: Dict[Tuple[str, str], Dict[str, str]]) -> Dict[str, TypeInfo]:
    name = str(table.name or "").lower()
    db = str(table.db or "").lower()
    matches = [
        cols for (schema_db, schema_table), cols in schema.items()
        if schema_table.lower() == name and (not db or schema_db.lower() == db)
    ]
    if len(matches) != 1:
        return {}
    return {col.lower(): normalize_type(typ) for col, typ in matches[0].items()}


def _scope_source_types(scope: Any, scope_types: Dict[Any, Dict[str, TypeInfo]], schema: Dict[Tuple[str, str], Dict[str, str]]) -> Dict[str, Dict[str, TypeInfo]]:
    sources: Dict[str, Dict[str, TypeInfo]] = {}
    for alias, (node, source) in scope.selected_sources.items():
        if isinstance(source, sg_exp.Table):
            types = _table_types(source, schema)
        else:
            types = scope_types.get(source, {})
        sources[str(alias).lower()] = types
    return sources


def _resolve_scoped_type(expr: Any, sources: Dict[str, Dict[str, TypeInfo]]) -> Optional[TypeInfo]:
    if sg_exp is None:
        return None
    if isinstance(expr, sg_exp.Column):
        name = str(expr.name or "").lower()
        table = str(expr.table or "").lower()
        if table:
            return sources.get(table, {}).get(name)
        candidates = [source[name] for source in sources.values() if name in source]
        return candidates[0] if len(candidates) == 1 else None
    if isinstance(expr, sg_exp.Cast):
        target = expr.args.get("to")
        if target is not None:
            return normalize_type(target.sql(dialect=SQL_DIALECT))
    return None


def _scope_output_types(scope: Any, sources: Dict[str, Dict[str, TypeInfo]]) -> Dict[str, TypeInfo]:
    output: Dict[str, List[TypeInfo]] = {}
    for projection in scope.expression.expressions:
        if isinstance(projection, sg_exp.Star) or (
            isinstance(projection, sg_exp.Column) and projection.name == "*"
        ):
            table = str(projection.table or "").lower() if isinstance(projection, sg_exp.Column) else ""
            if table:
                expanded = sources.get(table, {})
            else:
                candidates: Dict[str, List[TypeInfo]] = {}
                for source in sources.values():
                    for name, typ in source.items():
                        candidates.setdefault(name, []).append(typ)
                expanded = {name: types[0] for name, types in candidates.items() if len(types) == 1}
            for name, typ in expanded.items():
                output.setdefault(name, []).append(typ)
            continue
        name = str(projection.alias_or_name or "").lower()
        if not name:
            continue
        value = projection.this if isinstance(projection, sg_exp.Alias) else projection
        typ = _resolve_scoped_type(value, sources)
        if typ is not None:
            output.setdefault(name, []).append(typ)
    # Duplicate projected names are intentionally omitted: resolving them would be unsafe.
    return {name: types[0] for name, types in output.items() if len(types) == 1}


def _build_scope_types(tree: Any, schema: Dict[Tuple[str, str], Dict[str, str]]) -> Dict[Any, Dict[str, TypeInfo]]:
    scope_types: Dict[Any, Dict[str, TypeInfo]] = {}
    if traverse_scope is None:
        return scope_types
    # traverse_scope yields inner CTE/subquery SELECTs before their parent, so output
    # column types can flow outward without guessing from a global table-name map.
    for scope in traverse_scope(tree):
        sources = _scope_source_types(scope, scope_types, schema)
        scope_types[scope] = _scope_output_types(scope, sources)
    return scope_types


def _string_cast(expr: Any) -> Any:
    if isinstance(expr, sg_exp.Cast):
        target = expr.args.get("to")
        if target is not None and "STRING" in target.sql(dialect=SQL_DIALECT).upper():
            return expr
    return sg_exp.cast(expr.copy(), "STRING")


def _literal_fix(lit: Any, typ: TypeInfo) -> Tuple[Optional[Any], Optional[str]]:
    if typ.family == "num" and getattr(lit, "is_string", False):
        value = str(lit.name)
        if _INT_STRING_RE.match(value) or _NUM_STRING_RE.match(value):
            return sg_exp.Literal.number(value), "字符串字面量 %r 转为数值 %s" % (value, value)
    if typ.family == "str" and getattr(lit, "is_number", False) and not getattr(lit, "is_string", False):
        return sg_exp.Literal.string(str(lit.name)), "数值字面量 %s 转为字符串 '%s'" % (lit.name, lit.name)
    return None, None


def fix_sql_types(sql: str, schema: Dict[Tuple[str, str], Dict[str, str]], logs: List[str]) -> FixResult:
    if sqlglot is None or sg_exp is None:
        return FixResult(sql, 0, ["未安装 sqlglot，跳过字段类型校验"])
    try:
        tree = sqlglot.parse_one(sql, dialect=SQL_DIALECT)
    except Exception as exc:
        return FixResult(sql, 0, ["SQL 解析失败，跳过字段类型校验：%s" % (str(exc) or exc.__class__.__name__)])
    scope_types = _build_scope_types(tree, schema)
    scope_by_select = {id(scope.expression): scope for scope in scope_types}
    changes = 0
    warnings: List[str] = []
    comparison_types = (sg_exp.EQ, sg_exp.NEQ, sg_exp.LT, sg_exp.LTE, sg_exp.GT, sg_exp.GTE)
    for cls in comparison_types:
        for pred in tree.find_all(cls):
            select = pred.find_ancestor(sg_exp.Select)
            scope = scope_by_select.get(id(select)) if select is not None else None
            if scope is None:
                continue
            sources = _scope_source_types(scope, scope_types, schema)
            left, right = pred.this, pred.expression
            if isinstance(left, sg_exp.Column) and isinstance(right, sg_exp.Literal):
                col_type = _resolve_scoped_type(left, sources)
                new, reason = _literal_fix(right, col_type) if col_type else (None, None)
                if new is not None:
                    pred.set("expression", new)
                    changes += 1
                    logs.append("【类型校验】字段 %s 的类型为 %s，%s。" % (left.sql(dialect=SQL_DIALECT), col_type.raw, reason))
            elif isinstance(right, sg_exp.Column) and isinstance(left, sg_exp.Literal):
                col_type = _resolve_scoped_type(right, sources)
                new, reason = _literal_fix(left, col_type) if col_type else (None, None)
                if new is not None:
                    pred.set("this", new)
                    changes += 1
                    logs.append("【类型校验】字段 %s 的类型为 %s，%s。" % (right.sql(dialect=SQL_DIALECT), col_type.raw, reason))
            elif isinstance(left, sg_exp.Column) and isinstance(right, sg_exp.Column):
                lt, rt = _resolve_scoped_type(left, sources), _resolve_scoped_type(right, sources)
                if lt and rt and {lt.family, rt.family} == {"str", "num"}:
                    left_text = left.sql(dialect=SQL_DIALECT)
                    right_text = right.sql(dialect=SQL_DIALECT)
                    pred.set("this", _string_cast(left))
                    pred.set("expression", _string_cast(right))
                    changes += 1
                    logs.append("【类型校验】JOIN/比较字段 %s（%s）与 %s（%s）类型不一致，已将两侧统一转为 STRING。" % (left_text, lt.raw, right_text, rt.raw))
    for inn in tree.find_all(sg_exp.In):
        if not isinstance(inn.this, sg_exp.Column):
            continue
        select = inn.find_ancestor(sg_exp.Select)
        scope = scope_by_select.get(id(select)) if select is not None else None
        if scope is None:
            continue
        typ = _resolve_scoped_type(inn.this, _scope_source_types(scope, scope_types, schema))
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
                logs.append("【类型校验】字段 %s 的类型为 %s，%s。" % (inn.this.sql(dialect=SQL_DIALECT), typ.raw, reason))
            else:
                exprs.append(expr)
        if changed:
            inn.set("expressions", exprs)
    if not changes:
        logs.append("【类型校验】未发现可安全自动修正的字段类型问题，SQL 保持不变。")
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
            logs.append("【类型校验】已根据数据源配置关闭。")
            return sql, None
        schema = fetch_schema(conn, sql, logs)
        summary = schema_summary(schema) or None
        result = fix_sql_types(sql, schema, logs)
        logs.extend("【类型校验提示】" + x for x in result.warnings)
        if result.n_changes:
            logs.append("【类型校验】已修正 %d 处字段类型表达式。" % result.n_changes)
            logs.append("【类型校验修复后 SQL】\n" + result.fixed_sql)
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
            logs.append("【AI 修复】未安装 sqlglot，无法安全校验 AI 返回的 SQL，已跳过。")
            return None
        if attempt > self.ai.max_attempts:
            logs.append("【AI 修复】已达到最大重试次数，停止修复。")
            return None
        logs.append("【AI 修复】正在尝试修复（第 %d/%d 次）。" % (attempt, self.ai.max_attempts))
        body = {
            "model": self.ai.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": "Fix the Impala SQL with the smallest safe change. Preserve query intent, tables, filters, and projections; never change a read-only query to a write. For a type mismatch between two columns in a JOIN/comparison, cast both operands to STRING. Reply only with the complete SQL statement, without markdown or explanation."},
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
            logs.append("【AI 修复】请求失败：%s。" % (str(exc) or exc.__class__.__name__))
            return None
        if not fixed or fixed.strip() == sql.strip():
            logs.append("【AI 修复】未返回有效改动，保留原 SQL。")
            return None
        logs.append("【AI 修复建议 SQL】\n" + fixed)
        return fixed

    def status(self) -> Dict[str, Any]:
        return {
            "enabled": True,
            "driverAvailable": self.available,
            "typeCheck": self.type_check_available,
            "typeCheckConfigured": self.type_check_enabled,
            "aiFix": {"enabled": self.ai.enabled and sqlglot is not None, "configured": self.ai.enabled, "model": self.ai.model, "maxAttempts": self.ai.max_attempts},
        }
