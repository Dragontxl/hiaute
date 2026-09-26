/**
 * 统一存储抽象（依 V2 建议：内存 Map → 可切换驱动）
 *
 * 目标：把「任务记录 / 限流 / 账户租约 / 产物对象」这四类状态从具体实现中解耦，
 * 通过 `storage.driver` 在两种驱动间切换：
 *   - 'memory'     ：本地 / 常驻形态（含 Hypit Studio）——进程内实现
 *   - 'cloudflare' ：Cloudflare Workers 形态——Durable Objects + D1 + R2（不用 KV）
 *
 * 强一致需求（限流计数、账户租约）落在 Durable Objects：
 * 同一对象的请求串行执行，天然避免并发抢同一账户 / 超发计数。
 * 结构化查询（任务列表、状态机）落在 D1。
 * 产物二进制落在 R2。
 *
 * 注意：Workers 无状态、多实例，进程内 Map 不可用，因此生产必须用 cloudflare 驱动；
 * 而常驻机（本地/VPS）用 memory 驱动即可，无需上 Cloudflare 组件。
 */
import type { ApiType, Stage, TaskCheckpoint, TaskRecord, TaskStatus } from '../types/index.js';

/** 存储驱动类型。 */
export type StorageDriver = 'memory' | 'cloudflare';

/** 对象元数据。 */
export interface ObjectMeta {
  key: string;
  size: number;
  /** ISO 8601 时间字符串。 */
  lastModified: string;
  contentType?: string;
  etag?: string;
}

/** 对象本体（含元数据 + 内容读取）。 */
export interface ObjectBody extends ObjectMeta {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/** 列举选项。 */
export interface ListOptions {
  prefix?: string;
  /** 分隔符（如 '/'）用于虚拟目录聚合。 */
  delimiter?: string;
  limit?: number;
  cursor?: string;
}

/** 列举结果。 */
export interface ListResult {
  objects: ObjectMeta[];
  /** 以分隔符截断的前缀（即子目录）。 */
  delimitedPrefixes: string[];
  truncated: boolean;
  cursor?: string;
}

/** 产物对象存储（内存 / FS / R2 三套实现）。 */
export interface ObjectStore {
  put(key: string, body: ArrayBuffer | Uint8Array | string, contentType?: string): Promise<string>;
  /** 返回可访问 URL（R2 用 R2_PUBLIC_URL 前缀）。 */
  getUrl(key: string): string;
  /** 删除指定 key 或前缀下的对象。 */
  delete(prefixOrKey: string): Promise<void>;
  /** 读取对象本体与元数据；不存在返回 null。 */
  get(key: string): Promise<ObjectBody | null>;
  /** 列举对象（支持前缀 + 分隔符虚拟目录）。 */
  list(options?: ListOptions): Promise<ListResult>;
  /** 创建目录标记（R2 为空对象 / FS 为实际目录）。 */
  createDirectory(prefix: string): Promise<void>;
}

/** 任务创建入参。 */
export interface TaskCreateInput {
  name?: string;
  brief?: string;
  referenceUrl?: string;
  maxDurationSeconds: number;
  normalizeSize: number;
  outputResolution: '480p' | '720p' | '1080p';
  runFile?: string;
}

/** 任务仓储（D1 / 内存两套实现）。 */
export interface TaskRepository {
  create(input: TaskCreateInput): Promise<TaskRecord>;
  get(id: string): Promise<TaskRecord | undefined>;
  list(): Promise<TaskRecord[]>;
  update(
    id: string,
    patch: Partial<Pick<TaskRecord, 'name' | 'brief' | 'status' | 'stage' | 'error' | 'checkpoint' | 'runFile' | 'completedAt'>>,
  ): Promise<TaskRecord | undefined>;
  advanceStage(id: string, stage: Stage): Promise<TaskRecord | undefined>;
  markStatus(id: string, status: TaskStatus, error?: string): Promise<TaskRecord | undefined>;
  mergeCheckpoint(id: string, cp: TaskCheckpoint): Promise<TaskRecord | undefined>;
}

/** 限流规则（窗口长度 + 窗口内上限）。 */
export interface RateLimitRule {
  windowMs: number;
  max: number;
}

/** 限流结果。 */
export interface RateLimitResult {
  allowed: boolean;
  /** 距离窗口可用的毫秒数（用于退避）。 */
  retryAfterMs: number;
}

/**
 * 限流后端（强一致）。
 * memory：进程内滑动窗口；cloudflare：Durable Object 原子计数。
 */
export interface RateLimitBackend {
  consume(key: string, rule: RateLimitRule, now?: number): Promise<RateLimitResult>;
}

/** 账户租约候选（由控制面依据配置给出，权重即 priority_weight）。 */
export interface LeaseCandidate {
  id: string;
  alias: string;
  weight: number;
}

/** 账户租约授予结果。 */
export interface LeaseGrant {
  accountId: string;
  alias: string;
  apiType: ApiType;
  /** 租约到期时间（ms）。 */
  leasedUntil: number;
}

/**
 * 账户租约存储（强一致）。
 * memory：进程内 + 加权随机；cloudflare：Durable Object 串行抢占，杜绝并发撞同一账户。
 *
 * 说明：候选列表由调用方传入（控制面持有账户配置），存储只负责「原子地从候选里挑一个未租用的」。
 */
export interface AccountLeaseStore {
  acquire(apiType: ApiType, candidates: LeaseCandidate[], ttlMs: number, now?: number): Promise<LeaseGrant | null>;
  /** apiType 显式传入：DO 按 apiType 分片。 */
  release(apiType: ApiType, accountId: string, now?: number): Promise<void>;
  markFailure(apiType: ApiType, accountId: string, reason: string, now?: number): Promise<void>;
  /** 连续失败达阈值后账户被隔离，返回是否仍健康。 */
  markSuccess(apiType: ApiType, accountId: string, now?: number): Promise<void>;
  /** 健康快照（调试用）。 */
  snapshot(): Promise<Array<{ accountId: string; leasedUntil: number | null; consecutiveFailures: number; healthy: boolean }>>;
}

/** 存储聚合（一个应用实例持有一份）。 */
export interface StorageBundle {
  driver: StorageDriver;
  tasks: TaskRepository;
  rate: RateLimitBackend;
  leases: AccountLeaseStore;
  objects: ObjectStore;
}
