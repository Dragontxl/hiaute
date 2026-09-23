/**
 * Durable Objects 实现（推荐方案的强一致核心）。
 *
 * 两个 DO 类，直接承载「限流计数」与「账户租约」：
 *  - RateLimiterDO   ：每 key 一个实例，滑动窗口计数**原子**递增。
 *  - AccountLeaseDO  ：每 apiType 一个实例，候选账户的租约抢占**串行**执行，
 *                      从根上杜绝两个请求同时选中同一账户。
 *
 * 关键：同一 DO 实例的请求天然串行，因此这些「读-改-写」不会竞争，
 *       无需 KV，也无需自己写乐观锁。
 *
 * 说明：刻意不 `extends DurableObject`（避免引入 worker 运行时类型），
 * 采用经典的 `fetch(request)` 处理协议，既可在 Workers 注册，也可单测。
 */
import type { DurableObjectStorageLike } from './bindings.js';

/* ============================ 协议类型 ============================ */

interface RateConsumeReq {
  op: 'consume';
  key: string;
  windowMs: number;
  max: number;
  now: number;
}
interface RateConsumeRes {
  allowed: boolean;
  retryAfterMs: number;
}

interface LeaseState {
  leasedUntil: number | null;
  consecutiveFailures: number;
  healthy: boolean;
}
type LeaseStates = Record<string, LeaseState>;

interface LeaseAcquireReq {
  op: 'acquire';
  candidates: Array<{ id: string; alias: string; weight: number }>;
  ttlMs: number;
  now: number;
}
interface LeaseAcquireRes {
  grant: { accountId: string; alias: string; leasedUntil: number } | null;
}
interface LeaseMutateReq {
  op: 'release' | 'failure' | 'success' | 'snapshot';
  accountId?: string;
  reason?: string;
  now: number;
}
interface LeaseSnapshotRes {
  snapshot: Array<{ accountId: string; leasedUntil: number | null; consecutiveFailures: number; healthy: boolean }>;
}

const MAX_CONSECUTIVE_FAILURES = 3;

/* ============================ 限流 DO ============================ */

interface RateBucket {
  windowStart: number;
  count: number;
}

export class RateLimiterDO {
  private buckets: Record<string, RateBucket> = {};
  private loaded = false;

  constructor(private state: { storage: DurableObjectStorageLike }) {}

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as RateConsumeReq;
    if (body.op !== 'consume') {
      return Response.json({ error: 'unsupported op' }, { status: 400 });
    }
    if (!this.loaded) await this.load();

    const { key, windowMs, max, now } = body;
    const existing = this.buckets[key];
    const res: RateConsumeRes =
      !existing || now - existing.windowStart >= windowMs
        ? { allowed: true, retryAfterMs: windowMs }
        : { allowed: existing.count + 1 <= max, retryAfterMs: Math.max(0, windowMs - (now - existing.windowStart)) };

    this.buckets[key] =
      !existing || now - existing.windowStart >= windowMs
        ? { windowStart: now, count: 1 }
        : { windowStart: existing.windowStart, count: existing.count + 1 };

    await this.persist();
    return Response.json(res);
  }

  private async load(): Promise<void> {
    const stored = await this.state.storage.get<Record<string, RateBucket>>('buckets');
    if (stored) this.buckets = stored;
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const clean: Record<string, RateBucket> = {};
    for (const [k, v] of Object.entries(this.buckets)) clean[k] = v;
    await this.state.storage.put('buckets', clean);
  }
}

/* ============================ 账户租约 DO ============================ */

export class AccountLeaseDO {
  private states: LeaseStates = {};
  private loaded = false;

  constructor(private state: { storage: DurableObjectStorageLike }) {}

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as LeaseAcquireReq | LeaseMutateReq;
    if (!this.loaded) await this.load();

    switch (body.op) {
      case 'acquire':
        return Response.json(await this.acquire(body));
      case 'release':
        return Response.json(await this.release(body));
      case 'failure':
        return Response.json(await this.failure(body));
      case 'success':
        return Response.json(await this.success(body));
      case 'snapshot':
        return Response.json(await this.snapshot());
      default:
        return Response.json({ error: 'unsupported op' }, { status: 400 });
    }
  }

  private ensure(accountId: string): LeaseState {
    let s = this.states[accountId];
    if (!s) {
      s = { leasedUntil: null, consecutiveFailures: 0, healthy: true };
      this.states[accountId] = s;
    }
    return s;
  }

  private async acquire(req: LeaseAcquireReq): Promise<LeaseAcquireRes> {
    const free = req.candidates.filter((c) => {
      const s = this.states[c.id];
      return !s || ((s.leasedUntil === null || s.leasedUntil <= req.now) && s.healthy);
    });
    if (free.length === 0) {
      await this.persist();
      return { grant: null };
    }

    const total = free.reduce((sum, c) => sum + Math.max(1, c.weight), 0);
    let r = Math.random() * total;
    let picked = free[free.length - 1] as (typeof free)[number];
    for (const c of free) {
      r -= Math.max(1, c.weight);
      if (r <= 0) {
        picked = c;
        break;
      }
    }

    const s = this.ensure(picked.id);
    s.leasedUntil = req.now + req.ttlMs;
    await this.persist();
    return { grant: { accountId: picked.id, alias: picked.alias, leasedUntil: s.leasedUntil } };
  }

  private async release(req: LeaseMutateReq): Promise<{ ok: boolean }> {
    if (req.accountId) this.ensure(req.accountId).leasedUntil = null;
    await this.persist();
    return { ok: true };
  }

  private async failure(req: LeaseMutateReq): Promise<{ ok: boolean; healthy: boolean }> {
    const s = req.accountId ? this.ensure(req.accountId) : { leasedUntil: null, consecutiveFailures: 0, healthy: true };
    s.leasedUntil = null;
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) s.healthy = false;
    await this.persist();
    return { ok: true, healthy: s.healthy };
  }

  private async success(req: LeaseMutateReq): Promise<{ ok: boolean }> {
    if (req.accountId) {
      const s = this.ensure(req.accountId);
      s.consecutiveFailures = 0;
      s.healthy = true;
    }
    await this.persist();
    return { ok: true };
  }

  private async snapshot(): Promise<LeaseSnapshotRes> {
    return {
      snapshot: Object.entries(this.states).map(([accountId, s]) => ({
        accountId,
        leasedUntil: s.leasedUntil,
        consecutiveFailures: s.consecutiveFailures,
        healthy: s.healthy,
      })),
    };
  }

  private async load(): Promise<void> {
    const stored = await this.state.storage.get<LeaseStates>('states');
    if (stored) this.states = stored;
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const clean: LeaseStates = {};
    for (const [k, v] of Object.entries(this.states)) clean[k] = v;
    await this.state.storage.put('states', clean);
  }
}

/** DO 绑定的 op 协议（与 worker 入口共用）。 */
export type { RateConsumeReq, LeaseAcquireReq, LeaseMutateReq };
