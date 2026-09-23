/**
 * D1 任务仓储（任务记录 / 状态机 / 审计）。
 *
 * 采用 D1 而非 KV：任务列表需要按时间/状态查询，且状态流转需要条件更新
 * （`UPDATE ... WHERE status = ?`）避免并发冲突——这正是关系型的强项。
 *
 * 表结构见 ./schema.sql；时间戳统一用毫秒（INTEGER）。
 *
 * node:crypto 的 randomUUID 在 Workers 下需 nodejs_compat（wrangler.toml 已开启）。
 */
import { randomUUID } from 'node:crypto';
import { emptyCheckpoint, mergeCheckpoints } from '../merge.js';
import type { D1Database } from './bindings.js';
import type { Stage, TaskCheckpoint, TaskRecord, TaskStatus } from '../../types/index.js';
import type { TaskCreateInput, TaskRepository } from '../types.js';

interface TaskRow {
  id: string;
  status: string;
  stage: string;
  reference_url: string | null;
  max_duration_seconds: number;
  normalize_size: number;
  output_resolution: string;
  run_file: string | null;
  error: string | null;
  checkpoint: string | null;
  created_at: number;
  updated_at: number;
}

function rowToTask(r: TaskRow): TaskRecord {
  const task: TaskRecord = {
    id: r.id,
    status: r.status as TaskStatus,
    stage: r.stage as Stage,
    maxDurationSeconds: r.max_duration_seconds,
    normalizeSize: r.normalize_size,
    outputResolution: r.output_resolution as TaskRecord['outputResolution'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.reference_url) task.referenceUrl = r.reference_url;
  if (r.run_file) task.runFile = r.run_file;
  if (r.error) task.error = r.error;
  if (r.checkpoint) {
    try {
      task.checkpoint = JSON.parse(r.checkpoint) as TaskCheckpoint;
    } catch {
      /* 保持默认空检查点 */
    }
  }
  return task;
}

export class D1TaskRepository implements TaskRepository {
  constructor(private db: D1Database) {}

  async create(input: TaskCreateInput): Promise<TaskRecord> {
    const now = Date.now();
    const id = randomUUID();
    const checkpoint: TaskCheckpoint = { remoteTasks: {}, completedStages: [], completedShots: [] };
    await this.db
      .prepare(
        `INSERT INTO tasks
          (id, status, stage, reference_url, max_duration_seconds, normalize_size, output_resolution, run_file, checkpoint, created_at, updated_at)
         VALUES (?, 'PENDING', 'DETECT', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.referenceUrl ?? null,
        input.maxDurationSeconds,
        input.normalizeSize,
        input.outputResolution,
        input.runFile ?? null,
        JSON.stringify(checkpoint),
        now,
        now,
      )
      .run();
    return {
      id,
      status: 'PENDING',
      stage: 'DETECT',
      ...(input.referenceUrl ? { referenceUrl: input.referenceUrl } : {}),
      ...(input.runFile ? { runFile: input.runFile } : {}),
      maxDurationSeconds: input.maxDurationSeconds,
      normalizeSize: input.normalizeSize,
      outputResolution: input.outputResolution,
      createdAt: now,
      updatedAt: now,
      checkpoint,
    };
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    const row = await this.db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<TaskRow>();
    return row ? rowToTask(row) : undefined;
  }

  async list(): Promise<TaskRecord[]> {
    const res = await this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200').all<TaskRow>();
    return (res.results ?? []).map(rowToTask);
  }

  async update(
    id: string,
    patch: Partial<Pick<TaskRecord, 'status' | 'stage' | 'error' | 'checkpoint' | 'runFile'>>,
  ): Promise<TaskRecord | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const next: TaskRecord = { ...current, ...patch, updatedAt: Date.now() };
    await this.write(next);
    return next;
  }

  async advanceStage(id: string, stage: Stage): Promise<TaskRecord | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const cp: TaskCheckpoint = current.checkpoint ?? emptyCheckpoint();
    const next: TaskRecord = { ...current, stage, checkpoint: mergeCheckpoints(cp, { completedStages: [stage] }), updatedAt: Date.now() };
    await this.write(next);
    return next;
  }

  async markStatus(id: string, status: TaskStatus, error?: string): Promise<TaskRecord | undefined> {
    const now = Date.now();
    // 纯条件更新（不做读改写）：终态不可被后续回调覆盖，保证回调重放幂等
    const stmts = [
      this.db
        .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('COMPLETED', 'FAILED')")
        .bind(status, now, id),
    ];
    if (error !== undefined) {
      stmts.push(this.db.prepare('UPDATE tasks SET error = ? WHERE id = ?').bind(error, id));
    }
    await this.db.batch(stmts);
    return this.get(id);
  }

  async mergeCheckpoint(id: string, cp: TaskCheckpoint): Promise<TaskRecord | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    // 检查点必须合并而非整体替换：回调重放只追加，不丢弃已有的进度
    const next: TaskRecord = { ...current, checkpoint: mergeCheckpoints(current.checkpoint, cp), updatedAt: Date.now() };
    await this.write(next);
    return next;
  }

  /** 统一写回（UPSERT，保持列名一致）。 */
  private async write(t: TaskRecord): Promise<void> {
    await this.db
      .prepare(
        `UPDATE tasks SET
           status = ?, stage = ?, reference_url = ?, max_duration_seconds = ?, normalize_size = ?,
           output_resolution = ?, run_file = ?, error = ?, checkpoint = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        t.status,
        t.stage,
        t.referenceUrl ?? null,
        t.maxDurationSeconds,
        t.normalizeSize,
        t.outputResolution,
        t.runFile ?? null,
        t.error ?? null,
        JSON.stringify(t.checkpoint ?? null),
        t.updatedAt,
        t.id,
      )
      .run();
  }
}
