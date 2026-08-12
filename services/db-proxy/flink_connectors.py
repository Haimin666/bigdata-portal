# -*- coding: utf-8 -*-
"""Flink 连接器注册表与 DDL 自动生成。

用户在前端选择连接器(kafka / mysql-cdc / hbase / paimon ...),
填入业务参数(topic / 库表 / HBase 表名),本模块负责:

1. 连接器定义下发(前端渲染表单):GET /flink/connectors
2. 字段自动探测(仅 mysql-cdc 支持):POST /flink/connectors/:name/probe
3. CREATE TABLE DDL 生成:POST /flink/ddl/generate

连接器定义位于 datasources.json -> "flink" -> "connectors":

{
  "mysql_cdc": {
    "label": "MySQL(CDC)",
    "type": "mysql-cdc",
    "defaults": {
      "hostname": "10.26.2.23",
      "port": "3343",
      "username": "bigdata_cdc",
      "password": "xxx",
      "scan.startup.mode": "initial"
    },
    "dynamicFields": [
      {"key": "database-name", "label": "库名", "placeholder": "如 finance_order_trade"},
      {"key": "table-name", "label": "表名", "placeholder": "支持正则,如 t_.*"}
    ],
    "probe": { "type": "mysql" },          // 可自动探测字段
    "primaryKey": true                      // 探测时自动识别主键
  },
  "kafka": {
    "label": "Kafka",
    "type": "kafka",
    "defaults": {
      "properties.bootstrap.servers": "kafka-01:9092,kafka-02:9092",
      "properties.group.id": "flusr_xxx",
      "scan.startup.mode": "earliest-offset",
      "format": "json"
    },
    "dynamicFields": [
      {"key": "topic", "label": "Topic", "placeholder": "如 bigdata-tupu-neo4j"}
    ]
  },
  "hbase": {
    "label": "HBase(维表)",
    "type": "hbase-2.2",
    "defaults": {
      "zookeeper.quorum": "olap-worker-01:2181,olap-worker-02:2181,olap-worker-03:2181"
    },
    "dynamicFields": [
      {"key": "table-name", "label": "HBase 表名", "placeholder": "如 lion_dw:dim_cmmlion_sys_dictionary_bak"}
    ]
  }
}
"""

import json
import re
import threading
from typing import Any, Dict, List, Optional, Tuple

log = None


def _setup_logger(logger):
    global log
    log = logger


# ── MySQL 类型 → Flink 类型 ───────────────────────────────
_MYSQL_TYPE_MAP = [
    (r"tinyint\(1\)", "BOOLEAN"),
    (r"tinyint", "TINYINT"),
    (r"smallint", "SMALLINT"),
    (r"mediumint", "INT"),
    (r"int", "INT"),
    (r"bigint", "BIGINT"),
    (r"decimal\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)", "DECIMAL(\\1, \\2)"),
    (r"decimal", "DECIMAL(10, 0)"),
    (r"float", "FLOAT"),
    (r"double", "DOUBLE"),
    (r"bit", "BOOLEAN"),
    (r"datetime\s*\(\s*(\d+)\s*\)", "TIMESTAMP(\\1)"),
    (r"datetime", "TIMESTAMP(3)"),
    (r"timestamp", "TIMESTAMP(3)"),
    (r"date", "DATE"),
    (r"time", "TIME"),
    (r"year", "INT"),
    (r"char", "STRING"),
    (r"varchar", "STRING"),
    (r"text", "STRING"),
    (r"blob", "BYTES"),
    (r"binary", "BYTES"),
    (r"varbinary", "BYTES"),
    (r"json", "STRING"),
    (r"enum", "STRING"),
    (r"set", "STRING"),
]


def mysql_type_to_flink(mysql_type: str) -> str:
    """MySQL 列类型 → Flink SQL 类型。"""
    t = mysql_type.lower().strip()
    for pat, flink in _MYSQL_TYPE_MAP:
        if re.match(pat, t):
            return re.sub(pat, flink, t)
    return "STRING"


def _quote_ident(name: str) -> str:
    return "`" + name.replace("`", "``") + "`"


class FlinkConnectors:
    """连接器注册表 + DDL 生成器。"""

    def __init__(self, cfg: Dict[str, Any], base_dir: str) -> None:
        self._lock = threading.Lock()
        self.connectors: Dict[str, Dict[str, Any]] = (cfg.get("connectors") or {}) if cfg else {}
        self._base_dir = base_dir

    # ── 列表(脱敏)────────────────────────────────────────
    def list_connectors(self) -> List[Dict[str, Any]]:
        """返回连接器定义列表,密码脱敏为 ****。"""
        out = []
        for name, c in self.connectors.items():
            item = {
                "name": name,
                "label": c.get("label", name),
                "type": c.get("type", name),
                "defaults": _mask_secrets(c.get("defaults") or {}),
                "dynamicFields": c.get("dynamicFields") or [],
                "probe": bool(c.get("probe")),
            }
            out.append(item)
        return out

    def get(self, name: str) -> Dict[str, Any]:
        c = self.connectors.get(name)
        if not c:
            raise KeyError("connector not found: %s" % name)
        return c

    # ── 字段探测 ──────────────────────────────────────────
    def probe_schema(self, name: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """探测连接器字段。目前仅支持 mysql-cdc(读 information_schema)。"""
        c = self.get(name)
        probe = c.get("probe") or {}
        ptype = str(probe.get("type", "")).lower()
        if ptype == "mysql":
            return self._probe_mysql(c, params, probe)
        raise NotImplementedError(
            "connector '%s' 不支持自动探测字段,请手动填写字段定义" % name
        )

    def _probe_mysql(self, c: Dict[str, Any], params: Dict[str, Any], probe: Dict[str, Any]) -> Dict[str, Any]:
        import pymysql

        defaults = c.get("defaults") or {}
        # 连接信息:params 覆盖 defaults(hostname/port/username/password)
        host = params.get("hostname", defaults.get("hostname", "127.0.0.1"))
        port = int(params.get("port", defaults.get("port", 3306)))
        user = params.get("username", defaults.get("username", ""))
        pwd = params.get("password", defaults.get("password", ""))
        db = params.get("database-name", "")
        table = params.get("table-name", "").split("|")[0].strip()
        if not db or not table:
            raise ValueError("database-name 与 table-name 必填,才能探测字段")

        conn = None
        try:
            conn = pymysql.connect(
                host=host, port=port, user=user, password=pwd,
                database="information_schema", connect_timeout=5, charset="utf8mb4",
            )
            with conn.cursor() as cur:
                # 主键
                pks = set()
                if c.get("primaryKey"):
                    cur.execute(
                        "SELECT column_name FROM KEY_COLUMN_USAGE "
                        "WHERE table_schema=%s AND table_name=%s AND constraint_name='PRIMARY' "
                        "ORDER BY ordinal_position",
                        (db, table),
                    )
                    pks = {r[0] for r in cur.fetchall()}
                # 列
                cur.execute(
                    "SELECT column_name, data_type, column_type, is_nullable, column_comment "
                    "FROM COLUMNS WHERE table_schema=%s AND table_name=%s ORDER BY ordinal_position",
                    (db, table),
                )
                fields = []
                for col_name, data_type, column_type, nullable, comment in cur.fetchall():
                    flink_type = mysql_type_to_flink(column_type or data_type)
                    fields.append({
                        "name": col_name,
                        "type": flink_type,
                        "primaryKey": col_name in pks,
                        "comment": comment or "",
                    })
                if not fields:
                    raise ValueError("表 %s.%s 不存在或无列" % (db, table))
                return {
                    "fields": fields,
                    "primaryKeys": sorted(pks),
                    "source": "information_schema",
                }
        finally:
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass

    # ── DDL 生成 ──────────────────────────────────────────
    def generate_ddl(
        self,
        table_name: str,
        connector_name: str,
        params: Dict[str, Any],
        fields: List[Dict[str, Any]],
    ) -> str:
        """生成 CREATE TABLE DDL。

        fields: [{"name": "id", "type": "BIGINT", "primaryKey": true}, ...]
        """
        c = self.get(connector_name)
        if not table_name or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", table_name):
            raise ValueError("表名不合法: %s(仅字母数字下划线)" % table_name)
        if not fields:
            raise ValueError("至少需要一个字段定义")

        # 字段行
        col_lines = []
        pk_cols = [f["name"] for f in fields if f.get("primaryKey")]
        for i, f in enumerate(fields):
            fname = f.get("name", "")
            ftype = f.get("type", "STRING").strip()
            if not fname or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", fname):
                raise ValueError("字段名不合法: %s" % fname)
            line = "  %s %s" % (_quote_ident(fname), ftype)
            if f.get("primaryKey"):
                line += " NOT NULL"
            if i < len(fields) - 1:
                line += ","
            col_lines.append(line)
        if pk_cols:
            col_lines.append("  PRIMARY KEY (%s) NOT ENFORCED" % ", ".join(_quote_ident(p) for p in pk_cols))

        # WITH 参数:defaults(连接信息) + params(业务参数),param 覆盖
        with_map: Dict[str, str] = {"connector": c.get("type", connector_name)}
        for k, v in (c.get("defaults") or {}).items():
            with_map[k] = str(v)
        for k, v in (params or {}).items():
            if v is None:
                continue
            v = str(v).strip()
            if v:
                with_map[k] = v

        with_lines = ",\n".join(
            "  '%s' = '%s'" % (k, _escape_option(v)) for k, v in with_map.items()
        )

        ddl = (
            "CREATE TABLE %s (\n%s\n) WITH (\n%s\n);"
            % (table_name, ",\n".join(col_lines), with_lines)
        )
        return ddl


def _escape_option(v: str) -> str:
    return v.replace("'", "''")


def _mask_secrets(defaults: Dict[str, Any]) -> Dict[str, Any]:
    """密码/密钥字段脱敏(仅用于前端展示)。"""
    out = {}
    for k, v in defaults.items():
        low = k.lower()
        if any(secret in low for secret in ("password", "secret", "token", "key", "passwd")):
            out[k] = "****"
        else:
            out[k] = v
    return out
