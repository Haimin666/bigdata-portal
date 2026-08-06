#!/usr/bin/env bash
# HDFS 磁盘检测服务启停(独立进程,服务器本机运行,需 hadoop 客户端提供 hdfs oiv)
#
# 用法:scripts/hdfsscan.sh <start|stop|restart|status>
#
# 前置:服务器装有 hadoop(可执行 hdfs oiv);NameNode 地址等用环境变量覆盖:
#   HDFS_URL、PORT(默认 9911)、OIV_CMD、TOP_N
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/.hdfsscan.pid"
LOG_FILE="$ROOT/.hdfsscan.log"
SERVICE="$ROOT/services/hdfs-scan/server.js"

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

start() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "[hdfsscan] 已在运行(PID $(cat "$PID_FILE"))"
    exit 0
  fi
  echo "[hdfsscan] 启动 $SERVICE ..."
  nohup node "$SERVICE" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 1
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "[hdfsscan] 启动失败,见 $LOG_FILE" >&2
    exit 1
  fi
  echo "[hdfsscan] 已启动(PID $(cat "$PID_FILE"),日志 $LOG_FILE)"
}

stop() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "[hdfsscan] 已停止"
  else
    rm -f "$PID_FILE"
    echo "[hdfsscan] 未运行"
  fi
}

status() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "[hdfsscan] 运行中(PID $(cat "$PID_FILE"))"
    curl -s -m 3 "http://127.0.0.1:${PORT:-9911}/health" || echo "[hdfsscan] 健康检查不可达"
  else
    echo "[hdfsscan] 未运行"
  fi
}

cmd="${1:-}"
case "$cmd" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  -h|--help|help) usage ;;
  *) echo "未知命令:$cmd" >&2; usage 1 ;;
esac
