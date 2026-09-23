/**
 * Cloudflare 存储驱动聚合（推荐方案：Durable Objects + D1 + R2，**不用 KV**）。
 *
 *  - tasks   → D1（关系型）：任务记录、状态机、审计
 *  - rate    → Durable Objects：限流原子计数
 *  - leases  → Durable Objects：账户租约串行抢占
 *  - objects → R2：产物二进制
 */
import type { ApiType } from '../../types/index.js';
import type { StorageBundle } from '../types.js';
import type { CloudflareEnv } from './bindings.js';
import { D1TaskRepository } from './tasks.js';
import { R2ObjectStore } from './objects.js';
import { DurableRateLimitBackend } from './rate.js';
import { DurableAccountLeaseStore } from './leases.js';

export function createCloudflareStorage(env: CloudflareEnv, apiTypes: ApiType[] = []): StorageBundle {
  return {
    driver: 'cloudflare',
    tasks: new D1TaskRepository(env.TASKS_DB),
    rate: new DurableRateLimitBackend(env.RATE_LIMITER),
    leases: new DurableAccountLeaseStore(env.ACCOUNT_LEASES, apiTypes),
    objects: new R2ObjectStore(env.OBJECTS, env.R2_PUBLIC_URL),
  };
}

export { RateLimiterDO, AccountLeaseDO } from './durableObject.js';
export type { CloudflareEnv } from './bindings.js';
