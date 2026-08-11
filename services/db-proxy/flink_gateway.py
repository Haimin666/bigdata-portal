"""Flink SQL Gateway 转发模块(db-proxy 侧)。

架构:db-proxy 不内嵌 PyFlink,而是作为 HTTP 客户端转发到 Flink SQL Gateway REST API
(flink-1.17.2 自带,由 flink-gateway.sh 用 JDK11 启动,监听 127.0.0.1:8083)。

  db-proxy(8756) --HTTP--> SQL Gateway(8083) --YARN/embedded--> Flink

能力:
  - 常驻一个 gateway session(懒加载,复用)
  - execute_sql:提交 SQL,轮询 operation 状态到 FINISHED/FAILED/CANCELED,取回表格结果
  - cancel:取消当前 operation
  - status:会话/操作状态

配置(datasources.json 顶层 flink 段,缺省 = 禁用):
  {
    "flink": {
      "enabled": true,
      "gatewayUrl": "http://127.0.0.1:8083",
      "sessionName": "db-proxy-flink",
      "defaultLimit": 1000,
      "maxLimit": 10000,
      "queryTimeout": 300
    }
  }

依赖:requests(客户机 py38 已具备);若未装 requests,enabled 自动置 False,不影响 mysql/oracle。
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger("db-proxy.flink")

try:
    import requests  # type: ignore

    _HAS_REQUESTS = True
except ImportError:  # pragma: no cover
    requests = None  # type: ignore
    _HAS_REQUESTS = False


class FlinkGateway:
    """Flink SQL Gateway REST 客户端(常驻会话 + 串行执行)。"""

    def __init__(self, cfg: Optional[Dict[str, Any]]):
        self.enabled = False
        if not cfg or not cfg.get("enabled"):
            return
        if not _HAS_REQUESTS:
            log.warning("flink disabled: requests 未安装(pip install requests)")
            return
        self.url = str(cfg.get("gatewayUrl", "http://127.0.0.1:8083")).rstrip("/")
        self.session_name = str(cfg.get("sessionName", "db-proxy-flink"))
        self.default_limit = int(cfg.get("defaultLimit", 1000))
        self.max_limit = int(cfg.get("maxLimit", 10000))
        self.query_timeout = int(cfg.get("queryTimeout", 300))  # 秒
        self._session_id: Optional[str] = None
        self._op_id: Optional[str] = None
        self._lock = threading.Lock()
        self._cancel_flag = False
        self.enabled = True
        log.info("flink gateway enabled (url=%s)", self.url)

    # ── 会话管理 ────────────────────────────────────────────
    def _ensure_session(self) -> str:
        """懒加载 gateway session,失败抛 RuntimeError。"""
        if self._session_id:
            return self._session_id
        try:
            r = requests.post(
                f"{self.url}/v1/sessions",
                json={"sessionName": self.session_name},
                timeout=10,
            )
            r.raise_for_status()
            data = r.json()
            # Flink SQL Gateway 返回 {"sessionHandle": "uuid", "properties": {...}}
            self._session_id = data.get("sessionId") or data.get("sessionHandle")
            if not self._session_id:
                raise RuntimeError(f"gateway 返回无 sessionHandle: {data}")
            log.info("flink session created: %s", self._session_id)
            return self._session_id
        except requests.RequestException as e:
            raise RuntimeError(f"flink gateway 不可达({self.url}): {e}")

    def _reset_session(self) -> None:
        self._session_id = None
        self._op_id = None

    # ── 核心执行 ────────────────────────────────────────────
    def execute_sql(
        self, sql: str, timeout_ms: int = 600000, limit: Optional[int] = None
    ) -> Dict[str, Any]:
        """执行 FlinkSQL,轮询到结束,取回表格结果。

        返回统一结构 {columns, rows, costMs, truncated, operationState, message}
        """
        if not self.enabled:
            raise RuntimeError("flink engine not enabled")
        timeout_s = max(1, timeout_ms / 1000.0)
        max_rows = self.max_limit if limit is None else min(int(limit), self.max_limit)

        with self._lock:
            self._cancel_flag = False
            try:
                sid = self._ensure_session()
                start = time.time()

                # 1) 提交 statement
                try:
                    r = requests.post(
                        f"{self.url}/v1/sessions/{sid}/statements",
                        json={"statement": sql},
                        timeout=15,
                    )
                    r.raise_for_status()
                    op = r.json()
                except requests.RequestException as e:
                    raise RuntimeError(f"flink statement 提交失败: {e}")
                op_id = op.get("operationHandle")
                if not op_id:
                    raise RuntimeError(f"gateway 返回无 operationHandle: {op}")
                self._op_id = op_id

                # 2) 轮询 operation 状态
                while time.time() - start < timeout_s:
                    if self._cancel_flag:
                        self._try_cancel_operation(sid, op_id)
                        return {
                            "columns": [],
                            "rows": [],
                            "costMs": int((time.time() - start) * 1000),
                            "truncated": False,
                            "operationState": "CANCELED",
                            "message": "查询已取消",
                        }
                    st = self._op_status(sid, op_id)
                    state = (st.get("status") or {}).get("status", "RUNNING")
                    if state in ("FINISHED", "COMPLETED"):
                        rows, truncated = self._fetch_results(
                            sid, op_id, max_rows, start
                        )
                        cols = list(rows[0].keys()) if rows else []
                        return {
                            "columns": cols,
                            "rows": rows,
                            "costMs": int((time.time() - start) * 1000),
                            "truncated": truncated,
                            "operationState": "FINISHED",
                            "message": "",
                        }
                    if state == "FAILED":
                        err = (st.get("status") or {}).get("error", "")
                        raise RuntimeError(f"flink 执行失败: {err or 'unknown error'}")
                    if state == "CANCELED":
                        return {
                            "columns": [],
                            "rows": [],
                            "costMs": int((time.time() - start) * 1000),
                            "truncated": False,
                            "operationState": "CANCELED",
                            "message": "查询被取消",
                        }
                    time.sleep(0.5)
                # 超时 → 取消
                self._try_cancel_operation(sid, op_id)
                raise RuntimeError(f"flink 查询超时({int(timeout_s)}s),已取消")
            except RuntimeError:
                raise
            except requests.RequestException as e:
                raise RuntimeError(f"flink gateway 请求失败: {e}")
            finally:
                self._op_id = None

    def _op_status(self, sid: str, op_id: str) -> Dict[str, Any]:
        r = requests.get(
            f"{self.url}/v1/sessions/{sid}/operations/{op_id}/status", timeout=10
        )
        r.raise_for_status()
        return r.json()

    def _fetch_results(
        self, sid: str, op_id: str, max_rows: int, start: float
    ) -> tuple[List[Dict[str, Any]], bool]:
        """翻页取回结果,返回 (rows, truncated)。"""
        rows: List[Dict[str, Any]] = []
        row_token = 0
        truncated = False
        while len(rows) < max_rows:
            try:
                r = requests.get(
                    f"{self.url}/v1/sessions/{sid}/operations/{op_id}/result",
                    params={"rowToken": row_token},
                    timeout=10,
                )
                r.raise_for_status()
                data = r.json()
            except requests.RequestException as e:
                raise RuntimeError(f"flink 结果取回失败: {e}")

            results = data.get("results") or {}
            columns = results.get("columns") or []
            rows_data = results.get("data") or []
            cols = [c.get("name", f"col{i}") for i, c in enumerate(columns)]

            if not rows_data:
                break
            for row in rows_data:
                if len(rows) >= max_rows:
                    truncated = True
                    break
                rows.append({cols[i]: (row[i] if i < len(row) else None) for i in range(len(cols))})
            if truncated:
                break
            # 翻页
            next_uri = data.get("nextResultUri")
            if not next_uri:
                break
            # nextResultUri 形如 /v1/sessions/{sid}/operations/{op}/result?rowToken=N
            try:
                from urllib.parse import urlparse, parse_qs

                qs = parse_qs(urlparse(next_uri).query)
                row_token = int(qs.get("rowToken", ["0"])[0])
                if row_token <= 0:
                    break
            except Exception:
                break
        return rows, truncated

    def _try_cancel_operation(self, sid: str, op_id: str) -> None:
        try:
            requests.delete(
                f"{self.url}/v1/sessions/{sid}/operations/{op_id}", timeout=5
            )
        except requests.RequestException:
            pass

    # ── 取消 / 状态 ─────────────────────────────────────────
    def cancel(self) -> bool:
        self._cancel_flag = True
        return True

    def status(self) -> Dict[str, Any]:
        if not self.enabled:
            return {"enabled": False}
        return {
            "enabled": True,
            "gatewayUrl": self.url,
            "sessionId": self._session_id,
            "currentOperation": self._op_id,
        }


def init_flink(cfg: Optional[Dict[str, Any]]) -> FlinkGateway:
    return FlinkGateway(cfg)


def get_flink() -> FlinkGateway:
    return _FLINK


_FLINK: FlinkGateway = init_flink(None)  # 占位,main.py 会覆盖
