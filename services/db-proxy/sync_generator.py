"""Generate Hive DDL and DataX JSON from configured MySQL/Oracle datasources."""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple



HIVE_DATABASE = "lion_dw_ods"
_ALLOWED_HIVE_TYPES = frozenset({"bigint", "double", "string"})
DEFAULT_HADOOP_CONFIG = {
    "dfs.nameservices": "lbc",
    "dfs.ha.namenodes.lbc": "nn1,nn2",
    "dfs.namenode.rpc-address.lbc.nn1": "hadoop-nn-1.bigdata.shiqiao.com:8020",
    "dfs.namenode.rpc-address.lbc.nn2": "hadoop-nn-2.bigdata.shiqiao.com:8020",
    "dfs.client.failover.proxy.provider.lbc": (
        "org.apache.hadoop.hdfs.server.namenode.ha.ConfiguredFailoverProxyProvider"
    ),
}

_HIVE_TYPE_MAP = {
    "tinyint": "bigint",
    "smallint": "bigint",
    "mediumint": "bigint",
    "int": "bigint",
    "integer": "bigint",
    "bigint": "bigint",
    "float": "double",
    "double": "double",
    "decimal": "double",
}


def _rows_as_dicts(cursor) -> List[Dict[str, Any]]:
    rows = cursor.fetchall()
    if not rows:
        return []
    if hasattr(rows[0], "items"):
        return [dict(row) for row in rows]
    names = [str(item[0]).upper() for item in (cursor.description or [])]
    return [dict(zip(names, row)) for row in rows]


def _source_type_to_hive(source_type: str, column_type: str) -> str:
    ct = str(column_type or "").lower().strip()
    if source_type == "oracle":
        match = re.match(r"(?:number|numeric|decimal)\s*\((\d+)\s*,\s*(-?\d+)\)", ct)
        if match:
            return "bigint" if int(match.group(2)) == 0 else "double"
        base = ct.split("(", 1)[0].strip()
        if base in ("number", "numeric", "decimal", "float", "binary_float", "binary_double", "real"):
            return "double"
        return "string"

    match = re.match(r"(?:decimal|numeric)\s*\((\d+)\s*,\s*(\d+)\)", ct)
    if match:
        return "bigint" if int(match.group(2)) == 0 else "double"
    base = ct.split("(", 1)[0].strip()
    if base in ("decimal", "numeric"):
        return "double"
    return _HIVE_TYPE_MAP.get(base, "string")


def _hive_type_warnings(
    columns: List[Dict[str, Any]],
    hive_columns: List[Dict[str, str]],
    source_type: str,
) -> List[str]:
    source_map = {str(col["COLUMN_NAME"]).lower(): col for col in columns}
    warnings: List[str] = []
    for hive_col in hive_columns:
        source_col = source_map.get(str(hive_col["name"]).lower())
        hive_type = str(hive_col.get("type") or "").strip().lower()
        if not source_col:
            if hive_type not in _ALLOWED_HIVE_TYPES:
                warnings.append(
                    "{}：Hive 类型 {}，源表无对应字段".format(
                        hive_col["name"], hive_type or "<empty>"
                    )
                )
            continue
        datax_type = _source_type_to_hive(source_type, source_col["COLUMN_TYPE"])
        if hive_type not in _ALLOWED_HIVE_TYPES or hive_type != datax_type:
            warnings.append(
                "{}：Hive 类型 {}，DataX 类型 {}".format(
                    hive_col["name"], hive_type or "<empty>", datax_type
                )
            )
    return warnings


def _hive_columns(ds, table_name: str, timeout: int) -> Optional[List[Dict[str, str]]]:
    cfg = ds
    if not isinstance(cfg, dict) or not cfg.get("host") or not cfg.get("database"):
        raise RuntimeError("dataSync.hiveMetastore 未配置完整的 host/database")
    try:
        import pymysql

        conn = pymysql.connect(
            host=str(cfg["host"]),
            port=int(cfg.get("port", 3306)),
            user=str(cfg.get("user", "")),
            password=str(cfg.get("password", "")),
            database=str(cfg["database"]),
            charset="utf8mb4",
            cursorclass=pymysql.cursors.DictCursor,
            connect_timeout=max(1, int(timeout)),
            read_timeout=max(1, int(timeout)),
            write_timeout=max(1, int(timeout)),
        )
    except Exception as exc:
        raise RuntimeError("Hive metastore 连接失败: {}".format(exc)) from exc

    try:
        cur = conn.cursor()
        try:
            cur.execute("SELECT DB_ID FROM DBS WHERE NAME = %s LIMIT 1", (HIVE_DATABASE,))
            db_row = cur.fetchone()
            if not db_row:
                return None
            db_id = db_row.get("DB_ID") if hasattr(db_row, "get") else db_row[0]
            cur.execute(
                "SELECT TBL_ID, SD_ID FROM TBLS WHERE DB_ID = %s AND TBL_NAME = %s LIMIT 1",
                (db_id, table_name),
            )
            table_row = cur.fetchone()
            if not table_row:
                return None
            sd_id = table_row.get("SD_ID") if hasattr(table_row, "get") else table_row[1]
            cur.execute("SELECT CD_ID FROM SDS WHERE SD_ID = %s LIMIT 1", (sd_id,))
            sd_row = cur.fetchone()
            if not sd_row:
                return []
            cd_id = sd_row.get("CD_ID") if hasattr(sd_row, "get") else sd_row[0]
            cur.execute(
                "SELECT COLUMN_NAME, TYPE_NAME, COMMENT FROM COLUMNS_V2 "
                "WHERE CD_ID = %s ORDER BY INTEGER_IDX",
                (cd_id,),
            )
            return [
                {
                    "name": str(row.get("COLUMN_NAME") or ""),
                    "type": str(row.get("TYPE_NAME") or "string"),
                    "comment": str(row.get("COMMENT") or ""),
                }
                for row in cur.fetchall()
            ]
        finally:
            cur.close()
    except Exception as exc:
        raise RuntimeError("Hive metastore 查询失败: {}".format(exc)) from exc
    finally:
        conn.close()


def _oracle_current_schema(ds, connect_timeout: int, query_timeout: int) -> str:
    conn = ds.connect(connect_timeout, query_timeout)
    try:
        cur = conn.cursor()
        try:
            cur.execute("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual")
            row = cur.fetchone()
            return str(row[0] or "").strip().upper() if row else ""
        finally:
            cur.close()
    finally:
        conn.close()


def _source_columns(ds, table_name: str, connect_timeout: int, query_timeout: int, oracle_owner: Optional[str] = None) -> Tuple[List[Dict[str, Any]], str]:
    if ds.type not in ("mysql", "oracle") or getattr(ds, "source_type", ds.type) == "doris":
        raise ValueError("数据同步仅支持 MySQL/Oracle 数据源")

    conn = ds.connect(connect_timeout, query_timeout)
    try:
        cur = conn.cursor()
        try:
            if ds.type == "mysql":
                cur.execute(
                    "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, COLUMN_COMMENT, COLUMN_KEY, "
                    "IS_NULLABLE, ORDINAL_POSITION, COLUMN_DEFAULT "
                    "FROM information_schema.columns WHERE table_schema = %s AND table_name = %s "
                    "ORDER BY ORDINAL_POSITION",
                    (ds.service, table_name),
                )
                columns = _rows_as_dicts(cur)
                cur.execute(
                    "SELECT table_comment AS TABLE_COMMENT FROM information_schema.tables "
                    "WHERE table_schema = %s AND table_name = %s LIMIT 1",
                    (ds.service, table_name),
                )
                comment_row = _rows_as_dicts(cur)
                table_comment = str(comment_row[0].get("TABLE_COMMENT") or "") if comment_row else ""
            else:
                owner = str(oracle_owner or getattr(ds, "owner", "") or "").strip().upper()
                if not owner:
                    cur.execute("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual")
                    owner_row = cur.fetchone()
                    owner = str(owner_row[0] or "").strip().upper() if owner_row else ""
                if not owner:
                    raise ValueError("未能确定 Oracle 当前 schema，请指定 owner/schema")
                cur.execute(
                    "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.DATA_LENGTH, c.DATA_PRECISION, "
                    "c.DATA_SCALE, c.NULLABLE AS IS_NULLABLE, c.COLUMN_ID AS ORDINAL_POSITION, "
                    "cc.COMMENTS AS COLUMN_COMMENT "
                    "FROM ALL_TAB_COLUMNS c LEFT JOIN ALL_COL_COMMENTS cc "
                    "ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME "
                    "AND cc.COLUMN_NAME = c.COLUMN_NAME "
                    "WHERE c.OWNER = :owner AND c.TABLE_NAME = :table_name ORDER BY c.COLUMN_ID",
                    {"owner": owner, "table_name": table_name.upper()},
                )
                columns = _rows_as_dicts(cur)
                for col in columns:
                    data_type = str(col.get("DATA_TYPE") or "")
                    if data_type.upper() in ("NUMBER", "NUMERIC", "DECIMAL") and col.get("DATA_PRECISION") is not None:
                        scale = col.get("DATA_SCALE") or 0
                        col["COLUMN_TYPE"] = "{}({}, {})".format(data_type, col["DATA_PRECISION"], scale)
                    else:
                        col["COLUMN_TYPE"] = data_type
                cur.execute(
                    "SELECT COMMENTS AS TABLE_COMMENT FROM ALL_TAB_COMMENTS "
                    "WHERE OWNER = :owner AND TABLE_NAME = :table_name AND TABLE_TYPE = 'TABLE'",
                    {"owner": owner, "table_name": table_name.upper()},
                )
                comment_row = _rows_as_dicts(cur)
                table_comment = str(comment_row[0].get("TABLE_COMMENT") or "") if comment_row else ""
            for col in columns:
                col["COLUMN_NAME"] = str(col.get("COLUMN_NAME") or "")
                col["COLUMN_TYPE"] = str(col.get("COLUMN_TYPE") or col.get("DATA_TYPE") or "")
                col["COLUMN_COMMENT"] = str(col.get("COLUMN_COMMENT") or "")
                col["COLUMN_DEFAULT"] = col.get("COLUMN_DEFAULT")
            return columns, table_comment
        finally:
            cur.close()
    finally:
        conn.close()


def _build_column_comment(col: Dict[str, Any]) -> str:
    comment = str(col.get("COLUMN_COMMENT") or col.get("comment") or "")
    default = col.get("COLUMN_DEFAULT")
    if default is None or str(default).upper() == "NULL":
        default_text = ""
    elif str(default).upper() == "CURRENT_TIMESTAMP":
        default_text = "CURRENT_TIMESTAMP"
    else:
        default_text = str(default)
    return "comment '{},默认值:{}'".format(comment, default_text)


def _create_table_sql(db_name: str, table_name: str, columns: List[Dict[str, Any]], table_comment: str, source_type: str) -> str:
    column_parts = []
    for col in columns:
        hive_type = _source_type_to_hive(source_type, col["COLUMN_TYPE"])
        column_parts.append(
            "`{}` {} {}".format(col["COLUMN_NAME"], hive_type, _build_column_comment(col))
        )
    lines = [
        "use {};".format(HIVE_DATABASE),
        "  create table if not exists {}_{} (".format(db_name, table_name),
        "  {}".format(" ,".join(column_parts)),
        "  )",
    ]
    if table_comment:
        lines.append('  comment "{}"'.format(table_comment.replace('"', '\\"')))
    lines.append("  PARTITIONED BY(dt string)")
    return "\n".join(lines)


def _alter_table_sql(db_name: str, table_name: str, new_columns: List[Dict[str, Any]], source_type: str) -> str:
    if not new_columns:
        return ""
    lines = ["ALTER TABLE {}.{}_{} ADD COLUMNS (".format(HIVE_DATABASE, db_name, table_name)]
    for index, col in enumerate(new_columns):
        suffix = "," if index < len(new_columns) - 1 else ""
        comment = " COMMENT '{}'".format(str(col.get("COLUMN_COMMENT") or "").replace("'", "\\'")) if col.get("COLUMN_COMMENT") else ""
        lines.append("    `{}` {}{}{}".format(
            col["COLUMN_NAME"],
            _source_type_to_hive(source_type, col["COLUMN_TYPE"]),
            comment,
            suffix,
        ))
    lines.append(");")
    return "\n".join(lines)


def _diff_columns(columns: List[Dict[str, Any]], hive_columns: List[Dict[str, str]], source_type: str) -> List[Dict[str, Any]]:
    source_map = {str(col["COLUMN_NAME"]).lower(): col for col in columns}
    hive_map = {str(col["name"]).lower(): col for col in hive_columns}
    diffs: List[Dict[str, Any]] = []
    for key, hive_col in hive_map.items():
        if key not in source_map:
            diffs.append({"name": hive_col["name"], "mysql_type": None, "hive_type": hive_col["type"], "status": "removed"})
    for key, source_col in source_map.items():
        if key not in hive_map:
            diffs.append({"name": source_col["COLUMN_NAME"], "mysql_type": source_col["COLUMN_TYPE"], "hive_type": None, "status": "new"})
    for key, hive_col in hive_map.items():
        if key in source_map:
            source_col = source_map[key]
            source_hive_type = _source_type_to_hive(source_type, source_col["COLUMN_TYPE"])
            diffs.append({
                "name": source_col["COLUMN_NAME"],
                "mysql_type": source_col["COLUMN_TYPE"],
                "hive_type": hive_col["type"],
                "status": "same" if str(hive_col["type"]).lower() == source_hive_type.lower() else "type_changed",
            })
    return diffs


def _encode_datax_password(password: str) -> str:
    """Encode like lion_decrypt.py::encrypt for DataX's lion#code_ format."""
    prefix = "lion#code_"
    if password.startswith(prefix):
        return password

    payload = password
    encoded = []
    for index, char in enumerate(payload):
        code = ord(char)
        if 97 <= code <= 122:
            lower, upper = 97, 122
        elif 65 <= code <= 90:
            lower, upper = 65, 90
        else:
            encoded.append(char)
            continue
        offset = (index + 5) % 26  # key=2, so key + index + 3
        shifted = code + offset
        if shifted < lower:
            shifted += 26
        if shifted > upper:
            shifted -= 26
        encoded.append(chr(shifted))
    return prefix + "".join(encoded)


def _datax_json(ds, db_name: str, table_name: str, columns: List[Dict[str, Any]], hive_columns: Optional[List[Dict[str, str]]], source_type: str, cfg: Dict[str, Any], source_table_name: Optional[str] = None) -> str:
    reader_user = str(getattr(ds, "user", "") or "").strip()
    reader_password = str(getattr(ds, "password", "") or "")
    if not reader_user or not reader_password:
        raise RuntimeError("所选数据源未配置连接用户名或密码")
    if source_type == "oracle":
        reader_name = "oraclereader"
        jdbc_url = "jdbc:oracle:thin:@//{}:{}/{}".format(ds.host, ds.port, ds.service)
    else:
        reader_name = "mysqlreader"
        jdbc_url = "jdbc:mysql://{}:{}/{}".format(ds.host, ds.port, ds.service)

    reader_password = _encode_datax_password(reader_password)

    if hive_columns:
        source_map = {str(col["COLUMN_NAME"]).lower(): col for col in columns}
        aligned = []
        for hive_col in hive_columns:
            source_col = source_map.pop(str(hive_col["name"]).lower(), None)
            if source_col:
                aligned.append({
                    "name": source_col["COLUMN_NAME"],
                    "type": _source_type_to_hive(source_type, source_col["COLUMN_TYPE"]),
                })
        for source_col in source_map.values():
            aligned.append({"name": source_col["COLUMN_NAME"], "type": _source_type_to_hive(source_type, source_col["COLUMN_TYPE"])})
    else:
        aligned = [{"name": col["COLUMN_NAME"], "type": _source_type_to_hive(source_type, col["COLUMN_TYPE"])} for col in columns]

    reader_columns = [col["name"] if source_type == "oracle" else "`{}`".format(col["name"]) for col in aligned]
    connection = {"table": [source_table_name or table_name], "jdbcUrl": [jdbc_url]}
    reader_parameter: Dict[str, Any] = {
        "username": reader_user,
        "password": reader_password,
        "column": reader_columns,
        "connection": [connection],
    }
    if source_type == "mysql":
        reader_parameter["splitPk"] = ""

    default_fs = str(cfg.get("defaultFs") or "hdfs://lbc")
    hadoop_config = dict(DEFAULT_HADOOP_CONFIG)
    custom_hadoop = cfg.get("hadoopConfig") or {}
    if not isinstance(custom_hadoop, dict):
        raise RuntimeError("dataSync.hadoopConfig 必须是 JSON 对象")
    hadoop_config.update(custom_hadoop)
    hive_table = "{}_{}".format(db_name, table_name)
    payload = {
        "job": {
            "setting": {
                "speed": {"channel": 6},
                "errorLimit": {"record": 0, "percentage": 0.02},
            },
            "content": [{
                "reader": {"name": reader_name, "parameter": reader_parameter},
                "writer": {
                    "name": "hdfswriter",
                    "parameter": {
                        "defaultFS": default_fs,
                        "fileType": "orc",
                        "path": "/user/hive/warehouse/{}.db/{}/dt=$[yyyy-MM-dd-1]".format(HIVE_DATABASE, hive_table),
                        "hadoopConfig": hadoop_config,
                        "fileName": hive_table,
                        "writeMode": "truncate",
                        "fieldDelimiter": ",",
                        "column": [{"name": col["name"], "type": col["type"]} for col in aligned],
                    },
                },
            }],
        },
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def generate_db2hive(
    ds,
    db_name: str,
    table_name: str,
    align_with_hive: bool,
    config: Dict[str, Any],
    connect_timeout: int,
    query_timeout: int,
    oracle_owner: Optional[str] = None,
) -> Dict[str, Any]:
    """Return the legacy snake_case response data without writing files."""
    sync_cfg = config or {}
    if not sync_cfg.get("enabled", False):
        raise RuntimeError("db-proxy data sync generation is disabled")
    source_type = str(getattr(ds, "source_type", ds.type)).lower()
    if source_type == "doris":
        raise ValueError("数据同步仅支持 MySQL/Oracle 数据源")

    hive_table_name = table_name
    source_table_name = table_name
    resolved_owner = ""
    if source_type == "oracle":
        if "." in table_name:
            table_owner, hive_table_name = table_name.split(".", 1)
            table_owner = table_owner.strip().upper()
            if oracle_owner and table_owner != str(oracle_owner).strip().upper():
                raise ValueError("OWNER.TABLE 中的 owner 与单独传入的 owner 不一致")
            resolved_owner = table_owner
        else:
            resolved_owner = str(oracle_owner or getattr(ds, "owner", "") or "").strip().upper()
            if not resolved_owner:
                resolved_owner = _oracle_current_schema(ds, connect_timeout, query_timeout)
        if not resolved_owner:
            raise ValueError("未能确定 Oracle 当前 schema，请指定 owner/schema")
        allowed_owners = getattr(ds, "owners", []) or []
        if allowed_owners and resolved_owner not in allowed_owners:
            raise ValueError("Oracle owner 不在当前数据源允许的 schema 列表中")
        source_table_name = "{}.{}".format(resolved_owner, hive_table_name.upper())
    columns, table_comment = _source_columns(
        ds, hive_table_name, connect_timeout, query_timeout,
        oracle_owner=resolved_owner if source_type == "oracle" else None,
    )
    if not columns:
        source_owner = resolved_owner if source_type == "oracle" else ds.service
        raise LookupError("{} 表不存在: {}.{}".format(source_type.upper(), source_owner, hive_table_name))

    hive_table = "{}_{}".format(db_name, hive_table_name)
    hive_columns = None
    if align_with_hive:
        hive_columns = _hive_columns(sync_cfg.get("hiveMetastore"), hive_table, query_timeout)
    type_warnings = (
        _hive_type_warnings(columns, hive_columns, source_type)
        if hive_columns else []
    )
    diffs: List[Dict[str, Any]] = []
    new_columns: List[Dict[str, Any]] = []
    if hive_columns:
        diffs = _diff_columns(columns, hive_columns, source_type)
        source_map = {str(col["COLUMN_NAME"]).lower(): col for col in columns}
        for diff in diffs:
            if diff["status"] == "new":
                col = source_map.get(str(diff["name"]).lower())
                if col:
                    new_columns.append(col)

    if hive_columns and new_columns:
        sql_content = _alter_table_sql(db_name, hive_table_name, new_columns, source_type)
    elif not hive_columns:
        sql_content = _create_table_sql(db_name, hive_table_name, columns, table_comment, source_type)
    else:
        sql_content = ""

    json_content = _datax_json(
        ds, db_name, hive_table_name, columns, hive_columns, source_type, sync_cfg,
        source_table_name=source_table_name,
    )
    return {
        "database": db_name,
        "table": hive_table_name,
        "sql_content": sql_content,
        "json_content": json_content,
        "mysql_columns": len(columns),
        "hive_columns": len(hive_columns) if hive_columns else 0,
        "new_columns": len(new_columns),
        "diff_summary": diffs,
        "type_warnings": type_warnings,
    }
