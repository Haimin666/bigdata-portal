#!/usr/bin/env bash
# ============================================================================
# bigdata-portal npm 一键脚本(生产模式:构建 dist + 网关托管)
#
# 用法:scripts/npmctl.sh <command>
#
#   build    仅构建前端(npm run build → dist/,不重启)
#   rebuild  重构并重启:stop → npm run build → start
#   start    后台启动网关(npm run serve,托管 dist/,端口 3000)
#   stop     停止网关(按进程清理)
#   restart  重启网关(不重新构建;需先构建过)
#   status   查看网关进程与健康状态
#
# 进程信息:主进程 PID 记录在项目根 .portal.pid,日志在 .portal.log。
# 端口可用环境变量 PORT 覆盖(默认 3000,与 server/config.js 一致)。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PID_FILE="$ROOT/.portal.pid"
LOG_FILE="$ROOT/.portal.log"
PORT="${PORT:-3000}"
PROC_PATTERN="server/index.js"

cmd="${1:-}"

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# 真实网关进程(node ... server/index.js),可能多于一个则都列出
gateway_pids() {
  pgrep -f "$PROC_PATTERN" || true
}

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

stop() {
  local pids pid
  # 1) 真实网关进程
  pids="$(gateway_pids)"
  if [[ -n "$pids" ]]; then
    echo "[npmctl] 停止网关进程:$pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  fi
  # 2) npm wrapper 主进程(连同其子进程)
  if is_running; then
    pid="$(cat "$PID_FILE")"
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  # 等待退出,超时强杀
  for _ in $(seq 1 20); do
    [[ -z "$(gateway_pids)" ]] && break
    sleep 0.2
  done
  if [[ -n "$(gateway_pids)" ]]; then
    echo "[npmctl] 警告:进程未退出,强制终止" >&2
    pkill -9 -f "$PROC_PATTERN" 2>/dev/null || true
  fi
  echo "[npmctl] 已停止"
}

start() {
  if is_running || [[ -n "$(gateway_pids)" ]]; then
    echo "[npmctl] 网关已在运行(用 status 查看,或先 stop)" >&2
    exit 1
  fi
  if [[ ! -d "$ROOT/dist" ]]; then
    echo "[npmctl] 错误:dist/ 不存在,请先执行 rebuild 或 build" >&2
    exit 1
  fi
  echo "[npmctl] 启动网关(npm run serve)..."
  nohup npm run serve >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 30); do
    if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/api/config"; then
      echo "[npmctl] 网关已启动:http://localhost:${PORT}(日志:$LOG_FILE)"
      return 0
    fi
    sleep 0.3
  done
  echo "[npmctl] 启动超时,请查看 $LOG_FILE" >&2
  exit 1
}

build() {
  echo "[npmctl] npm run build ..."
  npm run build
  echo "[npmctl] 构建完成:dist/"
}

rebuild() {
  stop
  build
  start
}

restart() {
  stop
  start
}

status() {
  local pids
  pids="$(gateway_pids)"
  if [[ -n "$pids" ]]; then
    echo "[npmctl] 状态:运行中(进程:$pids)"
    curl -s -o /dev/null -w "[npmctl] 健康:HTTP %{http_code} http://localhost:${PORT}/api/config\n" \
      "http://127.0.0.1:${PORT}/api/config" || echo "[npmctl] 健康:不可达"
  else
    echo "[npmctl] 状态:未运行"
  fi
}

case "$cmd" in
  build|rebuild|start|stop|restart|status) "$cmd" ;;
  -h|--help|help) usage ;;
  "") echo "[npmctl] 缺少子命令" >&2; usage 1 ;;
  *) echo "[npmctl] 未知命令:$cmd" >&2; usage 1 ;;
esac
