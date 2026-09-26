/**
 * 存储层入口（依 V2 建议：统一 HostStore，按 driver 切换）。
 *
 * 用法：
 *   import { createStorage } from './storage/index.js';
 *   const storage = createStorage(cfg.storageDriver, cfg.cloudflare);
 *
 * 驱动：
 *   - 'memory'     ：本地 / 常驻形态（InMemory，含 Hypit Studio 常驻进程）
 *   - 'cloudflare' ：Workers 形态（Durable Objects + D1 + R2，**不用 KV**）
 *
 * 强一致需求（限流计数、账户租约）在 cloudflare 驱动下落到 Durable Objects；
 * 结构化任务数据落 D1；产物落 R2。接口契约见 ./types.ts。
 */
import type { ApiType } from '../types/index.js';
import type { StorageBundle, StorageDriver } from './types.js';
import { createMemoryStorage } from './memory.js';
import { createCloudflareStorage } from './cloudflare/index.js';
import type { CloudflareEnv } from './cloudflare/bindings.js';

export * from './types.js';
export { createMemoryStorage } from './memory.js';
export { createCloudflareStorage } from './cloudflare/index.js';
export type { CloudflareEnv } from './cloudflare/bindings.js';

export interface CreateStorageOptions {
  /** cloudflare 驱动下账户租约 DO 覆盖的能力类型列表。 */
  apiTypes?: ApiType[];
  /** memory 驱动的产物落盘目录；缺省用内存占位对象存储。 */
  objectsDir?: string;
}

/** 统一入口：按 driver 装配整套存储能力。所有运行时都应经此函数取存储，避免各处重复 new。 */
export function createStorage(driver: StorageDriver, cf: CloudflareEnv | undefined, opts: CreateStorageOptions = {}): StorageBundle {
  if (driver === 'cloudflare') {
    if (!cf) throw new Error('storage driver=cloudflare requires CloudflareEnv bindings (TASKS_DB/OBJECTS/RATE_LIMITER/ACCOUNT_LEASES)');
    return createCloudflareStorage(cf, opts.apiTypes ?? []);
  }
  return createMemoryStorage(opts.objectsDir ? { objectsDir: opts.objectsDir } : {});
}
