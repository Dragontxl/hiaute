/**
 * 内存存储驱动（本地 / 常驻形态）。
 *
 * 与 cloudflare 驱动实现同一 StorageBundle 契约，便于在本地开发与调试，
 * 也适用于常驻机（VPS/本机）——那种形态无需 Durable Objects / D1 / R2。
 *
 * 语义与 cloudflare 驱动保持一致（限流滑动窗口、账户加权租约、连续失败隔离），
 * 差别仅在一致性由「进程单例」保证，而非 DO 的串行执行。
 */
import { randomUUID } from 'node:crypto';
import { log } from '../core/logger.js';
import { FsObjectStore } from './fs.js';
import { emptyCheckpoint, mergeCheckpoints } from './merge.js';
import type { ApiType, Stage, TaskCheckpoint, TaskRecord, TaskStatus } from '../types/index.js';
import type {
  AccountLeaseStore,
  LeaseCandidate,
  LeaseGrant,
  ObjectStore,
  RateLimitBackend,
  RateLimitResult,
  RateLimitRule,
  StorageBundle,
  TaskCreateInput,
  TaskRepository,
} from './types.js';

const MAX_CONSECUTIVE_FAILURES = 3;

/** 内存任务仓储。 */
export class MemoryTaskRepository implements TaskRepository {
  private tasks = new Map<string, TaskRecord>();

  async create(input: TaskCreateInput): Promise<TaskRecord> {
    const now = Date.now();
    const task: TaskRecord = {
      id: randomUUID(),
      status: 'PENDING',
      stage: 'DETECT',
      ...(input.referenceUrl ? { referenceUrl: input.referenceUrl } : {}),
      ...(input.runFile ? { runFile: input.runFile } : {}),
      maxDurationSeconds: input.maxDurationSeconds,
      normalizeSize: input.normalizeSize,
      outputResolution: input.outputResolution,
      createdAt: now,
      updatedAt: now,
      checkpoint: { remoteTasks: {}, completedStages: [], completedShots: [] },
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    return this.tasks.get(id);
  }

  async list(): Promise<TaskRecord[]> {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async update(
    id: string,
    patch: Partial<Pick<TaskRecord, 'status' | 'stage' | 'error' | 'checkpoint' | 'runFile'>>,
  ): Promise<TaskRecord | undefined> {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    Object.assign(t, patch, { updatedAt: Date.now() });
    return t;
  }

  async advanceStage(id: string, stage: Stage): Promise<TaskRecord | undefined> {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    t.stage = stage;
    // 回调可能重放同一阶段：mergeCheckpoints 去重，避免 completedStages 重复累加
    t.checkpoint = mergeCheckpoints(t.checkpoint, { completedStages: [stage] });
    t.updatedAt = Date.now();
    return t;
  }

  async markStatus(id: string, status: TaskStatus, error?: string): Promise<TaskRecord | undefined> {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    // 终态不可被后续回调覆盖（与 D1 版 `WHERE status NOT IN (...)` 语义一致），保证回调重放幂等
    if (t.status === 'COMPLETED' || t.status === 'FAILED') return t;
    t.status = status;
    if (error) t.error = error;
    t.updatedAt = Date.now();
    return t;
  }

  async mergeCheckpoint(id: string, cp: TaskCheckpoint): Promise<TaskRecord | undefined> {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    t.checkpoint = mergeCheckpoints(t.checkpoint, cp);
    t.updatedAt = Date.now();
    return t;
  }
}

/** 内存限流（滑动窗口）。 */
export class MemoryRateLimitBackend implements RateLimitBackend {
  private buckets = new Map<string, { windowStart: number; count: number }>();

  async consume(key: string, rule: RateLimitRule, now = Date.now()): Promise<RateLimitResult> {
    const b = this.buckets.get(key);
    if (!b || now - b.windowStart >= rule.windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return { allowed: true, retryAfterMs: rule.windowMs };
    }
    b.count += 1;
    const allowed = b.count <= rule.max;
    const retryAfterMs = Math.max(0, rule.windowMs - (now - b.windowStart));
    return { allowed, retryAfterMs };
  }
}

interface LeaseState {
  leasedUntil: number | null;
  consecutiveFailures: number;
  healthy: boolean;
}

/** 内存账户租约（加权随机 + 连续失败隔离）。 */
export class MemoryAccountLeaseStore implements AccountLeaseStore {
  private state = new Map<string, LeaseState>();

  private ensure(accountId: string): LeaseState {
    let s = this.state.get(accountId);
    if (!s) {
      s = { leasedUntil: null, consecutiveFailures: 0, healthy: true };
      this.state.set(accountId, s);
    }
    return s;
  }

  async acquire(
    apiType: ApiType,
    candidates: LeaseCandidate[],
    ttlMs: number,
    now = Date.now(),
  ): Promise<LeaseGrant | null> {
    const free = candidates.filter((c) => {
      const s = this.state.get(c.id);
      return !s || ((s.leasedUntil === null || s.leasedUntil <= now) && s.healthy);
    });
    if (free.length === 0) return null;

    const picked = weightedPick(free, (c) => Math.max(1, c.weight));
    const s = this.ensure(picked.id);
    s.leasedUntil = now + ttlMs;
    log.info('lease acquired (memory)', { alias: picked.alias, apiType, leasedUntil: s.leasedUntil });
    return { accountId: picked.id, alias: picked.alias, apiType, leasedUntil: s.leasedUntil };
  }

  async release(_apiType: ApiType, accountId: string, _now = Date.now()): Promise<void> {
    const s = this.ensure(accountId);
    s.leasedUntil = null;
  }

  async markFailure(_apiType: ApiType, accountId: string, reason: string, _now = Date.now()): Promise<void> {
    const s = this.ensure(accountId);
    s.leasedUntil = null;
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) s.healthy = false;
    log.warn('lease failure (memory)', { accountId, reason, consecutiveFailures: s.consecutiveFailures, healthy: s.healthy });
  }

  async markSuccess(_apiType: ApiType, accountId: string, _now = Date.now()): Promise<void> {
    const s = this.ensure(accountId);
    s.consecutiveFailures = 0;
    s.healthy = true;
  }

  async snapshot(): Promise<Array<{ accountId: string; leasedUntil: number | null; consecutiveFailures: number; healthy: boolean }>> {
    return [...this.state.entries()].map(([accountId, s]) => ({
      accountId,
      leasedUntil: s.leasedUntil,
      consecutiveFailures: s.consecutiveFailures,
      healthy: s.healthy,
    }));
  }
}

/** 内存对象存储（调试用，返回 memory:// URL）。 */
export class MemoryObjectStore implements ObjectStore {
  private blobs = new Map<string, { body: ArrayBuffer | Uint8Array | string; contentType?: string }>();

  async put(key: string, body: ArrayBuffer | Uint8Array | string, contentType?: string): Promise<string> {
    this.blobs.set(key, { body, ...(contentType ? { contentType } : {}) });
    return this.getUrl(key);
  }

  getUrl(key: string): string {
    return `memory://${key}`;
  }

  async delete(prefixOrKey: string): Promise<void> {
    for (const k of [...this.blobs.keys()]) {
      if (k === prefixOrKey || k.startsWith(prefixOrKey)) this.blobs.delete(k);
    }
  }
}

/**
 * 组装内存驱动（任务/限流/租约在进程内）。
 * 产物存储：传入 objectsDir 则落盘到文件系统（可被其他进程/前端访问），否则用内存占位实现。
 */
export function createMemoryStorage(opts: { objectsDir?: string } = {}): StorageBundle {
  return {
    driver: 'memory',
    tasks: new MemoryTaskRepository(),
    rate: new MemoryRateLimitBackend(),
    leases: new MemoryAccountLeaseStore(),
    objects: opts.objectsDir ? new FsObjectStore(opts.objectsDir) : new MemoryObjectStore(),
  };
}

/** 通用加权随机。 */
export function weightedPick<T>(items: T[], weightOf: (item: T) => number): T {
  const total = items.reduce((sum, it) => sum + weightOf(it), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= weightOf(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1] as T;
}
