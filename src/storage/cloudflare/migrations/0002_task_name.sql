-- 迁移 0002：为 tasks 表增加「任务名称」与「结束时间」列
--
-- 背景：tasks 表最初没有 name / completed_at。`CREATE TABLE IF NOT EXISTS` 不会修改已存在的表，
-- 因此对存量库需单独执行本迁移（仅执行一次；重复执行会报 duplicate column，可忽略）。
--
-- 已对生产库 hypitapp 执行：
--   wrangler d1 execute hypitapp --remote --file=src/storage/cloudflare/migrations/0002_task_name.sql
-- 存量行的回填（幂等）：
--   UPDATE tasks SET name = strftime('%Y%m%d-%H%M', created_at/1000, 'unixepoch') WHERE name IS NULL;
--   UPDATE tasks SET completed_at = updated_at WHERE completed_at IS NULL AND status IN ('COMPLETED','FAILED');
--
-- 全新建库无需本文件：schema.sql 已包含这两列。

ALTER TABLE tasks ADD COLUMN name TEXT;
ALTER TABLE tasks ADD COLUMN completed_at INTEGER;