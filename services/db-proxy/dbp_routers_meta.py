# 路由:/tables /fields /ddl /schema /explain 元数据+执行计划(APIRouter,路径不变)
# 装饰器由 @app.* 改为 @router.*(include_router 挂载,路径与行为零变化)

from __future__ import annotations
import json
import re
from typing import Any, Dict, Generator, List, Optional
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from dbp_core import DB_CONNECT_TIMEOUT, MAX_CONCURRENT, QUERY_TIMEOUT, _TABLE_NAME_RE, _check_qps, _query_semaphore, check_db_allowed, require_auth
from dbp_datasources import get_datasource
from dbp_dbaccess import _extract_sql_error, _prepare_query
from dbp_routers_core import query

router = APIRouter()


# ── 表目录(库→表→字段,只读元数据)────────────────────────────
def _meta_guard(x_db_token: Optional[str] = Header(default=None)) -> Generator[None, None, None]:
    """元数据接口资源护栏(fastapi dependency):**先鉴权再计并发** —— 依赖先于路由函数体
    执行,若未鉴权先占信号量,未认证请求可耗尽共享并发/QPS 窗口反向打挂已认证用户;
    鉴权通过后复用并发信号量 + QPS 限速(与 /query、/jobs 同一套护栏)。"""
    require_auth(x_db_token)
    if not _query_semaphore.acquire(blocking=False):
        raise HTTPException(status_code=429, detail=f"too many concurrent requests (max={MAX_CONCURRENT})")
    try:
        _check_qps()
    except Exception:
        _query_semaphore.release()
        raise
    try:
        yield
    finally:
        _query_semaphore.release()


@router.get("/tables")
def tables(
    db: str,
    detail: int = 0,
    timeoutMs: int = 0,
    x_db_token: Optional[str] = Header(default=None),
    _g: None = Depends(_meta_guard),
) -> Dict[str, Any]:
    """表列表。detail=1 时返回 [{name, comment}](含表注释),否则保持 string[] 兼容旧调用。"""
    require_auth(x_db_token)
    check_db_allowed(db)
    ds = get_datasource(db)
    q_timeout = int(timeoutMs / 1000) if timeoutMs else QUERY_TIMEOUT
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            cur.execute("SHOW TABLE STATUS")
            rows = cur.fetchall()
            items = [
                {
                    "name": str(d.get("Name", list(d.values())[0])),
                    "comment": str(d.get("Comment", "") or ""),
                }
                for d in rows
            ]
        else:
            # 当前用户 schema 下表 + 注释(Oracle 注释可为 NULL → 空串)
            cur.execute(
                "SELECT t.table_name, c.comments FROM user_tables t "
                "LEFT JOIN user_tab_comments c ON t.table_name = c.table_name "
                "ORDER BY t.table_name"
            )
            rows = cur.fetchall()
            items = [{"name": r[0], "comment": str(r[1] or "")} for r in rows]
        cur.close()
    finally:
        conn.close()
    if detail:
        return {"code": 0, "data": items}
    return {"code": 0, "data": [i["name"] for i in items]}


@router.get("/fields")
def fields(
    db: str,
    table: str,
    detail: int = 0,
    timeoutMs: int = 0,
    x_db_token: Optional[str] = Header(default=None),
    _g: None = Depends(_meta_guard),
) -> Dict[str, Any]:
    """字段列表。detail=1 时返回完整元数据 [{name,type,comment,nullable,key}],
    否则保持 [{name,type}] 兼容旧调用。
    注意:Oracle 列默认值 data_default 是 LONG 类型,驱动读取有风险,P0 不取。"""
    require_auth(x_db_token)
    check_db_allowed(db)
    if not _TABLE_NAME_RE.match(table or ""):
        raise HTTPException(status_code=400, detail="非法表名")
    ds = get_datasource(db)
    q_timeout = int(timeoutMs / 1000) if timeoutMs else QUERY_TIMEOUT
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            cur.execute(f"SHOW FULL COLUMNS FROM `{table}`")
            rows = cur.fetchall()
            cols = []
            for r in rows:
                d = r if hasattr(r, "items") else {}
                base = {"name": d.get("Field"), "type": d.get("Type")}
                if detail:
                    base.update(
                        {
                            "comment": str(d.get("Comment", "") or ""),
                            "nullable": str(d.get("Null", "")).upper() == "YES",
                            "key": str(d.get("Key", "") or ""),
                            "default": d.get("Default"),
                        }
                    )
                cols.append(base)
        else:
            # 主键列集合(约束型 P)
            pk_set = set()
            cur.execute(
                "SELECT cc.column_name FROM user_cons_columns cc "
                "JOIN user_constraints c ON cc.constraint_name = c.constraint_name "
                "WHERE c.constraint_type = 'P' AND c.table_name = :t",
                {"t": table.upper()},
            )
            for r in cur.fetchall():
                pk_set.add(str(r[0]).upper())
            cur.execute(
                "SELECT column_name, data_type, nullable FROM user_tab_columns "
                "WHERE table_name = :t ORDER BY column_id",
                {"t": table.upper()},
            )
            rows = cur.fetchall()
            col_meta = {r[0]: (r[1], r[2]) for r in rows}
            cur.execute(
                "SELECT column_name, comments FROM user_col_comments WHERE table_name = :t",
                {"t": table.upper()},
            )
            comments = {r[0]: str(r[1] or "") for r in cur.fetchall()}
            cols = []
            for name, (data_type, nullable) in col_meta.items():
                base = {"name": name, "type": data_type}
                if detail:
                    base.update(
                        {
                            "comment": comments.get(name, ""),
                            "nullable": str(nullable).upper() == "Y",
                            "key": "PRI" if str(name).upper() in pk_set else "",
                        }
                    )
                cols.append(base)
        cur.close()
    finally:
        conn.close()
    return {"code": 0, "data": cols}


@router.get("/ddl")
def ddl(
    db: str,
    table: str,
    timeoutMs: int = 0,
    x_db_token: Optional[str] = Header(default=None),
    _g: None = Depends(_meta_guard),
) -> Dict[str, Any]:
    """生成建表 DDL:MySQL SHOW CREATE TABLE / Oracle DBMS_METADATA.GET_DDL。
    需数据源账号具备读取 DDL 的权限(SHOW VIEW / EXECUTE_CATALOG_ROLE),失败返回友好错误。"""
    require_auth(x_db_token)
    check_db_allowed(db)
    if not _TABLE_NAME_RE.match(table or ""):
        raise HTTPException(status_code=400, detail="非法表名")
    ds = get_datasource(db)
    q_timeout = int(timeoutMs / 1000) if timeoutMs else QUERY_TIMEOUT
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            cur.execute(f"SHOW CREATE TABLE `{table}`")
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail=f"table '{table}' not found")
            d = {k: v for k, v in row.items()} if hasattr(row, "items") else {}
            ddl_text = str(d.get("Create Table") or (row[1] if len(row) > 1 else "") or "")
        else:
            cur.execute(
                "SELECT DBMS_METADATA.GET_DDL('TABLE', :t) FROM dual",
                {"t": table.upper()},
            )
            row = cur.fetchone()
            ddl_text = str(row[0]) if row and row[0] else ""
        cur.close()
    except HTTPException:
        raise
    except Exception as e:
        de = _extract_sql_error(e, ds.type)
        raise HTTPException(
            status_code=502,
            detail=f"failed to generate DDL (需要账号有 SHOW VIEW / EXECUTE_CATALOG_ROLE 权限): {de.message}",
        )
    finally:
        conn.close()
    return {"code": 0, "data": {"name": table, "ddl": ddl_text}}


# ── Schema 补全(/schema:全量表+字段扁平元数据)────────────────
SCHEMA_MAX_TABLES = 800


@router.get("/schema")
def schema(
    db: str,
    timeoutMs: int = 30000,
    x_db_token: Optional[str] = Header(default=None),
    _g: None = Depends(_meta_guard),
) -> Dict[str, Any]:
    """一次性返回该数据源全部表+字段的扁平元数据(供前端 SQL 编辑器补全)。

    - MySQL/Doris(走 mysql 协议):information_schema.tables/columns;table_schema 取
      连接库(ds.service,与 /tables 的 SHOW TABLE STATUS 一致),而非请求参数 db
    - Oracle:all_tables(OWNER=当前用户)+ all_tab_comments + all_tab_columns
    表数 > 800 只返回前 800 张并在 data.truncated=true。"""
    require_auth(x_db_token)
    check_db_allowed(db)
    ds = get_datasource(db)
    q_timeout = max(1, int(timeoutMs / 1000)) if timeoutMs else QUERY_TIMEOUT
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            # Doris 通过 mysql 协议直连,information_schema 一致
            cur.execute(
                "SELECT table_name, table_comment FROM information_schema.tables "
                "WHERE table_schema = %s ORDER BY table_name",
                (ds.service,),
            )
            table_rows = cur.fetchall()
            cur.execute(
                "SELECT table_name, column_name, column_type FROM information_schema.columns "
                "WHERE table_schema = %s ORDER BY table_name, ordinal_position",
                (ds.service,),
            )
            col_rows = cur.fetchall()
            tables: List[Dict[str, Any]] = []
            for t in table_rows:
                d = t if hasattr(t, "items") else {"table_name": t[0], "table_comment": t[1] if len(t) > 1 else None}
                tables.append(
                    {
                        "name": str(d.get("table_name") or ""),
                        "comment": str(d.get("table_comment") or ""),
                        "columns": [],
                    }
                )
            by_name = {t["name"]: t for t in tables}
            for c in col_rows:
                d = c if hasattr(c, "items") else {"table_name": c[0], "column_name": c[1], "column_type": c[2] if len(c) > 2 else ""}
                t = by_name.get(str(d.get("table_name") or ""))
                if t is not None:
                    t["columns"].append(
                        {"name": str(d.get("column_name") or ""), "type": str(d.get("column_type") or "")}
                    )
        else:
            cur.execute(
                "SELECT t.table_name, c.comments FROM all_tables t "
                "LEFT JOIN all_tab_comments c ON t.owner = c.owner AND t.table_name = c.table_name "
                "WHERE t.owner = (SELECT user FROM dual) ORDER BY t.table_name"
            )
            table_rows = cur.fetchall()
            cur.execute(
                "SELECT table_name, column_name, data_type FROM all_tab_columns "
                "WHERE owner = (SELECT user FROM dual) ORDER BY table_name, column_id"
            )
            col_rows = cur.fetchall()
            tables = [{"name": str(r[0] or ""), "comment": str(r[1] or ""), "columns": []} for r in table_rows]
            by_name = {t["name"]: t for t in tables}
            for c in col_rows:
                t = by_name.get(str(c[0] or ""))
                if t is not None:
                    t["columns"].append({"name": str(c[1] or ""), "type": str(c[2] or "")})
        cur.close()
    except HTTPException:
        raise
    except Exception as e:
        de = _extract_sql_error(e, ds.type)
        raise HTTPException(status_code=502, detail=f"failed to load schema: {de.message}")
    finally:
        conn.close()
    truncated = len(tables) > SCHEMA_MAX_TABLES
    if truncated:
        tables = tables[:SCHEMA_MAX_TABLES]
    return {"code": 0, "data": {"tables": tables, "truncated": truncated, "engine": ds.type}}


# ── EXPLAIN 可视化(/explain)────────────────────────────────
_EXPLAIN_OP_KEYS = (
    "query_block",
    "ordering_operation",
    "grouping_operation",
    "duplicates_removal",
    "table",
    "union_result",
    "materialized_from_subquery",
    "windowing",
    "partition",
    "aggregate",
    "first_row",
    "second_row",
    "insert_from_query",
    "update",
    "insert",
    "delete",
    "replace",
    "updating_table",
    "inserting_table",
    "deleting_table",
)


def _mysql_explain_cost(inner: Dict[str, Any]) -> Optional[Any]:
    """从 cost_info 提取成本:total_cost 优先(任务要求),MySQL 真实输出中
    table 节点只有 prefix_cost / query_block 只有 query_cost,依次回退。"""
    ci = inner.get("cost_info")
    if not isinstance(ci, dict):
        return None
    return ci.get("total_cost") or ci.get("prefix_cost") or ci.get("query_cost")


def _mysql_explain_operation(inner: Dict[str, Any]) -> Dict[str, Any]:
    """非 table 的操作节点(ordering/grouping/windowing 等):保留 operation readable 文本。"""
    node: Dict[str, Any] = {
        "operation": inner.get("readable") or inner.get("operation") or "",
        "rows": inner.get("rows"),
        "cost": _mysql_explain_cost(inner),
    }
    extra = []
    if inner.get("using_filesort"):
        extra.append("filesort")
    if inner.get("using_temporary_table"):
        extra.append("temporary table")
    node["extra"] = "; ".join(extra) or None
    return node


def _mysql_explain_table(inner: Dict[str, Any]) -> Dict[str, Any]:
    """table 节点:name/access_type/rows/filtered/cost/extra + readable 作为 operation。"""
    node: Dict[str, Any] = {
        "name": str(inner.get("table_name") or ""),
        "access_type": inner.get("access_type"),
        "rows": inner.get("rows"),
        "filtered": inner.get("filtered"),
        "cost": _mysql_explain_cost(inner),
        "operation": inner.get("readable") or "",
    }
    extra = []
    pk = inner.get("possible_keys")
    if pk:
        extra.append("possible_keys: " + (", ".join(pk) if isinstance(pk, list) else str(pk)))
    if inner.get("key"):
        extra.append("key: " + str(inner.get("key")))
    if inner.get("ref"):
        extra.append("ref: " + str(inner.get("ref")))
    if inner.get("attached_condition"):
        extra.append("attached_condition: " + str(inner.get("attached_condition")))
    uc = inner.get("used_columns")
    if uc:
        extra.append("used_columns: " + (", ".join(uc) if isinstance(uc, list) else str(uc)))
    node["extra"] = "; ".join(extra) or None
    return node


def _mysql_explain_node(data: Any) -> Dict[str, Any]:
    """把 EXPLAIN FORMAT=JSON 的一段递归成 {name, operation, rows, cost, children} 树。
    query_block 的 nested_loop 展开为 children;子查询(attached_subqueries)也挂为 children。"""
    if not isinstance(data, dict):
        return {"name": str(data)[:200], "children": []}
    op_keys = [k for k in data if k in _EXPLAIN_OP_KEYS]
    if not op_keys:
        return {"name": "node", "children": []}
    if len(op_keys) == 1:
        k = op_keys[0]
        inner = data[k]
        node: Dict[str, Any] = {"name": k, "children": []}
        if k == "table" and isinstance(inner, dict):
            node.update(_mysql_explain_table(inner))
            node["children"] = [_mysql_explain_node(x) for x in (inner.get("attached_subqueries") or [])]
        elif isinstance(inner, dict):
            node.update(_mysql_explain_operation(inner))
            children = [_mysql_explain_node(x) for x in (inner.get("nested_loop") or [])]
            children.extend(_mysql_explain_node(x) for x in (inner.get("attached_subqueries") or []))
            node["children"] = children
        else:
            node["operation"] = str(inner)[:200]
        return node
    # 同一层出现多个操作键(罕见):并列展开
    children = [_mysql_explain_node({k: data[k]}) for k in op_keys]
    return {"name": "query_block", "children": children}


def _build_explain_tree(data: Any) -> Dict[str, Any]:
    return _mysql_explain_node(data)


def _to_int(s: Any) -> Optional[int]:
    if s is None:
        return None
    try:
        return int(str(s).split()[0].replace(",", ""))
    except (ValueError, IndexError):
        return None


def _build_oracle_tree(rows: List[Any]) -> Optional[Dict[str, Any]]:
    """PLAN_TABLE 行 → 按 parent_id 递归成 {id, operation, object_name, rows, cost, children} 树。"""
    nodes: Dict[int, Dict[str, Any]] = {}
    for r in rows:
        try:
            rid = int(r[0])
        except (TypeError, ValueError):
            continue
        operation = str(r[2] or "")
        options = str(r[3] or "")
        if options and options.lower() != "null":
            operation = (operation + " " + options).strip()
        nodes[rid] = {
            "id": rid,
            "parent_id": int(r[1]) if r[1] is not None else None,
            "operation": operation,
            "object_name": str(r[4] or ""),
            "rows": _to_int(r[5]),
            "cost": _to_int(r[6]),
            "children": [],
        }
    if not nodes:
        return None
    roots: List[Dict[str, Any]] = []
    for node in nodes.values():
        parent = nodes.get(node["parent_id"])
        if parent is not None:
            parent["children"].append(node)
        else:
            roots.append(node)
    if len(roots) == 1:
        return roots[0]
    return {
        "id": 0,
        "operation": "STATEMENT",
        "object_name": "",
        "rows": None,
        "cost": None,
        "children": roots,
    }


_PLAN_ROW_RE = re.compile(r"^\|\s*\*?\s*(\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|")


def _parse_dbms_xplan_tree(lines: List[str]) -> Optional[Dict[str, Any]]:
    """解析 DBMS_XPLAN.DISPLAY 文本(无 parent_id 列,退化为链式树);解析失败返回 None。"""
    nodes: Dict[int, Dict[str, Any]] = {}
    for ln in lines:
        m = _PLAN_ROW_RE.match(ln)
        if not m:
            continue
        try:
            rid = int(m.group(1))
        except ValueError:
            continue
        nodes[rid] = {
            "id": rid,
            "operation": (m.group(2) or "").strip() or None,
            "object_name": (m.group(3) or "").strip() or None,
            "rows": _to_int(m.group(4)),
            "cost": _to_int(m.group(5)),
            "children": [],
        }
    if not nodes:
        return None
    ids = sorted(nodes)
    for i, rid in enumerate(ids[1:], start=1):
        nodes[ids[i - 1]]["children"].append(nodes[rid])
    return nodes[ids[0]]


class ExplainReq(BaseModel):
    db: str
    sql: str
    engine: Optional[str] = None  # 可选:不传按数据源推断


@router.post("/explain")
def explain(
    req: ExplainReq, x_db_token: Optional[str] = Header(default=None), _g: None = Depends(_meta_guard)
) -> Dict[str, Any]:
    """执行计划可视化(只读,写语句 400)。

    - MySQL/Doris:优先 EXPLAIN FORMAT=JSON → {kind:'tree', root};老版本/失败时
      回退普通 EXPLAIN → {kind:'table', columns, rows}
    - Oracle:EXPLAIN PLAN FOR 后查 PLAN_TABLE(按 parent_id 建树);不可用则
      DBMS_XPLAN.DISPLAY 文本解析;再失败 → {kind:'table', rows: 原始行}"""
    require_auth(x_db_token)
    check_db_allowed(req.db)
    raw = (req.sql or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="sql is required")
    # 复用 /query 同一套校验:走私检测(INTO OUTFILE/DUMPFILE、LOAD_FILE、可执行注释)、
    # CTE-DML、单语句、表白名单、read_only 拦截;EXPLAIN 只读,非 SELECT 一律 400
    # (MySQL 5.x 的 EXPLAIN 对 DML 会实际执行,必须在此挡住)。
    ds, clean, is_select, _limit, q_timeout, _start = _prepare_query(raw, req.db)
    if not is_select:
        raise HTTPException(status_code=400, detail="explain only supports read-only SQL")
    try:
        conn = ds.connect(DB_CONNECT_TIMEOUT, q_timeout)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"connect failed: {e}")
    try:
        cur = conn.cursor()
        if ds.type == "mysql":
            try:
                # EXPLAIN FORMAT=JSON:老版本 MySQL 不支持会语法报错 → 回退普通 EXPLAIN
                cur.execute("EXPLAIN FORMAT=JSON " + clean)
                row = cur.fetchone()
                raw = None
                if row:
                    raw = next(iter(row.values())) if hasattr(row, "items") else row[0]
                data = json.loads(raw) if isinstance(raw, str) else raw
                if not isinstance(data, dict):
                    raise ValueError("unexpected explain json shape")
                root = _build_explain_tree(data)
                return {"code": 0, "data": {"kind": "tree", "root": root}}
            except Exception:
                cur.execute("EXPLAIN " + clean)
                rows = cur.fetchall()
                columns = list(rows[0].keys()) if rows else []
                return {"code": 0, "data": {"kind": "table", "columns": columns, "rows": rows}}
        else:
            cur.execute("EXPLAIN PLAN FOR " + clean)
            try:
                cur.execute(
                    "SELECT id, parent_id, operation, options, object_name, cardinality, cost "
                    "FROM plan_table ORDER BY id"
                )
                pt = cur.fetchall()
                if pt:
                    root = _build_oracle_tree(pt)
                    if root is not None:
                        return {"code": 0, "data": {"kind": "tree", "root": root}}
            except Exception:
                pass
            try:
                cur.execute("SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, NULL, 'ALL'))")
                plan_rows = cur.fetchall()
                lines = [
                    str(r[0]) if not hasattr(r, "items") else str(next(iter(r.values())))
                    for r in plan_rows
                ]
            except Exception:
                lines = []
            root = _parse_dbms_xplan_tree(lines)
            if root is not None:
                return {"code": 0, "data": {"kind": "tree", "root": root}}
            return {"code": 0, "data": {"kind": "table", "rows": lines}}
    except HTTPException:
        raise
    except Exception as e:
        de = _extract_sql_error(e, ds.type)
        raise HTTPException(status_code=502, detail=f"explain failed: {de.message}")
    finally:
        try:
            conn.close()
        except Exception:
            pass
