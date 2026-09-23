#!/usr/bin/env bash
# 依 V2 §7.1 / §8.4 / §8.5：Actions 内执行 6 阶段流水线
# 关键：阶段边界磁盘快照 + 后台监控 + 中间产物即传对象存储 + 归一化降档
#
# 注意：这里**不**用 set -e——流水线失败也必须把 FAILED 回调发回控制面（§7.3），
# 因此显式捕获退出码后再决定退出。
set -uo pipefail

cd "$(dirname "$0")/../.." # 到项目根

# --- 任务参数（应用侧读 TASK_* 前缀；REFERENCE_URL 为旧别名，向后兼容）---
export TASK_ID="${TASK_ID:-gha-$(date +%s)}"
export TASK_REFERENCE_URL="${TASK_REFERENCE_URL:-${REFERENCE_URL:-}}"
export NORMALIZE_SIZE="${NORMALIZE_SIZE:-512}"            # §8.4 抽帧归一化降档
export MAX_DURATION_SECONDS="${MAX_DURATION_SECONDS:-180}" # §8.4 限时长（主杠杆）
export MAX_SHOTS="${MAX_SHOTS:-10}"                       # 分镜条数上限（成本控制）
export OUTPUT_RESOLUTION="${OUTPUT_RESOLUTION:-720p}"
export HYPITAPP_DATA_DIR="${HYPITAPP_DATA_DIR:-data}"
DURATION_SECONDS="${DURATION_SECONDS:-}"                  # 参考视频实际时长（由上游探测）

# --- 磁盘监控启动（§8.5 ②）---
source docker/scripts/monitor-disk.sh
start_monitor "$TASK_ID"
trap 'stop_monitor' EXIT

echo "== 阶段边界快照：开始（§8.5 ①）=="
df -h / || true
du -sm "$HYPITAPP_DATA_DIR" 2>/dev/null || true

# --- 带签名回调（§7.3）：成功/失败都发 ---
send_callback_status() {
  local status="$1"
  if [[ -z "${CALLBACK_URL:-}" ]]; then
    echo "no CALLBACK_URL; skip callback"
    return 0
  fi
  export PIPELINE_STATUS="$status"
  python3 - <<'PY'
import json, os, hashlib, urllib.request
url = os.environ["CALLBACK_URL"]
secret = os.environ.get("HYPITAPP_CALLBACK_SECRET", "")
status = os.environ.get("PIPELINE_STATUS", "COMPLETED")
body = json.dumps({"taskId": os.environ["TASK_ID"], "status": status}).encode()
# 与控制面 core/crypto.ts 的 signPayload 对齐：sha256(`${secret}.${body}`)
sig = hashlib.sha256(secret.encode() + b"." + body).hexdigest()
req = urllib.request.Request(url, data=body, method="POST",
    headers={"content-type": "application/json", "x-callback-signature": sig,
             # Cloudflare Bot 防护会按签名拦截 Python-urllib 默认 UA（error 1010），必须用普通 UA
             "user-agent": "hypitapp-pipeline/1.0"})
try:
    resp = urllib.request.urlopen(req, timeout=30)
    print("callback sent:", status, "http", resp.status)
except Exception as e:
    print("callback failed:", e)
PY
}

# --- 防卫：时长门槛（§8.4 主杠杆）---
if [[ -n "$DURATION_SECONDS" && "$DURATION_SECONDS" -gt "$MAX_DURATION_SECONDS" ]]; then
  echo "ERROR: reference duration ${DURATION_SECONDS}s exceeds MAX_DURATION_SECONDS=${MAX_DURATION_SECONDS}s" >&2
  echo "请缩短视频或调整分片策略（§8.4）。" >&2
  send_callback_status "FAILED" || true
  exit 2
fi

# --- 运行应用流水线（本地形态，等价于 6 阶段）---
set +e
npx tsx src/index.ts task
RC=$?
set -e

if [[ "$RC" -ne 0 ]]; then
  echo "ERROR: pipeline exited with code $RC" >&2
  send_callback_status "FAILED" || true
  exit "$RC"
fi

echo "== 阶段边界快照：结束（§8.5 ①）=="
df -h / || true

# 汇总到 Step Summary（§8.5 ③）
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### 磁盘监控（尾部 30 行）"
    echo '```'
    tail -n 30 "${DISK_LOG:-/tmp/disk_monitor.csv}" 2>/dev/null || true
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

send_callback_status "COMPLETED" || true

echo "pipeline done: task=$TASK_ID"
