#!/usr/bin/env bash
# Manage the customer-side db-proxy process on Linux.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd -- "${DB_PROXY_DIR:-$SCRIPT_DIR}" && pwd -P)" || {
  printf '[db-proxy] ERROR: 服务目录不存在: %s\n' "${DB_PROXY_DIR:-$SCRIPT_DIR}" >&2
  exit 1
}
PYTHON="${DB_PROXY_PYTHON:-/opt/spark/spark4/py312/bin/python3.12}"
SPARK_HOME="${DB_PROXY_SPARK_HOME:-/opt/spark4-orc/}"
SPARK_CONF_DIR="${DB_PROXY_SPARK_CONF_DIR:-/opt/spark/thrift-conf}"
HOST="${DB_PROXY_HOST:-0.0.0.0}"
PORT="${DB_PROXY_PORT:-8756}"
PROJECT_ROOT="$(cd -- "$APP_DIR/../.." && pwd -P)"
CSV_FILE="${DB_PROXY_CSV:-$PROJECT_ROOT/bi_hosts_databases.csv}"
SYNC_SCRIPT="${DB_PROXY_SYNC_SCRIPT:-$APP_DIR/sync_datasources.py}"
START_TIMEOUT="${DB_PROXY_START_TIMEOUT:-45}"
STOP_TIMEOUT="${DB_PROXY_STOP_TIMEOUT:-30}"
LOG_LINES="${DB_PROXY_LOG_LINES:-100}"
PID_FILE="$APP_DIR/db-proxy.pid"
LOG_FILE="$APP_DIR/db-proxy.log"
CONFIG_FILE="$APP_DIR/datasources.json"

usage() {
  cat <<'USAGE'
Usage: ./manage.sh <command>

Commands:
  start              Validate config and start db-proxy in background
  stop               Stop the matching db-proxy process
  restart            Stop, then start db-proxy
  status             Show process and listening-port status
  logs [--follow]    Show recent log lines; follow continuously with --follow
  help               Show this help

Environment overrides:
  DB_PROXY_DIR, DB_PROXY_CSV, DB_PROXY_SYNC_SCRIPT, DB_PROXY_PYTHON,
  DB_PROXY_SPARK_HOME, DB_PROXY_SPARK_CONF_DIR, DB_PROXY_HOST, DB_PROXY_PORT,
  DB_PROXY_START_TIMEOUT, DB_PROXY_STOP_TIMEOUT, DB_PROXY_LOG_LINES
USAGE
}

fail() {
  printf '[db-proxy] ERROR: %s\n' "$*" >&2
  return 1
}

is_managed_pid() {
  local pid="$1" cwd command_line
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]] || return 1
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$cwd" == "$APP_DIR" ]] || return 1
  command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$command_line" == *"$PYTHON -m uvicorn main:app --host $HOST --port $PORT"* ]]
}

managed_pids() {
  local proc_dir pid
  for proc_dir in /proc/[0-9]*; do
    [[ -d "$proc_dir" ]] || continue
    pid="${proc_dir##*/}"
    if is_managed_pid "$pid"; then
      printf '%s\n' "$pid"
    fi
  done
}

port_is_open() {
  "$PYTHON" - "$HOST" "$PORT" <<'PY' >/dev/null 2>&1
import socket
import sys

host, port = sys.argv[1], int(sys.argv[2])
if host in ('0.0.0.0', ''):
    host = '127.0.0.1'
elif host == '::':
    host = '::1'
with socket.socket() as sock:
    sock.settimeout(0.3)
    sys.exit(0 if sock.connect_ex((host, port)) == 0 else 1)
PY
}

sync_datasources() {
  [[ -f "$SYNC_SCRIPT" ]] || fail "找不到 CSV 同步脚本: $SYNC_SCRIPT" || return 1
  [[ -f "$CSV_FILE" ]] || fail "找不到维护 CSV: $CSV_FILE (可用 DB_PROXY_CSV 指定路径)" || return 1
  printf '[db-proxy] 正在同步数据源: %s -> %s\n' "$CSV_FILE" "$CONFIG_FILE"
  if ! "$PYTHON" "$SYNC_SCRIPT" --csv "$CSV_FILE" --config "$CONFIG_FILE"; then
    fail "CSV 同步失败，db-proxy 未启动"
    return 1
  fi
}

validate_settings() {
  [[ -x "$PYTHON" ]] || fail "Python 不存在或不可执行: $PYTHON" || return 1
  [[ -d "$APP_DIR" ]] || fail "服务目录不存在: $APP_DIR" || return 1
  [[ -f "$APP_DIR/main.py" ]] || fail "找不到 $APP_DIR/main.py" || return 1
  [[ -f "$CONFIG_FILE" ]] || fail "找不到配置文件 $CONFIG_FILE" || return 1
  [[ "$PORT" =~ ^[0-9]+$ ]] && ((10#$PORT > 0 && 10#$PORT < 65536)) || fail "端口无效: $PORT" || return 1
  [[ "$START_TIMEOUT" =~ ^[0-9]+$ ]] || fail "启动超时必须是整数秒" || return 1
  [[ "$STOP_TIMEOUT" =~ ^[0-9]+$ ]] || fail "停止超时必须是整数秒" || return 1
  [[ "$LOG_LINES" =~ ^[0-9]+$ ]] || fail "日志行数必须是整数" || return 1
  "$PYTHON" - "$CONFIG_FILE" <<'PY'
import json
import sys
with open(sys.argv[1], encoding='utf-8') as stream:
    json.load(stream)
PY
}

start() {
  local -a pids=()
  local pid
  validate_settings || return 1
  cd "$APP_DIR"

  mapfile -t pids < <(managed_pids)
  if ((${#pids[@]})); then
    if ((${#pids[@]} == 1)); then
      (umask 077; printf '%s\n' "${pids[0]}" > "$PID_FILE")
      printf '[db-proxy] 已在运行，PID=%s\n' "${pids[0]}"
      return 0
    fi
    printf '[db-proxy] 发现多个匹配进程，拒绝重复启动: %s\n' "${pids[*]}" >&2
    return 1
  fi

  if port_is_open; then
    fail "${HOST}:${PORT} 已被其他进程监听，拒绝启动"
    return 1
  fi

  sync_datasources || return 1
  chmod 600 "$CONFIG_FILE"
  export SPARK_HOME SPARK_CONF_DIR
  export PYSPARK_PYTHON="$PYTHON"
  export PYSPARK_DRIVER_PYTHON="$PYTHON"
  export PATH="${SPARK_HOME%/}/bin:${SPARK_HOME%/}/sbin:${PATH:-/usr/bin:/bin}"

  printf '[db-proxy] 正在启动 (%s:%s)...\n' "$HOST" "$PORT"
  (umask 077; nohup "$PYTHON" -m uvicorn main:app \
    --host "$HOST" --port "$PORT" \
    >> "$LOG_FILE" 2>&1 </dev/null & echo $! > "$PID_FILE")
  pid="$(<"$PID_FILE")"

  for ((; START_TIMEOUT > 0; START_TIMEOUT--)); do
    if ! is_managed_pid "$pid"; then
      rm -f "$PID_FILE"
      printf '[db-proxy] 启动失败，请查看日志: %s\n' "$LOG_FILE" >&2
      tail -n 40 "$LOG_FILE" >&2 || true
      return 1
    fi
    if port_is_open; then
      printf '[db-proxy] 已启动，PID=%s，监听 %s:%s，日志=%s\n' "$pid" "$HOST" "$PORT" "$LOG_FILE"
      return 0
    fi
    sleep 1
  done

  printf '[db-proxy] 等待端口超时；进程仍在运行，PID=%s。请检查日志: %s\n' "$pid" "$LOG_FILE" >&2
  return 1
}

stop_one() {
  local pid="$1" elapsed=0
  is_managed_pid "$pid" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  while ((elapsed < STOP_TIMEOUT)); do
    is_managed_pid "$pid" || return 0
    sleep 1
    ((elapsed += 1))
  done
  if is_managed_pid "$pid"; then
    printf '[db-proxy] PID=%s 未在 %s 秒内退出，发送 SIGKILL\n' "$pid" "$STOP_TIMEOUT" >&2
    kill -KILL "$pid" 2>/dev/null || true
  fi
  for _ in {1..5}; do
    is_managed_pid "$pid" || return 0
    sleep 1
  done
  fail "无法停止 PID=$pid"
}

stop() {
  local -a pids=()
  mapfile -t pids < <(managed_pids)
  if ((${#pids[@]} == 0)); then
    rm -f "$PID_FILE"
    printf '[db-proxy] 当前未运行\n'
    return 0
  fi
  printf '[db-proxy] 正在停止 PID: %s\n' "${pids[*]}"
  local pid
  for pid in "${pids[@]}"; do
    stop_one "$pid" || return 1
  done
  rm -f "$PID_FILE"
  printf '[db-proxy] 已停止\n'
}

status() {
  local -a pids=()
  mapfile -t pids < <(managed_pids)
  if ((${#pids[@]} == 0)); then
    printf '[db-proxy] 未运行'
    if port_is_open; then
      printf '；端口 %s:%s 被其他进程占用' "$HOST" "$PORT"
    fi
    printf '\n'
    return 1
  fi
  printf '[db-proxy] 运行中，PID: %s\n' "${pids[*]}"
  if port_is_open; then
    printf '[db-proxy] 监听端口可连接: %s:%s\n' "$HOST" "$PORT"
  else
    printf '[db-proxy] 进程存在，但监听端口暂不可连接\n' >&2
    return 1
  fi
}

logs() {
  [[ -f "$LOG_FILE" ]] || fail "日志文件不存在: $LOG_FILE" || return 1
  if [[ "${1:-}" == "--follow" ]]; then
    tail -n "$LOG_LINES" -f "$LOG_FILE"
  elif [[ $# -eq 0 ]]; then
    tail -n "$LOG_LINES" "$LOG_FILE"
  else
    fail "logs 仅接受可选参数 --follow"
  fi
}

cmd="${1:-}"
shift || true
case "$cmd" in
  start) [[ $# -eq 0 ]] || { fail 'start 不接受参数'; exit 2; }; start ;;
  stop) [[ $# -eq 0 ]] || { fail 'stop 不接受参数'; exit 2; }; stop ;;
  restart) [[ $# -eq 0 ]] || { fail 'restart 不接受参数'; exit 2; }; stop && start ;;
  status) [[ $# -eq 0 ]] || { fail 'status 不接受参数'; exit 2; }; status ;;
  logs|log) logs "$@" ;;
  help|-h|--help) usage ;;
  '') usage; exit 2 ;;
  *) fail "未知命令: $cmd"; usage; exit 2 ;;
esac
