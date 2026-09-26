/**
 * Cloudflare 绑定的最小结构化类型。
 *
 * 刻意**不**引入 `@cloudflare/workers-types`：只声明本应用实际用到的子集，
 * 这样同一份代码既能在 Workers 运行，又能在 Node 下通过 tsc 类型检查（无需额外依赖）。
 * 若日后需要更完整的类型，可改为 `import type { D1Database } from '@cloudflare/workers-types'`。
 */

/* ---------- D1（关系型） ---------- */

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

/* ---------- R2（对象存储） ---------- */

export interface R2Object {
  key: string;
  size?: number;
  lastModified?: Date;
  etag?: string;
  httpMetadata?: { contentType?: string };
}

export interface R2ObjectBody extends R2Object {
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
}

export interface R2ListResult {
  objects: R2Object[];
  delimitedPrefixes?: string[];
  truncated?: boolean;
  cursor?: string;
}

export interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; delimiter?: string; limit?: number; cursor?: string }): Promise<R2ListResult>;
}

/* ---------- Durable Objects ---------- */

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(input: string | Request | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Workers 环境绑定（与 wrangler.toml 的 bindings 对应）。 */
export interface CloudflareEnv {
  /** D1：任务与账本。 */
  TASKS_DB: D1Database;
  /** R2：产物对象。未绑定时 worker 退回内存对象存储（控制面路由不依赖 R2）。 */
  OBJECTS?: R2Bucket;
  /** DO：限流（原子计数）。 */
  RATE_LIMITER: DurableObjectNamespace;
  /** DO：账户租约（串行抢占）。 */
  ACCOUNT_LEASES: DurableObjectNamespace;
  /** R2 公开访问前缀（可选）。 */
  R2_PUBLIC_URL?: string;
}
