/**
 * Provider 注册表（依 V2 §2 / §3）
 *
 * 统一构造各 Provider，并把它们与 hypit.runtime.json 的 endpoints 概念对齐。
 * 应用层只通过此注册表取 Provider，永不直接 new 具体实现。
 */
import { AccountPool } from '../core/accountPool.js';
import { MemoryAccountLeaseStore, MemoryRateLimitBackend } from '../storage/memory.js';
import type { StorageBundle } from '../storage/types.js';
import { AgnesTextProvider, AgnesImageProvider, AgnesVideoProvider } from './agnes/index.js';
import { GeminiProvider } from './gemini/index.js';
import { EdgeTtsProvider } from './edgetts/index.js';
import type { AccountState } from '../types/index.js';

export interface ProviderRegistry {
  pool: AccountPool;
  agnesText: AgnesTextProvider;
  agnesImage: AgnesImageProvider;
  agnesVideo: AgnesVideoProvider;
  gemini: GeminiProvider;
  edgetts: EdgeTtsProvider;
}

export function createProviders(accounts: AccountState[], masterKey: string, storage?: StorageBundle): ProviderRegistry {
  // 租约与限流一律走存储驱动：未提供 StorageBundle 时退回进程内实现（等价语义）。
  const pool = new AccountPool(accounts, masterKey, {
    leases: storage?.leases ?? new MemoryAccountLeaseStore(),
    ...(storage && { rate: storage.rate }),
  });
  return {
    pool,
    agnesText: new AgnesTextProvider(pool),
    agnesImage: new AgnesImageProvider(pool),
    agnesVideo: new AgnesVideoProvider(pool),
    gemini: new GeminiProvider(pool),
    edgetts: new EdgeTtsProvider(),
  };
}
