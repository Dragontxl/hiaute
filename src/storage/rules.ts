/**
 * 限流规则（唯一来源）。
 *
 * 规则对齐各服务真实免费额度：Gemini 15 RPM；Agnes 约 20–30 RPM。
 * 规则只是「配置」，判定由 RateLimitBackend 完成（memory：进程内；cloudflare：DO 原子计数），
 * 因此这里不持有任何计数状态。
 */
import type { ApiType } from '../types/index.js';
import type { RateLimitRule } from './types.js';

/** 全局窗口：跨所有能力类型的总闸门。 */
export const GLOBAL_RATE_RULE: RateLimitRule = { windowMs: 60_000, max: 60 };

/** 各 api_type 的每分钟上限。 */
export const API_RATE_RULES: Record<ApiType, RateLimitRule> = {
  gemini: { windowMs: 60_000, max: 15 }, // 15 RPM
  'agnes-text': { windowMs: 60_000, max: 30 },
  'agnes-image': { windowMs: 60_000, max: 30 },
  // 视频按「每账户」限流：真实额度 RPM=1（不是整池 30，否则 5 账户共享 30 会严重超发）。
  'agnes-video': { windowMs: 60_000, max: 1, perAccount: true },
  edgetts: { windowMs: 60_000, max: 30 },
};

/**
 * 某能力类型需要消耗的全部限流键（先全局后能力，任一超限即拒绝）。
 * 返回顺序即判定顺序：全局先被消耗，能力键在全局通过后才消耗。
 *
 * @param accountId 传入后，`perAccount` 规则使用账户级键，实现「每账户 RPM」隔离。
 */
export function rateRulesFor(apiType: ApiType, accountId?: string): Array<[string, RateLimitRule]> {
  const rule = API_RATE_RULES[apiType] ?? GLOBAL_RATE_RULE;
  const key = rule.perAccount
    ? accountId
      ? `acct:${accountId}:${apiType}`
      : `api:${apiType}`
    : `api:${apiType}`;
  return [
    ['global', GLOBAL_RATE_RULE],
    [key, rule],
  ];
}
