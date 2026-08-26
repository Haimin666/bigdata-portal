# 写操作审计(JSON Lines,audit/audit-db.log,线程安全)(原样迁出)

from __future__ import annotations
import json
import os
import time
import datetime
import threading
from typing import Any, Dict, Optional
from dbp_core import log
from dbp_sqlguard import READ_ONLY_SQL_RE


# ── 写操作审计(MySQL/Oracle/Doris 写 SQL 执行审计,JSON Lines)────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


AUDIT_DIR = os.path.join(BASE_DIR, "audit")


AUDIT_LOG_FILE = os.path.join(AUDIT_DIR, "audit-db.log")


_audit_lock = threading.Lock()


def _is_write_sql(sql: str) -> bool:
    """写语句判定:非 SELECT/EXPLAIN/SHOW/DESC/DESCRIBE 开头即视为写
    (INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/DROP/TRUNCATE/GRANT/REVOKE/COMMENT/SET 等)。
    与 READ_ONLY_SQL_RE 对齐:注释前缀先剥,末尾分号不影响判定。"""
    if not sql or not sql.strip():
        return False
    return not bool(READ_ONLY_SQL_RE.match(sql))


def _write_audit(
    db: str,
    engine: str,
    sql: str,
    affected: Optional[int],
    cost_ms: float,
    source: str,
    blocked: bool = False,
) -> None:
    """追加一条写操作审计到 audit/audit-db.log(线程安全,独立锁)。
    sql 截断 500;审计写失败只记 warning,绝不干扰查询主流程。"""
    try:
        os.makedirs(AUDIT_DIR, mode=0o700, exist_ok=True)
        rec: Dict[str, Any] = {
            "ts": datetime.datetime.now().isoformat(sep="T"),
            "db": db,
            "engine": engine,
            "sql": (sql or "")[:500],
            "affected": affected,
            "costMs": int(cost_ms or 0),
            "source": source,
        }
        if blocked:
            rec["blocked"] = True
        line = json.dumps(rec, ensure_ascii=False)
        with _audit_lock:
            with open(AUDIT_LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
            # 审计日志含完整 SQL,收紧权限:文件 0600(目录已在 makedirs 时 0700)
            try:
                os.chmod(AUDIT_LOG_FILE, 0o600)
            except Exception:
                pass
    except Exception as e:  # 审计失败不影响查询结果
        log.warning("audit write failed: %s", e)
