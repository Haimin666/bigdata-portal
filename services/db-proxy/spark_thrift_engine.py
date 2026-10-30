"""Spark SQL transport through a local Beeline process (no SparkSession)."""

import csv
from collections import deque
import os
import re
import select
import signal
import socket
import subprocess
import threading
import time
import uuid
from typing import Any, Dict, Optional
from urllib.parse import unquote, urlsplit


# Logs retain the latest 1 MiB per channel; each poll reads at most 64 KiB/channel.
MAX_LOG_BYTES = 1024 * 1024
LOG_READ_BYTES = 64 * 1024
LOG_LINE_BYTES = 4096
MAX_CSV_FIELD_BYTES = 8 * 1024 * 1024
READER_WAIT_SECONDS = 2
STOP_WAIT_SECONDS = 1
# csv exposes only a process-wide character ceiling. Enforce UTF-8 bytes below too.
csv.field_size_limit(MAX_CSV_FIELD_BYTES)
_SECRET_ASSIGNMENT = re.compile(
    r'''(?ix)\b(password|passwd|pwd|token|secret)\b(\s*[=:]\s*)
    ("(?:\\.|""|[^"\\])*(?:"|$)|'(?:\\.|''|[^'\\])*(?:'|$)|[^\r\n]+)''')


def _pipe_lines(stream, stop, max_line_bytes, truncate=False):
    """Read bounded chunks; POSIX pipes never block shutdown waiting for EOF."""
    pending = bytearray()
    discarded = False
    fd = stream.fileno()
    while not stop.is_set():
        if os.name == "posix" and not select.select([fd], [], [], 0.05)[0]:
            continue
        try:
            chunk = os.read(fd, 8192)
        except BlockingIOError:
            continue
        if not chunk:
            if pending:
                yield pending.decode("utf-8", errors="replace")
            return
        pieces = chunk.split(b"\n")
        for index, piece in enumerate(pieces):
            ceiling = max_line_bytes()
            if not discarded:
                if len(pending) + len(piece) > ceiling:
                    if not truncate:
                        raise ValueError("Beeline CSV2 field exceeds the 8 MiB limit")
                    pending.extend(piece[:max(0, ceiling - len(pending))])
                    discarded = True
                else:
                    pending.extend(piece)
            if index < len(pieces) - 1:
                yield pending.decode("utf-8", errors="replace") + "\n"
                pending.clear()
                discarded = False


def _join_readers(readers, timeout):
    deadline = time.monotonic() + timeout
    for reader in readers:
        reader.join(timeout=max(0, deadline - time.monotonic()))
    return all(not reader.is_alive() for reader in readers)


def _diagnostic_excerpt(head, tail, max_chars):
    tail_lines = list(tail)
    overlap = min(len(head), len(tail_lines))
    while overlap and head[-overlap:] != tail_lines[:overlap]:
        overlap -= 1
    text = "".join(head + tail_lines[overlap:])
    if len(text) <= max_chars:
        return text
    marker = "\n... diagnostic truncated ...\n"
    budget = max(0, max_chars - len(marker))
    first = (budget + 1) // 2
    last = budget - first
    return text[:first] + marker + (text[-last:] if last else "")


def _mask_sql(sql: str) -> str:
    """Mask comments and quoted values while retaining SQL token positions."""
    chars = list(sql)
    i = 0
    while i < len(sql):
        start = i
        if sql.startswith("--", i):
            end = sql.find("\n", i)
            i = len(sql) if end < 0 else end
            chars[start:i] = " " * (i - start)
        elif sql.startswith("/*", i):
            depth = 1
            i += 2
            while i < len(sql) and depth:
                if sql.startswith("/*", i):
                    depth += 1
                    i += 2
                elif sql.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            if depth:
                raise ValueError("unterminated SQL comment")
            chars[start:i] = " " * (i - start)
        elif sql[i] in ("'", '"', "`"):
            quote = sql[i]
            i += 1
            while i < len(sql):
                if sql[i] == "\\":
                    i += 2
                elif sql[i] == quote:
                    i += 1
                    if i < len(sql) and sql[i] == quote:
                        i += 1
                    else:
                        break
                else:
                    i += 1
            else:
                raise ValueError("unterminated SQL quote")
            chars[start:i] = "_" * (i - start)
        else:
            i += 1
    return "".join(chars)


def _strip_comments(sql: str) -> str:
    """Remove SQL comments while preserving quoted text and line boundaries."""
    out = list(sql)
    i = 0
    while i < len(sql):
        if sql[i] in ("'", '"', "`"):
            quote = sql[i]
            i += 1
            while i < len(sql):
                if sql[i] == "\\":
                    i += 2
                elif sql[i] == quote:
                    i += 1
                    if i < len(sql) and sql[i] == quote:
                        i += 1
                    else:
                        break
                else:
                    i += 1
        elif sql.startswith("--", i):
            start = i
            end = sql.find("\n", i)
            i = len(sql) if end < 0 else end
            for pos in range(start, i):
                out[pos] = " "
        elif sql.startswith("/*", i):
            start = i
            depth = 1
            i += 2
            while i < len(sql) and depth:
                if sql.startswith("/*", i):
                    depth += 1
                    i += 2
                elif sql.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            if depth:
                raise ValueError("unterminated SQL comment")
            for pos in range(start, i):
                if out[pos] not in "\r\n":
                    out[pos] = " "
        else:
            i += 1
    return "".join(out)


def _apply_row_limit(sql: str, default_limit: int, max_limit: int):
    """Add/cap the top-level SELECT limit without touching comments or literals."""
    masked = _mask_sql(sql)
    cap = max(1, int(max_limit))
    fallback = min(max(1, int(default_limit)), cap)

    semicolon = re.search(r";", masked)
    if semicolon and masked[semicolon.end():].strip():
        raise ValueError("Spark Thrift accepts only one SQL statement")
    statement_end = semicolon.start() if semicolon else len(masked)
    if not re.match(r"^\s*(SELECT|WITH)\b", masked, re.IGNORECASE):
        return sql, fallback, False

    depth = 0
    top_level = []
    for match in re.finditer(r"\bLIMIT\b|\bOFFSET\b|[()]", masked[:statement_end], re.IGNORECASE):
        token = match.group(0)
        if token == "(":
            depth += 1
        elif token == ")":
            depth = max(0, depth - 1)
        elif depth == 0:
            top_level.append((token.upper(), match))

    top_level_limits = [match for token, match in top_level if token == "LIMIT"]
    if top_level_limits:
        limit_match = top_level_limits[-1]
        next_offset = next(
            (match for token, match in top_level
             if token == "OFFSET" and match.start() > limit_match.end()),
            None,
        )
        expression_end = next_offset.start() if next_offset else statement_end
        expression_start = limit_match.end()
        while expression_start < expression_end and masked[expression_start].isspace():
            expression_start += 1
        expression_end = min(expression_end, len(masked))
        while expression_end > expression_start and masked[expression_end - 1].isspace():
            expression_end -= 1
        expression = masked[expression_start:expression_end]
        if not expression:
            raise ValueError("Spark LIMIT requires an expression")

        if expression.upper() == "ALL":
            return (sql[:expression_start] + str(cap) + sql[expression_end:], cap, True)
        if expression.isdigit():
            requested = int(expression)
            if requested > cap:
                return (sql[:expression_start] + str(cap) + sql[expression_end:], cap, True)
            return sql, requested, False

        # Spark accepts foldable expressions in LIMIT; clamp those without duplicating the clause.
        raw_expression = sql[expression_start:expression_end]
        bounded_expression = "LEAST((%s), %s)" % (raw_expression, cap)
        return (sql[:expression_start] + bounded_expression + sql[expression_end:], cap, True)

    top_level_offsets = [match for token, match in top_level if token == "OFFSET"]
    if top_level_offsets:
        offset_match = top_level_offsets[0]
        insert_at = len(masked[:offset_match.start()].rstrip())
        suffix = sql[insert_at:]
        separator = "" if suffix[:1].isspace() else " "
        bounded_sql = sql[:insert_at].rstrip() + " LIMIT " + str(fallback) + separator + suffix
        return bounded_sql, fallback, True

    end = len(masked[:statement_end].rstrip())
    if end and masked[end - 1] == ";":
        end -= 1
        while end and masked[end - 1].isspace():
            end -= 1
    return sql[:end].rstrip() + " LIMIT " + str(fallback) + sql[end:], fallback, True


def _ensure_beeline_terminator(sql: str) -> str:
    """Beeline -e expects a terminated statement; put the terminator after trailing comments."""
    if _mask_sql(sql).rstrip().endswith(";"):
        return sql
    return sql.rstrip() + "\n;"


class SparkThriftEngine:
    supports_job_cancellation = True

    def __init__(self, cfg: Dict[str, Any], base_dir: str) -> None:
        self.cfg = cfg
        self.base_dir = base_dir
        self._lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._stop_lock = threading.Lock()
        self._log_lock = threading.Lock()
        self._logs = {"jvm": bytearray(), "audit": bytearray()}
        self._log_ends = {"jvm": 0, "audit": 0}
        self._process = None
        self._owner_id = None
        self._pending_cancelled_owners = set()
        self._cancel_flag = threading.Event()
        self._state = "idle" if self.enabled else "disabled"
        self._busy = False
        self._last_error = None

    @property
    def enabled(self) -> bool:
        return bool(self.cfg.get("enabled", False))

    def _redact(self, value: Any) -> str:
        text = str(value)
        secrets = [str(self.cfg.get("password") or "")]
        secrets.extend(match.group(3).strip("\"'") for match in
                       _SECRET_ASSIGNMENT.finditer(str(self.cfg.get("jdbcUrl", ""))))
        for secret in secrets:
            if secret:
                text = text.replace(secret, "[REDACTED]")
        text = re.sub(r"://[^/@\r\n]+:[^/@\r\n]+@", "://[REDACTED]@", text)
        return _SECRET_ASSIGNMENT.sub(r"\1\2[REDACTED]", text)

    def _ensure_thrift_server(self) -> None:
        command = self.cfg.get("autoStartCommand")
        if not command:
            return
        jdbc = str(self.cfg.get("jdbcUrl", "jdbc:hive2://127.0.0.1:10001/default"))
        parsed = urlsplit(jdbc.removeprefix("jdbc:"))
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 10001
        timeout = max(1, float(self.cfg.get("autoStartTimeout", 120)))

        def is_open():
            try:
                with socket.create_connection((host, port), timeout=1):
                    return True
            except OSError:
                return False

        if is_open():
            return
        if not isinstance(command, list) or not command or not all(isinstance(arg, str) for arg in command):
            raise ValueError("spark.autoStartCommand must be a non-empty string array")
        self._log("audit", "Thrift 服务未就绪，正在执行自动启动命令。\n")
        try:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError("Spark Thrift 自动启动失败: %s" % error)
        if result.stdout:
            self._log("jvm", result.stdout[-LOG_READ_BYTES:])
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if is_open():
                self._log("audit", "Thrift 服务已就绪。\n")
                return
            time.sleep(1)
        raise RuntimeError("Spark Thrift 启动命令已结束(code=%s)，但 JDBC 端口 %s:%s 未就绪" %
                           (result.returncode, host, port))

    def _log(self, name: str, text: str) -> None:
        data = self._redact(text).encode("utf-8")
        with self._log_lock:
            self._log_ends[name] += len(data)
            self._logs[name].extend(data)
            if len(self._logs[name]) > MAX_LOG_BYTES:
                del self._logs[name][:-MAX_LOG_BYTES]
                while self._logs[name] and self._logs[name][0] & 0xC0 == 0x80:
                    del self._logs[name][0]

    def status(self) -> Dict[str, Any]:
        with self._state_lock:
            result = {
                "enabled": self.enabled,
                "backend": "thrift",
                "state": self._state,
                "busy": self._busy,
                "config": {
                    "jdbcUrl": self._redact(self.cfg.get("jdbcUrl", "jdbc:hive2://127.0.0.1:10001/default")),
                    "user": self.cfg.get("user", "root"),
                    "defaultLimit": int(self.cfg.get("defaultLimit", 1000)),
                    "maxLimit": int(self.cfg.get("maxLimit", 500000)),
                },
            }
            if self._last_error:
                result["lastError"] = self._last_error
            return result

    def read_logs(self, offsets: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
        offsets = offsets or {}
        content = []
        positions = {}
        with self._log_lock:
            for name, data in self._logs.items():
                base = self._log_ends[name] - len(data)
                offset = max(base, min(int(offsets.get(name, 0)), self._log_ends[name])) - base
                end = min(offset + LOG_READ_BYTES, len(data))
                while end < len(data) and data[end] & 0xC0 == 0x80:
                    end -= 1
                content.append(bytes(data[offset:end]).decode("utf-8", errors="replace"))
                positions[name] = base + end
            files = dict(self._log_ends)
        return {"content": "".join(content), "offsets": positions, "files": files}

    def _terminate(self, process) -> None:
        with self._stop_lock:
            def send(sig):
                try:
                    if os.name == "posix":
                        os.killpg(process.pid, sig)
                    elif sig == signal.SIGTERM:
                        process.terminate()
                    else:
                        process.kill()
                except ProcessLookupError:
                    pass

            send(signal.SIGTERM)
            try:
                process.wait(timeout=STOP_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                pass
            # The parent may exit before children that still hold stdout/stderr open.
            send(signal.SIGKILL)
            try:
                process.wait(timeout=STOP_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                raise RuntimeError("Beeline process did not stop after SIGKILL") from None

    def cancel(self, owner_id: Optional[str] = None) -> bool:
        with self._state_lock:
            if owner_id is not None and (not self._busy or self._owner_id != owner_id):
                self._pending_cancelled_owners.add(owner_id)
                return True
            if not self._busy:
                return False
            self._cancel_flag.set()
            process = self._process
        if process is not None:
            self._terminate(process)
        return True

    def finish_job(self, owner_id: str) -> None:
        """Discard a pending cancel marker if the job completed before it began."""
        with self._state_lock:
            self._pending_cancelled_owners.discard(owner_id)

    def execute_sql(self, sql: str, write_unlocked: bool = False,
                    timeout_ms: int = 600000, owner_id: Optional[str] = None,
                    on_start=None) -> Dict[str, Any]:
        default_limit = int(self.cfg.get("defaultLimit", 1000))
        max_limit = int(self.cfg.get("maxLimit", 500000))
        executable_sql = _strip_comments(sql)
        bounded_sql, limit, may_be_truncated = _apply_row_limit(executable_sql, default_limit, max_limit)
        result = self._execute(bounded_sql, timeout_ms, limit, owner_id, on_start)
        if may_be_truncated and len(result["rows"]) >= limit:
            result["truncated"] = True
        return result

    def execute_schema_sql(self, sql: str, timeout_ms: int = 600000) -> Dict[str, Any]:
        return self.execute_sql(sql, timeout_ms=timeout_ms)

    def export_sql(self, sql: str, job_id: str, timeout_ms: int = 7200000,
                   owner_id: Optional[str] = None, on_start=None) -> Dict[str, Any]:
        masked = _mask_sql(sql).rstrip()
        if masked.endswith(";"):
            masked = masked[:-1].rstrip()
        if ";" in masked:
            raise ValueError("HDFS export accepts one SQL statement")
        if not re.match(r"^\s*(SELECT|WITH)\b", masked, re.IGNORECASE):
            raise ValueError("HDFS export only supports SELECT/WITH queries")
        if re.search(r"\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|LOAD|OVERWRITE|INTO)\b",
                     masked, re.IGNORECASE):
            raise ValueError("HDFS export only supports read-only queries")
        root = str(self.cfg.get("exportPath") or "hdfs:///tmp/db-proxy-spark-exports").rstrip("/")
        uri = urlsplit(root)
        if (uri.scheme != "hdfs" or not uri.path.startswith("/") or uri.query or uri.fragment
                or uri.username or uri.password or any(ord(char) < 32 for char in root)
                or ".." in unquote(uri.path).split("/")):
            raise ValueError("spark.exportPath must be a safe absolute HDFS URI")
        safe_job_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(job_id))[:100]
        path = "%s/spark_export_%s_%s" % (root, safe_job_id, uuid.uuid4().hex)
        quoted_path = path.replace("\\", "\\\\").replace("'", "\\'")
        export_query = _strip_comments(sql).strip()
        if export_query.endswith(";"):
            export_query = export_query[:-1].rstrip()
        statement = "INSERT OVERWRITE DIRECTORY '%s' USING CSV OPTIONS (header 'true') %s" % (
            quoted_path, export_query)
        result = self._execute(statement, timeout_ms, 0, owner_id, on_start)
        return {"hdfsPath": path, "costMs": result["costMs"]}

    def _execute(self, sql: str, timeout_ms: int, limit: int,
                 owner_id: Optional[str] = None, on_start=None) -> Dict[str, Any]:
        if not self.enabled:
            raise RuntimeError("spark engine not enabled")
        if self.cfg.get("password"):
            raise ValueError("spark.password is unsupported; use the no-password Thrift connection")
        if re.search(r"(?i)(?:password|passwd|pwd|token|secret)\s*=|://[^/@\r\n]+:[^/@\r\n]+@",
                     str(self.cfg.get("jdbcUrl", ""))):
            raise ValueError("JDBC credentials are unsupported; use the no-password Thrift connection")
        if not sql.strip():
            raise ValueError("empty sql")
        if len(sql) > int(self.cfg.get("maxSqlLen", 65536)):
            raise ValueError("sql too long")
        with self._lock:
            started = time.monotonic()
            with self._state_lock:
                self._busy = True
                self._owner_id = owner_id
                self._state = "running"
                self._last_error = None
                self._cancel_flag.clear()
                if owner_id is not None and owner_id in self._pending_cancelled_owners:
                    self._pending_cancelled_owners.discard(owner_id)
                    self._cancel_flag.set()
            process = None
            readers = []
            columns = []
            rows = []
            diagnostics_head = []
            diagnostics_tail = deque(maxlen=20)
            stdout_diagnostics_head = []
            stdout_diagnostics_tail = deque(maxlen=20)
            parse_errors = []
            truncated = False
            stop_readers = threading.Event()

            def remember_diagnostic(head, tail, text):
                if len(head) < 20:
                    head.append(text)
                tail.append(text)

            def lines(stream, csv_output=False):
                if csv_output:
                    max_line = lambda: max(1, len(columns)) * (2 * MAX_CSV_FIELD_BYTES + 3)
                else:
                    max_line = lambda: LOG_LINE_BYTES
                for line in _pipe_lines(stream, stop_readers, max_line, truncate=not csv_output):
                    excerpt = self._redact(line[:LOG_LINE_BYTES]).encode("utf-8")[:LOG_LINE_BYTES]
                    text = excerpt.decode("utf-8", errors="replace")
                    if csv_output:
                        if re.match(r'^\s*"?(?:error|exception|analysisexception|failed)\b',
                                    text, re.IGNORECASE):
                            remember_diagnostic(stdout_diagnostics_head,
                                                stdout_diagnostics_tail, text)
                    else:
                        self._log("jvm", text + ("\n" if not text.endswith("\n") else ""))
                        remember_diagnostic(diagnostics_head, diagnostics_tail, text)
                    yield line

            def check_fields(record):
                if any(len(field.encode("utf-8")) > MAX_CSV_FIELD_BYTES for field in record):
                    raise ValueError("Beeline CSV2 field exceeds the 8 MiB limit")

            def read_stdout():
                nonlocal columns, truncated
                try:
                    records = csv.reader(lines(process.stdout, csv_output=True), strict=True)
                    columns = next(records, [])
                    check_fields(columns)
                    for record in records:
                        if not record:
                            continue
                        check_fields(record)
                        if len(record) != len(columns):
                            raise ValueError("invalid Beeline CSV2 row width")
                        if len(rows) < limit:
                            rows.append(dict(zip(columns, [None if cell in ("NULL", "\\N") else cell
                                                           for cell in record])))
                        else:
                            truncated = True
                except Exception as error:
                    if isinstance(error, csv.Error) and "field larger" in str(error):
                        message = "Beeline CSV2 field exceeds the 8 MiB limit"
                    else:
                        message = self._redact(error)
                    parse_errors.append(message)
                    # Continue draining the pipe so malformed output cannot block Beeline.
                    for _line in _pipe_lines(process.stdout, stop_readers,
                                             lambda: LOG_LINE_BYTES, truncate=True):
                        pass

            def read_stderr():
                for _line in lines(process.stderr):
                    pass

            try:
                self._ensure_thrift_server()
                if on_start:
                    on_start()
                if self._cancel_flag.is_set():
                    raise RuntimeError("查询已取消(cancelled)")
                beeline = self.cfg.get("beelinePath") or os.path.join(
                    os.environ.get("SPARK_HOME", ""), "bin", "beeline")
                beeline_sql = _ensure_beeline_terminator(sql)
                args = [beeline, "-u", self.cfg.get("jdbcUrl", "jdbc:hive2://127.0.0.1:10001/default"),
                        "-n", self.cfg.get("user", "root"), "--outputformat=csv2", "--showHeader=true",
                        "--silent=true", "--force=false", "--color=false", "-e", beeline_sql]
                env = dict(os.environ)
                env["JAVA_TOOL_OPTIONS"] = (env.get("JAVA_TOOL_OPTIONS", "") +
                                            " -Ddisable.quoting.for.sv=false").strip()
                self._log("audit", "Beeline SQL started\n")
                process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           stdin=subprocess.DEVNULL, bufsize=0, env=env,
                                           start_new_session=os.name == "posix")
                if os.name == "posix":
                    os.set_blocking(process.stdout.fileno(), False)
                    os.set_blocking(process.stderr.fileno(), False)
                with self._state_lock:
                    self._process = process
                for target in (read_stdout, read_stderr):
                    reader = threading.Thread(target=target, daemon=True)
                    reader.start()
                    readers.append(reader)
                if self._cancel_flag.is_set():
                    self._terminate(process)
                try:
                    exit_code = process.wait(timeout=timeout_ms / 1000 if timeout_ms > 0 else None)
                except subprocess.TimeoutExpired:
                    self._cancel_flag.set()
                    self._terminate(process)
                    raise RuntimeError("查询超时(timeout)，Beeline 已停止")
                if not _join_readers(readers, READER_WAIT_SECONDS):
                    self._terminate(process)
                    raise RuntimeError("Beeline output readers did not finish")
                if self._cancel_flag.is_set():
                    raise RuntimeError("查询已取消(cancelled)")
                if exit_code:
                    diagnostic = _diagnostic_excerpt(
                        diagnostics_head, diagnostics_tail, 1400)
                    stdout_diagnostic = _diagnostic_excerpt(
                        stdout_diagnostics_head, stdout_diagnostics_tail, 600)
                    raise RuntimeError("Beeline exited with code %s: %s" %
                                       (exit_code, diagnostic + stdout_diagnostic))
                if parse_errors:
                    raise RuntimeError("Beeline CSV2 parse failed: %s" % parse_errors[0])
                self._log("audit", "Beeline SQL finished\n")
                with self._state_lock:
                    self._state = "idle"
                return {"columns": columns, "rows": rows,
                        "costMs": int((time.monotonic() - started) * 1000), "truncated": truncated}
            except Exception as error:
                message = self._redact(error)
                self._log("audit", "Beeline SQL failed: %s\n" % message)
                with self._state_lock:
                    self._state = "error"
                    self._last_error = message
                raise RuntimeError(message) from None
            finally:
                try:
                    if process is not None:
                        if process.poll() is None:
                            self._terminate(process)
                        stop_readers.set()
                        _join_readers(readers, STOP_WAIT_SECONDS)
                        process.stdout.close()
                        process.stderr.close()
                finally:
                    with self._state_lock:
                        self._process = None
                        self._owner_id = None
                        self._busy = False
