/**
 * 限流后端（Cloudflare Durable Objects）。
 *
 * 每个限流 key 映射到一个 DO 实例：`RATE_LIMITER.idFromName(key)`。
 * 同一实例的请求串行执行，因此滑动窗口计数是**原子**的——
 * 这是 KV 做不到的（KV 最终一致，读到的可能是旧值，导致超发）。
 */
import type { DurableObjectNamespace } from './bindings.js';
import type { RateLimitBackend, RateLimitResult, RateLimitRule } from '../types.js';

export class DurableRateLimitBackend implements RateLimitBackend {
  constructor(private ns: DurableObjectNamespace) {}

  async consume(key: string, rule: RateLimitRule, now = Date.now()): Promise<RateLimitResult> {
    const stub = this.ns.get(this.ns.idFromName(key));
    const res = await stub.fetch('https://rate-limiter/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'consume', key, windowMs: rule.windowMs, max: rule.max, now }),
    });
    return (await res.json()) as RateLimitResult;
  }
}
