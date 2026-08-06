#!/usr/bin/env bash
# ============================================================================
# bigdata-portal Docker 一键脚本(构建 / 启动 / 停止 / 销毁)
#
# 用法:scripts/dockerctl.sh <command>
#
#   build    仅构建镜像(不启动)
#   up       构建并启动(首次;已存在则直接启动)
#   start    启动已构建的容器
#   stop     停止容器
#   restart  重启容器
#   down     停止并删除容器(保留镜像与构建缓存)
#   destroy  销毁:停止 + 删除容器 + 删除镜像
#   logs     跟随容器日志
#   ps       查看容器状态
#
# 前置:已安装 Docker(含 docker compose v2,或旧版 docker-compose)。
# 凭证与各系统地址从项目根 .env.local 注入(见 docker-compose.yml)。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env.local"
IMAGE="bigdata-portal:latest"

# 兼容 docker compose(v2)与 docker-compose(v1)
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "[dockerctl] 错误:未找到 docker compose / docker-compose,请先安装 Docker" >&2
  exit 1
fi

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

check_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "[dockerctl] 警告:$ENV_FILE 不存在,子系统地址/免登录凭证将使用默认值" >&2
  fi
}

build()    { "${DC[@]}" -f "$COMPOSE_FILE" build; }
up()       { check_env; "${DC[@]}" -f "$COMPOSE_FILE" up -d --build; }
start()    { check_env; "${DC[@]}" -f "$COMPOSE_FILE" start; }
stop()     { "${DC[@]}" -f "$COMPOSE_FILE" stop; }
restart()  { check_env; "${DC[@]}" -f "$COMPOSE_FILE" restart; }
down()     { "${DC[@]}" -f "$COMPOSE_FILE" down; }
logs()     { "${DC[@]}" -f "$COMPOSE_FILE" logs -f; }
ps()       { "${DC[@]}" -f "$COMPOSE_FILE" ps; }

destroy() {
  "${DC[@]}" -f "$COMPOSE_FILE" down -v
  echo "[dockerctl] 删除镜像 $IMAGE ..."
  docker rmi "$IMAGE" || echo "[dockerctl] (镜像不存在或已被引用,跳过)"
  echo "[dockerctl] 已销毁"
}

cmd="${1:-}"
case "$cmd" in
  build|up|start|stop|restart|down|destroy|logs|ps) "$cmd" ;;
  -h|--help|help) usage ;;
  "") echo "[dockerctl] 缺少子命令" >&2; usage 1 ;;
  *) echo "[dockerctl] 未知命令:$cmd" >&2; usage 1 ;;
esac
