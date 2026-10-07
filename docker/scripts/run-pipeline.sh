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
export TASK_BRIEF="${TASK_BRIEF:-}"                # 任务需求文本（无参考视频时按此自由生成）
export RENDER_MODE="${RENDER_MODE:-}"              # llm|code（code = ffmpeg 确定性渲染）
export NORMALIZE_SIZE="${NORMALIZE_SIZE:-512}"            # §8.4 抽帧归一化降档
export MAX_DURATION_SECONDS="${MAX_DURATION_SECONDS:-1800}" # §8.4 限时长（主杠杆）
export MAX_SHOTS="${MAX_SHOTS:-10}"                       # 分镜条数上限（成本控制）
export OUTPUT_RESOLUTION="${OUTPUT_RESOLUTION:-720p}"
export HYPITAPP_DATA_DIR="${HYPITAPP_DATA_DIR:-data}"
DURATION_SECONDS="${DURATION_SECONDS:-}"                  # 参考视频实际时长（由上游探测）

# R2 产物目录名 = 任务名称（用户在列表里看到的那个）；去掉路径分隔符，空则退回 TASK_ID
export TASK_NAME="${TASK_NAME:-$TASK_ID}"
TASK_DIR_NAME="${TASK_NAME//\//_}"
TASK_DIR_NAME="${TASK_DIR_NAME//\\/_}"
TASK_DIR_NAME="${TASK_DIR_NAME:-$TASK_ID}"

# 控制面基址（从回调地址推导）：产物上传到 R2 时复用 /api/v1/files/upload
CONTROL_BASE="${CALLBACK_URL%%/api/v1/*}"

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

# --- 产物上传到 R2（复用控制面 /api/v1/files/upload，worker 侧写入 R2）---
# 说明：GHA 内流水线用的是本地盘对象存储，产物默认只进 Actions artifact；
# 这里显式 POST 到控制面上传接口，使其出现在文件管理页面（R2）。
upload_artifact() {
  local src="$1" prefix="$2"
  [[ -f "$src" ]] || return 0
  if [[ -z "${HYPITAPP_CALLBACK_SECRET:-}" || -z "$CONTROL_BASE" ]]; then
    echo "skip upload (no HYPITAPP_CALLBACK_SECRET or CALLBACK_URL): $src"
    return 0
  fi
  local name sig code
  name="$(basename "$src")"
  # 签名口径与控制面 core/crypto.ts signPayload 一致：sha256(secret + "." + canonical)
  # canonical = artifact:<taskId>:<prefix>:<filename>（filename 用 fileName 字段原名，分片时不变）
  sig=$(HYPITAPP_TASK="$TASK_ID" HYPITAPP_PREFIX="$prefix" HYPITAPP_FILENAME="$name" python3 -c "import hashlib,os; s=os.environ.get('HYPITAPP_CALLBACK_SECRET',''); c='artifact:'+os.environ['HYPITAPP_TASK']+':'+os.environ['HYPITAPP_PREFIX']+':'+os.environ['HYPITAPP_FILENAME']; print(hashlib.sha256((s+'.'+c).encode()).hexdigest())")

  # 大于 50MB 走分片上传（控制面 callback/artifact 支持 chunk 合并）；
  # 否则单请求直传。分片每片 50MB，低于 Cloudflare Worker 单请求体上限(100MB)。
  local size chunk_bytes total
  size=$(stat -c%s "$src" 2>/dev/null || echo 0)
  chunk_bytes=$((50 * 1024 * 1024))
  total=$(( (size + chunk_bytes - 1) / chunk_bytes ))
  [[ "$total" -lt 1 ]] && total=1

  if [[ "$size" -gt "$chunk_bytes" ]]; then
    local tmp idx code i
    tmp=$(mktemp -d)
    # split -b 按字节精确切分（50MB/片），二进制 mp4 安全
    split -b "$chunk_bytes" -d -a 4 "$src" "$tmp/part."
    local parts
    parts=("$tmp"/part.*)
    total=${#parts[@]}
    idx=0
    code=000
    for part in "${parts[@]}"; do
      code=$(curl -sS --max-time 300 -o /dev/null -w '%{http_code}' \
        -X POST "$CONTROL_BASE/api/v1/callback/artifact" \
        -H "x-callback-signature: $sig" \
        -F "taskId=$TASK_ID" \
        -F "prefix=$prefix" \
        -F "fileName=$name" \
        -F "chunk=$idx" \
        -F "totalChunks=$total" \
        -F "file=@$part" || echo "000")
      if [[ "$code" != "201" ]]; then
        echo "chunk upload failed (http $code): $src part $idx/$total"
        rm -rf "$tmp"
        return 0
      fi
      idx=$((idx + 1))
    done
    rm -rf "$tmp"
    if [[ "$code" == "201" ]]; then
      echo "uploaded (chunked ${total}x) -> ${prefix}${name}"
    else
      echo "upload failed (http $code): $src"
    fi
    return 0
  fi

  code=$(curl -sS --max-time 300 -o /dev/null -w '%{http_code}' \
    -X POST "$CONTROL_BASE/api/v1/callback/artifact" \
    -H "x-callback-signature: $sig" \
    -F "taskId=$TASK_ID" \
    -F "prefix=$prefix" \
    -F "fileName=$name" \
    -F "file=@$src" || echo "000")
  if [[ "$code" == "201" ]]; then
    echo "uploaded -> ${prefix}${name}"
  else
    echo "upload failed (http $code): $src"
  fi
}

upload_artifacts() {
  local tdir="$HYPITAPP_DATA_DIR/tasks/$TASK_ID"
  local prefix="tasks/${TASK_DIR_NAME}/"
  upload_artifact "$tdir/outputs/final.mp4" "$prefix"
  upload_artifact "$tdir/script.svml" "$prefix"
  upload_artifact "$tdir/reference.mp4" "$prefix"
  local f
  for f in "$tdir"/frames/*.jpg; do
    [[ -e "$f" ]] || continue
    upload_artifact "$f" "${prefix}frames/"
  done
  for f in "$tdir"/shots/*.mp4; do
    [[ -e "$f" ]] || continue
    upload_artifact "$f" "${prefix}shots/"
  done
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
  # 退出码 75 = 可重试失败（上游资源不可用，如 Gemini 503 / Agnes 队列满 / 无可用账号）：
  # 标 PAUSED，控制面重试端点可稍后重新派发，而不是判 FAILED。
  if [[ "$RC" -eq 75 ]]; then
    echo "retryable failure; marking task PAUSED (可稍后重试)" >&2
    send_callback_status "PAUSED" || true
  else
    send_callback_status "FAILED" || true
  fi
  exit "$RC"
fi

# --- 上传产物到 R2（失败不影响任务终态）---
echo "== 上传产物到 R2 =="
upload_artifacts || true

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
