#!/bin/bash
# flink-gateway.sh —— Flink SQL Gateway 启停脚本(db-proxy 机器)
#
# 用独立的 JDK11 启动(系统 JAVA_HOME 是 Java8,不改系统环境变量)。
# 关键:sql-gateway.sh 不认 FLINK_CONF_DIR 环境变量,仍读 $FLINK_HOME/conf;
# 而那份配置是 StreamX 共用的(rest.address: 0.0.0.0,embedded 模式下
# 内嵌 JobManager 连 0.0.0.0:8081 必然 refused)。
# → 用 -D 启动参数显式覆盖关键配置,不修改任何 flink-conf.yaml。
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
  # -D 覆盖关键配置,不修改 StreamX 共用的 flink-conf.yaml:
  #  rest.port 用 8082(8081 被占用);session 执行模式 local 在 db-proxy 创建会话时指定
  bin/sql-gateway.sh start \
    -Drest.address=localhost \
    -Drest.bind-address=0.0.0.0 \
    -Drest.port=8082 \
    -Djobmanager.rpc.address=localhost \
    -Djobmanager.rpc.port=6124 \
    -Dhigh-availability=none \
    -Dstate.backend=filesystem \
    -Dstate.checkpoints.dir=file:///tmp/flink-checkpoints \
    -Dstate.savepoints.dir=file:///tmp/flink-savepoints \
    -Dtaskmanager.numberOfTaskSlots=2
  # 等待就绪(最多 60s,内嵌 JobManager 冷启动较慢)
  for i in $(seq 1 60); do
    if curl -s "http://127.0.0.1:${GATEWAY_PORT}/v1/info" >/dev/null 2>&1; then
      echo "SQL Gateway 已就绪: $(curl -s http://127.0.0.1:${GATEWAY_PORT}/v1/info)"
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
