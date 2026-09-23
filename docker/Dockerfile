# 依 V2 §7.1 / §8：Actions 执行镜像
# ubuntu22.04 + ffmpeg + python + (WhisperX/YOLO 按需) + Node(控制/内核)
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# 基础工具链（对齐 §8.2：ffmpeg/jq 等）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq ffmpeg git \
      python3 python3-pip python3-venv \
      nodejs npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- 应用依赖层（先用 package.json 以利用 Docker 层缓存，§7.3 第 3 点）---
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# --- 模型缓存目录（由 GHA actions/cache 挂载复用，避免每次重下 4–6GB）---
ENV HYPITAPP_MODEL_CACHE=/opt/models \
    HYPITAPP_DATA_DIR=/app/data \
    NORMALIZE_SIZE=512 \
    MAX_DURATION_SECONDS=180 \
    OUTPUT_RESOLUTION=720p
RUN mkdir -p "$HYPITAPP_MODEL_CACHE" /app/data /app/work

# --- 应用源码 ---
COPY src ./src
COPY tsconfig.json ./
COPY docker/scripts ./docker/scripts
RUN chmod +x docker/scripts/*.sh

# 说明：WhisperX / YOLO 的真实模型下载建议放在 workflow 的 cache 步骤（§8.3），
# 而非镜像层，以免镜像过大（§8.2 磁盘峰值控制）。

ENTRYPOINT ["bash", "docker/scripts/run-pipeline.sh"]
