#!/usr/bin/env python3
"""Read-only connectivity check for every configured db-proxy datasource."""

from __future__ import annotations

import argparse
import concurrent.futures
import re
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from urllib.parse import quote


@dataclass
class ProbeResult:
    name: str
    engine: str
    elapsed_ms: int
    error: Optional[str] = None


def _engine_names(config: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {
        str(item.get("name")): item
        for item in config.get("datasources", [])
        if isinstance(item, dict) and item.get("name")
    }


def _engine_label(name: str, datasource: Any, source_configs: Dict[str, Dict[str, Any]]) -> str:
    source_config = source_configs.get(name, {})
    source_type = str(source_config.get("sourceType", "")).strip().casefold()
    label = str(source_config.get("label", "")).strip().casefold()
    if source_type == "doris" or "doris" in label:
        return "Doris"
    return {"mysql": "MySQL", "oracle": "Oracle", "impala": "Impala"}.get(
        datasource.type, datasource.type.upper()
    )


def _redact_text(value: str, password: str = "") -> str:
    message = " ".join(value.split()) or "no error detail"
    if password:
        for secret in {password, quote(password, safe="")}:
            if len(secret) >= 3:
                message = message.replace(secret, "<redacted>")
    message = re.sub(
        r"(?i)\b(password|passwd|pwd|token|secret)(\s*[:=]\s*)(?:'[^']*'|\"[^\"]*\"|[^\s,;]+)",
        r"\1\2<redacted>",
        message,
    )
    message = re.sub(
        r"(?i)\b(mysql|oracle)://[^\s/@]+:[^\s/@]+@",
        r"\1://<redacted>@",
        message,
    )
    return message[:600]


def _safe_error(datasource: Any, error: BaseException) -> str:
    password = str(getattr(datasource, "password", ""))
    return _redact_text(str(error), password)


def _probe(name: str, datasource: Any, engine: str, timeout: int) -> ProbeResult:
    started = time.monotonic()
    connection = None
    cursor = None
    error_text: Optional[str] = None
    try:
        connection = datasource.connect(timeout, timeout)
        if datasource.type == "oracle" and hasattr(connection, "call_timeout"):
            connection.call_timeout = timeout * 1000
        cursor = connection.cursor()
        sql = "SELECT 1 FROM dual" if datasource.type == "oracle" else "SELECT 1"
        cursor.execute(sql)
        if cursor.fetchone() is None:
            raise RuntimeError("probe query returned no rows")
    except Exception as error:  # report a per-datasource failure and continue
        error_text = "%s: %s" % (type(error).__name__, _safe_error(datasource, error))
    finally:
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                pass
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
    return ProbeResult(
        name=name,
        engine=engine,
        elapsed_ms=int((time.monotonic() - started) * 1000),
        error=error_text,
    )


def _positive_int(value: str, label: str, maximum: int) -> int:
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("%s must be an integer" % label) from None
    if not 1 <= number <= maximum:
        raise argparse.ArgumentTypeError("%s must be between 1 and %d" % (label, maximum))
    return number


def main_cli(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Probe every configured db-proxy datasource")
    parser.add_argument("--workers", type=lambda value: _positive_int(value, "workers", 32), default=5)
    parser.add_argument("--timeout", type=lambda value: _positive_int(value, "timeout", 60), default=5)
    parser.add_argument("--verbose", action="store_true", help="print successful datasource probes")
    args = parser.parse_args(argv)

    try:
        import main as db_proxy
    except Exception as error:
        print(
            "[db-proxy] ERROR: 无法加载 db-proxy 运行环境（%s: %s）"
            % (type(error).__name__, _redact_text(str(error))[:400]),
            file=sys.stderr,
        )
        return 2

    if not db_proxy.DATASOURCES:
        print("[db-proxy] ERROR: 没有配置可检查的数据源", file=sys.stderr)
        return 2

    source_configs = _engine_names(db_proxy.CONFIG)
    started = time.monotonic()
    print(
        "[db-proxy] 检查 %d 个数据源（并发 %d，单项超时 %d 秒）..."
        % (len(db_proxy.DATASOURCES), args.workers, args.timeout),
        flush=True,
    )
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(
                _probe,
                name,
                datasource,
                _engine_label(name, datasource, source_configs),
                args.timeout,
            ): name
            for name, datasource in db_proxy.DATASOURCES.items()
        }
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            results.append(result)
            if result.error:
                print(
                    "[FAIL] [%s] %s (%d ms): %s"
                    % (result.engine, result.name, result.elapsed_ms, result.error),
                    flush=True,
                )
            elif args.verbose:
                print(
                    "[ OK ] [%s] %s (%d ms)"
                    % (result.engine, result.name, result.elapsed_ms),
                    flush=True,
                )
            if len(results) % 25 == 0 or len(results) == len(db_proxy.DATASOURCES):
                failed_so_far = sum(item.error is not None for item in results)
                print(
                    "[db-proxy] 进度 %d/%d，失败 %d"
                    % (len(results), len(db_proxy.DATASOURCES), failed_so_far),
                    flush=True,
                )

    passed = sum(result.error is None for result in results)
    failed = len(results) - passed
    print(
        "[db-proxy] 完成：总数 %d，通过 %d，失败 %d，总耗时 %.1f 秒"
        % (len(results), passed, failed, time.monotonic() - started)
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main_cli())
