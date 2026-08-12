#!/bin/bash
# ============================================================================
# db-proxy 资源占用评估脚本
# 用法(在客户机 hadoop-task-3 上执行):
#   bash resource-assess.sh
# 流程:基线采样 -> 你手动发一条 spark 查询 -> 采样 -> 手动发一条 flink 查询 -> 采样
# 说明:脚本本身只做监控,不触发任何集群任务;查询由你手动执行。
# ============================================================================

TOKEN="${X_DB_TOKEN:-608d0b0f17c8254b4cee4b090ab11590}"
DB_PROXY_URL="http://127.0.0.1:8756"
OUT="${1:-/tmp/resource-assess.txt}"

# ---------- 工具函数 ----------
# 递归收集某 pid 的所有后代
collect_descendants() {
  local root=$1
  local all
  all=$(ps -eo pid=,ppid= | awk '{print $1, $2}')
  local result="$root"
  local changed=1
  while [ $changed -eq 1 ]; do
    changed=0
    for p in $result; do
      # 找出父进程在 result 里、自己不在 result 里的 pid
      local children
      children=$(echo "$all" | awk -v r="$result" '
        BEGIN { n=split(r, arr, " "); for (i in arr) inr[arr[i]]=1 }
        { if (!($1 in inr) && ($2 in inr)) print $1 }
      ')
      if [ -n "$children" ]; then
        result="$result $children"
        changed=1
      fi
    done
  done
  echo "$result" | tr ' ' '\n' | sort -n | uniq
}

# 采集一次快照,参数: 采样点名
snapshot() {
  local name="$1"
  local ts
  ts=$(date '+%H:%M:%S')

  {
    echo ""
    echo "============================================================"
    echo "[$ts] 采样点: $name"
    echo "============================================================"

    # --- 系统层 ---
    echo "--- 系统内存 (free -m) ---"
    free -m | head -3
    echo ""
    echo "--- CPU 负载 (1/5/15min) ---"
    uptime
    echo ""

    # --- db-proxy 进程树 ---
    local upid
    upid=$(pgrep -f "uvicorn main:app" | head -1)
    if [ -z "$upid" ]; then
      echo "!!! 未找到 uvicorn main:app 进程,请先启动 db-proxy"
    else
      echo "--- db-proxy 进程树 (uvicorn pid=$upid) ---"
      local pids
      pids=$(collect_descendants "$upid")
      # 表头
      printf "%-10s %-8s %-8s %-10s %-50s %s\n" "PID" "PPID" "RSS(MB)" "%CPU" "COMMAND" "JVM/PY 摘要"
      for pid in $pids; do
        local line
        line=$(ps -p "$pid" -o pid=,ppid=,rss=,pcpu=,comm=,args= 2>/dev/null)
        [ -z "$line" ] && continue
        local rss_mb
        rss_mb=$(echo "$line" | awk '{printf "%.0f", $3/1024}')
        printf "%-10s %-8s %-8s %-10s %-50s %s\n" \
          "$(echo "$line" | awk '{print $1}')" \
          "$(echo "$line" | awk '{print $2}')" \
          "$rss_mb" \
          "$(echo "$line" | awk '{print $4}')" \
          "$(echo "$line" | awk '{print $5}')" \
          "$(echo "$line" | cut -c1-120)"
      done
      # 进程树内存合计
      local total_rss
      total_rss=$(for pid in $pids; do ps -p "$pid" -o rss= 2>/dev/null; done | awk '{s+=$1} END {printf "%.0f", s/1024}')
      echo ">>> db-proxy 进程树内存合计: ${total_rss} MB"
    fi
    echo ""

    # --- 本机 java 网关进程(java 侧独立看) ---
    echo "--- 本机 java 进程 (gateway/executor) ---"
    ps -eo pid=,rss=,pcpu=,args= | grep -E "java|python" | grep -vE "grep|sshd|bash" \
      | awk '{rss_mb=$2/1024; printf "%-8s %8.0fMB %6s%% %s\n", $1, rss_mb, $3, substr($0, index($0,$4), 120)}' | head -10
    echo ""

    # --- 集群侧 YARN 应用 ---
    echo "--- YARN 应用 (yarn application -list) ---"
    yarn application -list 2>/dev/null | grep -E "db-proxy|flink|spark|Flink|Spark" | head -8
    echo ""
    echo "--- 本服务引擎状态 ---"
    curl -s -m 5 -H "X-DB-Token: $TOKEN" "$DB_PROXY_URL/flink/status" | head -c 400
    echo ""
    curl -s -m 5 -H "X-DB-Token: $TOKEN" "$DB_PROXY_URL/spark/status" | head -c 400
    echo ""
  } | tee -a "$OUT"
}

# ---------- 主流程 ----------
echo "资源占用评估开始,输出将追加到 $OUT"
echo "按回车开始基线采样..."
read -r

snapshot "基线(服务刚启动,无查询)"

echo ""
echo "============================================================"
echo " 下一步:请手动执行一条 SPARK 查询,例如:"
echo "  curl -H \"X-DB-Token: $TOKEN\" -X POST $DB_PROXY_URL/spark/query \\"
echo "    -H 'Content-Type: application/json' -d '{\"kind\":\"sql\",\"sql\":\"select count(*) from <某表>\"}'"
echo " 查询完成后回到这里按回车采样 Spark 运行后状态..."
echo "============================================================"
read -r

snapshot "Spark 查询后"

echo ""
echo "============================================================"
echo " 下一步:请手动执行一条 FLINK 查询,例如:"
echo "  curl -H \"X-DB-Token: $TOKEN\" -X POST $DB_PROXY_URL/flink/query \\"
echo "    -H 'Content-Type: application/json' -d '{\"sql\":\"SHOW CATALOGS\",\"mode\":\"batch\"}'"
echo " 查询完成后回到这里按回车采样 Flink 运行后状态..."
echo "============================================================"
read -r

snapshot "Flink 查询后"

echo ""
echo "============================================================"
echo " 评估完成!完整记录在: $OUT"
echo " 快速对比表:"
echo "============================================================"
grep -E "\[.*\] 采样点|进程树内存合计|系统内存|Mem:" "$OUT"

echo ""
echo "提示:重点看『db-proxy 进程树内存合计』在三个采样点的变化,"
echo "以及 YARN 应用列表里常驻的 session 占用的集群资源。"
