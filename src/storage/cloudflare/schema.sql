-- D1 schema（推荐方案中的关系型账本）
-- 应用方式：wrangler d1 execute hypitapp --file=src/storage/cloudflare/schema.sql
-- 时间戳统一毫秒（INTEGER）。

CREATE TABLE IF NOT EXISTS tasks (
  id                   TEXT PRIMARY KEY,
  name                 TEXT,                        -- 任务名称（用户指定，缺省由创建时间命名）
  status               TEXT NOT NULL,               -- PENDING|DISPATCHED|RUNNING|PAUSED|COMPLETED|FAILED
  stage                TEXT NOT NULL,               -- DETECT|ANALYZE|CROP_SHOTS|CONVERT_FRAMES|GENERATE_SHOTS|COMPOSE
  reference_url        TEXT,
  max_duration_seconds INTEGER NOT NULL,
  normalize_size       INTEGER NOT NULL,
  output_resolution    TEXT NOT NULL,               -- 480p|720p|1080p
  render_mode          TEXT,                        -- llm|code（code = ffmpeg 确定性渲染，不耗模型）
  brief                TEXT,                        -- 任务需求文本（无参考视频时按此自由生成）
  run_file             TEXT,                        -- Studio 编辑用 Run Source
  error                TEXT,
  checkpoint           TEXT,                        -- JSON: TaskCheckpoint
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  completed_at         INTEGER                      -- 终态（COMPLETED/FAILED）时间戳
);

CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks (status);

-- 说明：限流计数与账户租约放在 Durable Objects，不落 D1/KV。
-- 若日后需要审计快照，可在此加一张只写表（由 DO 定期镜像），但权威状态仍在 DO。
CREATE TABLE IF NOT EXISTS task_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  event      TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events (task_id, created_at);
