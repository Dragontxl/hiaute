/**
 * 多账户池（依 V2 §7.5）
 *
 * 职责边界（重要）：
 *  - 本类只负责「账户配置 + 每日配额 + 并发上限 + 密钥解密」；
 *  - 「谁被占用 / 冷却 / 连续失败隔离」等强一致状态一律委托 AccountLeaseStore：
 *      memory     驱动 → 进程内（本地/常驻形态）
 *      cloudflare 驱动 → Durable Object 串行抢占（Workers 多实例形态）
 *  这样两套驱动共用同一条代码路径，不再各写一份加权随机与隔离逻辑。
 *
 * 取用语义（§7.5）：
 *  1. 过滤 isActive && 未超 dailyLimit && 未超 maxConcurrent；
 *  2. 把候选交给租约后端「原子地挑一个未租用者」，失败即本轮无可用户（调用方退避）；
 *  3. 授予后消耗限流配额（rate 后端原子计数），超限则退还租约并返回 null；
 *  4. 调用成功后 release() 解租约；失败走 markFailure()（连续失败达阈值由后端隔离）。
 */
import { decryptSecret } from './crypto.js';
import { log } from './logger.js';
import { rateRulesFor } from '../storage/rules.js';
import type { AccountLeaseStore, RateLimitBackend } from '../storage/types.js';
import type { AccountLease, AccountState, ApiType } from '../types/index.js';

interface AccountRuntime extends AccountState {
  /** 当日已用次数（用于 dailyLimit 判定；进程重启即重置，见 §10 风险）。 */
  usedToday: number;
  /** 并发占用计数。 */
  inflight: number;
}

export interface AccountPoolDeps {
  /** 租约与隔离状态的唯一权威（memory / cloudflare）。 */
  leases: AccountLeaseStore;
  /** 限流后端（可选；未提供则不做 RPM 判定）。 */
  rate?: RateLimitBackend;
}

export class AccountPool {
  private accounts = new Map<string, AccountRuntime>();
  private readonly masterKey: string;
  private readonly deps: AccountPoolDeps;

  constructor(accounts: AccountState[], masterKey: string, deps: AccountPoolDeps) {
    this.masterKey = masterKey;
    this.deps = deps;
    for (const a of accounts) {
      this.accounts.set(a.id, { ...a, usedToday: 0, inflight: 0 });
    }
  }

  /** 按 apiType 列出账户（调试用，脱敏）。 */
  listByType(apiType: ApiType): Array<Pick<AccountRuntime, 'id' | 'alias' | 'isActive' | 'isHealthy' | 'totalUsage' | 'usedToday'>> {
    return [...this.accounts.values()]
      .filter((a) => a.apiType === apiType)
      .map(({ id, alias, isActive, isHealthy, totalUsage, usedToday }) => ({ id, alias, isActive, isHealthy, totalUsage, usedToday }));
  }

  /**
   * 是否还有配额可用。仅判定「启用 + 每日额度」这类池内状态；
   * 「是否被占用/冷却/隔离」由后端在 acquire 时原子判定，此处不重复查询。
   */
  hasAvailable(apiType: ApiType): boolean {
    return [...this.accounts.values()].some(
      (a) => a.apiType === apiType && a.isActive && a.usedToday < a.dailyLimit,
    );
  }

  /**
   * 取得一个账户租约。找不到可用账户或限流超限时返回 null
   * （调用方据此进入“排队退避”，§7.5）。
   */
  async acquire(apiType: ApiType): Promise<AccountLease | null> {
    const now = Date.now();
    const candidates = [...this.accounts.values()].filter(
      (a) =>
        a.apiType === apiType &&
        a.isActive &&
        a.inflight < a.maxConcurrent &&
        a.usedToday < a.dailyLimit &&
        a.apiKeyEncrypted,
    );
    if (candidates.length === 0) return null;

    // 租约 TTL 取候选中最长的冷却时间（保守：所有候选到点前都不会被再次选中）
    const ttlMs = Math.max(...candidates.map((c) => c.cooldownSeconds)) * 1000;
    const grant = await this.deps.leases.acquire(
      apiType,
      candidates.map((c) => ({ id: c.id, alias: c.alias, weight: Math.max(1, c.priorityWeight) })),
      ttlMs,
      now,
    );
    if (!grant) return null;

    const picked = this.accounts.get(grant.accountId);
    if (!picked) {
      await this.deps.leases.release(apiType, grant.accountId, now);
      return null;
    }

    // 授予后才消耗限流配额：避免为「没挑中」的请求白扣额度
    if (this.deps.rate) {
      for (const [key, rule] of rateRulesFor(apiType)) {
        const r = await this.deps.rate.consume(key, rule, now);
        if (!r.allowed) {
          await this.deps.leases.release(apiType, grant.accountId, now);
          log.debug('rate limited; lease returned', { apiType, key, retryAfterMs: r.retryAfterMs });
          return null;
        }
      }
    }

    picked.inflight += 1;
    picked.usedToday += 1;
    picked.totalUsage += 1;
    picked.cooldownUntil = grant.leasedUntil;

    const apiKey = decryptSecret(picked.apiKeyEncrypted, this.masterKey);
    log.info('account acquired', { alias: picked.alias, apiType, leasedUntil: grant.leasedUntil });

    const accountId = grant.accountId;
    const release = async (): Promise<void> => {
      picked.inflight = Math.max(0, picked.inflight - 1);
      picked.cooldownUntil = null;
      await this.deps.leases.release(apiType, accountId, Date.now());
      log.debug('account released', { alias: picked.alias });
    };

    return { account: picked, apiKey, release };
  }

  /**
   * 标记调用失败：释放并发计数并交给租约后端累计失败
   * （连续失败达阈值由后端置 healthy=false，acquire 时自动跳过）。
   */
  async markFailure(accountId: string, reason: string): Promise<void> {
    const a = this.accounts.get(accountId);
    if (!a) return;
    a.inflight = Math.max(0, a.inflight - 1);
    a.cooldownUntil = null;
    a.healthCheckMsg = reason;
    a.lastHealthCheck = Date.now();
    await this.deps.leases.markFailure(a.apiType, accountId, reason);
    log.warn('account failure', { alias: a.alias, reason });
  }

  /** 成功一次：清零后端失败计数，恢复健康。 */
  async markSuccess(accountId: string): Promise<void> {
    const a = this.accounts.get(accountId);
    if (!a) return;
    await this.deps.leases.markSuccess(a.apiType, accountId);
  }

  /**
   * 从租约后端同步健康快照到池内镜像字段（供 listByType 等观测接口读取）。
   * 权威状态始终在后端，此处只是刷新视图。
   */
  async refreshHealth(): Promise<void> {
    const snapshot = await this.deps.leases.snapshot();
    const byId = new Map(snapshot.map((s) => [s.accountId, s] as const));
    for (const a of this.accounts.values()) {
      const s = byId.get(a.id);
      if (!s) continue;
      a.isHealthy = s.healthy;
      a.healthCheckMsg = s.healthy ? 'ok' : `isolated after ${s.consecutiveFailures} consecutive failures`;
      a.lastHealthCheck = Date.now();
    }
  }

  /** 健康探测：逐个打真实探针，并把结果同步到租约后端。 */
  async healthCheckAll(probe: (account: AccountState) => Promise<boolean>): Promise<void> {
    for (const a of this.accounts.values()) {
      if (!a.isActive) continue;
      try {
        const ok = await probe(a);
        a.isHealthy = ok;
        a.healthCheckMsg = ok ? 'ok' : 'probe failed';
        a.lastHealthCheck = Date.now();
        await (ok ? this.deps.leases.markSuccess(a.apiType, a.id) : this.deps.leases.markFailure(a.apiType, a.id, 'probe failed'));
      } catch (err) {
        a.isHealthy = false;
        a.healthCheckMsg = String(err);
        a.lastHealthCheck = Date.now();
        await this.deps.leases.markFailure(a.apiType, a.id, String(err));
      }
    }
  }
}
