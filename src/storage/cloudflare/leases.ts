/**
 * 账户租约后端（Cloudflare Durable Objects）。
 *
 * 每个 apiType 映射到一个 DO 实例：`ACCOUNT_LEASES.idFromName(apiType)`。
 * 「从候选中原子地挑一个未租用账户」在实例内串行执行，
 * 因此绝不会出现两个并发请求同时选中同一账户——无需自己写乐观锁，也不用 KV。
 *
 * 注意：接口方法均显式携带 apiType，因为 DO 是按 apiType 分片的。
 */
import type { DurableObjectNamespace } from './bindings.js';
import type { ApiType } from '../../types/index.js';
import type { AccountLeaseStore, LeaseCandidate, LeaseGrant } from '../types.js';

interface LeaseGrantPayload {
  grant: { accountId: string; alias: string; leasedUntil: number } | null;
}
interface LeaseSnapshotPayload {
  snapshot: Array<{ accountId: string; leasedUntil: number | null; consecutiveFailures: number; healthy: boolean }>;
}

export class DurableAccountLeaseStore implements AccountLeaseStore {
  constructor(
    private ns: DurableObjectNamespace,
    private apiTypes: ApiType[] = [],
  ) {}

  private post(apiType: ApiType, payload: Record<string, unknown>): Promise<unknown> {
    const stub = this.ns.get(this.ns.idFromName(apiType));
    return stub
      .fetch('https://account-leases/op', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      .then((r) => r.json());
  }

  async acquire(
    apiType: ApiType,
    candidates: LeaseCandidate[],
    ttlMs: number,
    now = Date.now(),
  ): Promise<LeaseGrant | null> {
    const data = (await this.post(apiType, {
      op: 'acquire',
      candidates: candidates.map((c) => ({ id: c.id, alias: c.alias, weight: c.weight })),
      ttlMs,
      now,
    })) as LeaseGrantPayload;
    if (!data.grant) return null;
    return { accountId: data.grant.accountId, alias: data.grant.alias, apiType, leasedUntil: data.grant.leasedUntil };
  }

  async release(apiType: ApiType, accountId: string, now = Date.now()): Promise<void> {
    await this.post(apiType, { op: 'release', accountId, now });
  }

  async markFailure(apiType: ApiType, accountId: string, reason: string, now = Date.now()): Promise<void> {
    await this.post(apiType, { op: 'failure', accountId, reason, now });
  }

  async markSuccess(apiType: ApiType, accountId: string, now = Date.now()): Promise<void> {
    await this.post(apiType, { op: 'success', accountId, now });
  }

  async snapshot(): Promise<Array<{ accountId: string; leasedUntil: number | null; consecutiveFailures: number; healthy: boolean }>> {
    const out: Array<{ accountId: string; leasedUntil: number | null; consecutiveFailures: number; healthy: boolean }> = [];
    for (const apiType of this.apiTypes) {
      const data = (await this.post(apiType, { op: 'snapshot', now: Date.now() })) as LeaseSnapshotPayload;
      out.push(...(data.snapshot ?? []));
    }
    return out;
  }
}
