#!/usr/bin/env bash
# 依 V2 §8.5 ②：磁盘监控后台守护
# 用法： source monitor-disk.sh; start_monitor "$TASK_ID"; ... ; stop_monitor
set -uo pipefail

DISK_LOG="${DISK_LOG:-/tmp/disk_monitor.csv}"

start_monitor() {
  local task_id="${1:-task}"
  local interval="${MONITOR_INTERVAL:-10}"
  local max_iter="${MONITOR_MAX_ITER:-2220}"   # 兜底：10s × 2220 ≈ 6.17h，防止守护进程失控
  # 监控目录：默认 <dataDir>/tasks/<taskId>，也可用 WATCH_DIR 覆盖
  local watch_dir="${WATCH_DIR:-${HYPITAPP_DATA_DIR:-data}/tasks/${task_id}}"
  mkdir -p "$(dirname "$DISK_LOG")" 2>/dev/null || true
  echo "ts,used_MB,avail_MB,use_pct,workdir_MB,cpu_pct,mem_used_MB,total_MB" > "$DISK_LOG"
  (
    local iter=0
    while true; do
      local ts df wd cpu mem
      ts="$(date -u +%FT%TZ)"
      df="$(df -Pm / 2>/dev/null | awk 'NR==2{print $3","$4","$5}')"
      wd="$(du -sm "$watch_dir" 2>/dev/null | awk '{print $1}')"
      # CPU 采样：优先 top 的整机使用率（%），top 不可用则退回单进程；两路都不行给 0
      cpu="$(top -bn1 2>/dev/null | awk '/%Cpu\(s\)/{gsub(/,/,\".\"); print int($2+$4)}')"
      [ -z "$cpu" ] && cpu="$(ps -p $$ -o %cpu= 2>/dev/null | awk '{print int($1)}')"
      # 内存：整机已用/总量（MB）
      mem="$(free -m 2>/dev/null | awk 'NR==2{print $3","$2}')"
      # tee 到 stdout 进日志；落文件供 artifact
      echo "$ts,${df:-0,0,0},${wd:-0},${cpu:-0},${mem:-0,0}" | tee -a "$DISK_LOG"
      iter=$((iter + 1))
      if (( iter >= max_iter )); then
        echo "monitor reached max iterations (${max_iter}); stop" >&2
        break
      fi
      sleep "$interval"
    done
  ) &
  MON_PID=$!
  export MON_PID
}

stop_monitor() {
  if [[ -n "${MON_PID:-}" ]]; then
    kill "$MON_PID" 2>/dev/null || true
  fi
}

# 直接执行时打印一次快照
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  df -h /
  echo "monitor options: MONITOR_INTERVAL=${MONITOR_INTERVAL:-10} DISK_LOG=${DISK_LOG}"
fi
