#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# 本地一键启动/停止 db-query 全链路(数据库查询平台本地验证)
#
#   用法:
#     scripts/local-dev.sh rebuild  重建前端 dist + 启动 db-proxy(8756) + 网关(3000) + 前端(3002)
#     scripts/local-dev.sh start   仅启动(不重新构建)
#     scripts/local-dev.sh stop    停止全部本地链路服务并恢复 config.local.json
#     scripts/local-dev.sh restart 先停后启
#     scripts/local-dev.sh status  查看各端口/进程/健康状态
#
#   链路: 浏览器:3002 (vite) → :3000 (Express 网关) → :8756 (db-proxy) → 真实库
#   说明: start 会强制接管 3000 端口(停掉旧实例);config.local.json 的 dbProxyUrl
#         临时指向本地 db-proxy,启动前自动备份,stop 时自动恢复。
# ─────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
CFG="$ROOT/server/config.local.json"
BAK="$CFG.local-dev-bak"

DB_PORT=8756
GW_PORT=3000
FE_PORT=3002
LOCAL_DB_URL="http://127.0.0.1:${DB_PORT}"
FE_ORIGIN="http://localhost:${FE_PORT}"

# ── 工具 ────────────────────────────────────────────────────
log() { printf '[local-dev] %s\n' "$*"; }
die() { log "错误: $*" >&2; exit 1; }

pid_on() { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }
is_up() { [ -n "$(pid_on "$1")" ]; }

stop_port() {
  local port="$1" name="$2" pid
  pid="$(pid_on "$port")"
  if [ -n "$pid" ]; then
    log "停止 $name(:$port) pid=$pid"
    kill "$pid" 2>/dev/null || true
    sleep 1
    # 等 3s,杀不死再强杀
    for _ in 1 2 3; do [ -z "$(pid_on "$port")" ] && break; sleep 1; done
    pid="$(pid_on "$port")"
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  else
    log "$name(:$port) 未运行"
  fi
}

wait_http() {
  local url="$1" name="$2" tries="${3:-20}"
  for _ in $(seq 1 "$tries"); do
    if curl -s -m 2 -o /dev/null "$url"; then log "$name 就绪 $url"; return 0; fi
    sleep 1
  done
  die "$name 启动超时(${tries}s): $url"
}

# ── 子命令 ──────────────────────────────────────────────────
do_start() {
  mkdir -p "$LOG_DIR"
  [ -x "$ROOT/services/db-proxy/.venv/bin/uvicorn" ] || die "未找到 services/db-proxy/.venv(先建 venv 并 pip install -r requirements.txt)"

  # 0) 强制接管三个端口(rebuild 语义:先停后启,含 3000 上的旧实例)
  log "接管端口 :$DB_PORT :$GW_PORT :$FE_PORT(如被占用将先停止)"
  stop_port "$FE_PORT" "前端(vite)"
  stop_port "$GW_PORT" "网关(3000)"
  stop_port "$DB_PORT" "db-proxy"
  sleep 1

  # 1) 备份并改写 config.local.json(dbProxyUrl → 本地)
  if [ ! -f "$BAK" ]; then
    cp "$CFG" "$BAK"
    log "已备份 config.local.json → $(basename "$BAK")"
  fi
  if ! grep -q '"dbProxyUrl": "http://127.0.0.1:8756"' "$CFG"; then
    python3 - "$CFG" "$LOCAL_DB_URL" <<'PY'
import json, sys
p, url = sys.argv[1], sys.argv[2]
c = json.load(open(p))
c['dbProxyUrl'] = url
json.dump(c, open(p, 'w'), ensure_ascii=False, indent=2)
print(f'[local-dev] dbProxyUrl -> {url}')
PY
  fi

  # 2) db-proxy(后端)
  log "启动 db-proxy(:$DB_PORT)"
  (cd "$ROOT/services/db-proxy" && nohup .venv/bin/uvicorn main:app --host 127.0.0.1 --port "$DB_PORT" < /dev/null >> "$LOG_DIR/local-dbproxy.log" 2>&1 & disown)
  wait_http "http://127.0.0.1:$DB_PORT/health" "db-proxy"

  # 3) 网关(Express)
  log "启动网关(:$GW_PORT)"
  (cd "$ROOT" && PORT="$GW_PORT" nohup node server/index.js < /dev/null >> "$LOG_DIR/local-gw.log" 2>&1 & disown)
  wait_http "http://127.0.0.1:$GW_PORT/" "网关"

  # 4) 前端(vite dev,绕过 dev.mjs 自带的 3000 网关)
  log "启动前端(:$FE_PORT,代理 → :$GW_PORT)"
  (cd "$ROOT" && GATEWAY_URL="http://127.0.0.1:$GW_PORT" nohup ./node_modules/.bin/vite < /dev/null >> "$LOG_DIR/local-fe.log" 2>&1 & disown)
  wait_http "http://localhost:$FE_PORT/" "前端"

  echo
  log "全部就绪 ✅  浏览器打开:  $FE_ORIGIN"
  log "  登录后进「数据库查询」→ 选库 → 双击表预览"
  log "  日志: $LOG_DIR/local-{dbproxy,gw,fe}.log"
  log "  停止: scripts/local-dev.sh stop"
}

do_stop() {
  stop_port "$FE_PORT" "前端(vite)"
  stop_port "$GW_PORT" "网关"
  stop_port "$DB_PORT" "db-proxy"
  if [ -f "$BAK" ]; then
    cp "$BAK" "$CFG"
    rm -f "$BAK"
    log "已恢复 config.local.json(dbProxyUrl 回原值)"
  else
    log "无备份,config.local.json 未改动"
  fi
  log "本地链路已全部停止"
}

do_status() {
  printf '%-12s %-8s %-10s %s\n' "服务" "端口" "状态" "地址"
  for spec in "db-proxy:$DB_PORT:http://127.0.0.1:$DB_PORT/health" "网关:$GW_PORT:http://127.0.0.1:$GW_PORT/" "前端:$FE_PORT:$FE_ORIGIN"; do
    IFS=: read -r name port url <<<"$spec"
    if is_up "$port"; then
      printf '%-12s %-8s %-10s %s\n' "$name" "$port" "运行中 ✅" "$url"
    else
      printf '%-12s %-8s %-10s %s\n' "$name" "$port" "未运行" "$url"
    fi
  done
  if [ -f "$BAK" ]; then echo "config.local.json: 已临时指向本地 db-proxy(备份 $(basename "$BAK"))"; fi
}

case "${1:-start}" in
  rebuild)  log "重建前端 dist(npm run build)…"; (cd "$ROOT" && npm run build) || die "build 失败"; do_start ;;
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  *) echo "用法: $0 [rebuild|start|stop|restart|status]"; exit 1 ;;
esac
