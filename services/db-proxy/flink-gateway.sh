#!/bin/bash
# flink-gateway.sh —— Flink SQL Gateway 启停脚本(db-proxy 机器)
#
# 用独立的 JDK11 启动(系统 JAVA_HOME 是 Java8,不改系统环境变量,
# 只对 SQL Gateway 这一次启动生效)。SQL Gateway 是 Flink 1.17 自带 REST 服务,
# db-proxy 通过 HTTP 转发到它执行 FlinkSQL。
#
# 用法: ./flink-gateway.sh {start|stop|status|restart}
# 日志: /opt/streamx/flink/flink-1.17.2/log/*sql-gateway*.log

FLINK_HOME=/opt/streamx/flink/flink-1.17.2
JDK11_HOME=/root/whm/jdk/jdk-11.0.32+9
GATEWAY_PORT=8083

start() {
  if curl -s "http://127.0.0.1:${GATEWAY_PORT}/v1/info" >/dev/null 2>&1; then
    echo "SQL Gateway 已在运行(port ${GATEWAY_PORT})"
    return 0
  fi
  cd "$FLINK_HOME" || { echo "FLINK_HOME 不存在: $FLINK_HOME"; exit 1; }
  export JAVA_HOME="$JDK11_HOME"
  bin/sql-gateway.sh start
  # 等待就绪(最多 30s)
  for i in $(seq 1 30); do
    if curl -s "http://127.0.0.1:${GATEWAY_PORT}/v1/info" >/dev/null 2>&1; then
      echo "SQL Gateway 启动成功: $(curl -s http://127.0.0.1:${GATEWAY_PORT}/v1/info)"
      return 0
    fi
    sleep 1
  done
  echo "SQL Gateway 启动超时,请查看日志: $FLINK_HOME/log/*sql-gateway*.log"
  return 1
}

stop() {
  cd "$FLINK_HOME" 2>/dev/null || exit 1
  export JAVA_HOME="$JDK11_HOME"
  bin/sql-gateway.sh stop
  echo "SQL Gateway 已停止"
}

status() {
  if curl -s "http://127.0.0.1:${GATEWAY_PORT}/v1/info" >/dev/null 2>&1; then
    echo "运行中: $(curl -s http://127.0.0.1:${GATEWAY_PORT}/v1/info)"
  else
    echo "未运行"
    exit 1
  fi
}

case "$1" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 2; start ;;
  status)  status ;;
  *) echo "用法: $0 {start|stop|status|restart}"; exit 1 ;;
esac
