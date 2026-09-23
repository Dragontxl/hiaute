/**
 * 排队退避执行器（依 V2 §7.5「排队退避」精确定义）
 *
 * 语义（不可混淆为“从头按顺序再走一遍”）：
 *  - 取用账户 → 执行 → 成功则 release 并返回；
 *  - 失败(429/5xx/鉴权/超时) → markFailure(置冷却) → 立刻换“下一个可用账户”；
 *  - 当 drain 一遍仍无可用户 → 挂起进入退避：间隔指数增长 5s→15s→45s→…（含 jitter），
 *    到点后“重新执行整套选择流程”（冷却到期的账户会自动回到候选），而非固定顺序重走；
 *  - 超过最大等待/次数仍不可用 → 抛 RetryExhaustedError（任务转 PAUSED/RETRY_LATER，不判失败）。
 */
import { log } from './logger.js';
import type { AccountPool } from './accountPool.js';
import type { ApiType } from '../types/index.js';

export class RetryExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryExhaustedError';
  }
}

/** 可重试的错误判定：限流/服务端/网络/鉴权失败均触发切换。 */
export function isRetryableError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('invalid api key')) {
    return true; // 鉴权失败 → 换账户
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) return true;
  if (msg.includes('5') && (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504'))) return true;
  if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('fetch failed')) return true;
  return false;
}

export interface BackoffOptions {
  /** 初始退避毫秒（默认 5000）。 */
  baseMs?: number;
  /** 退避上限毫秒（默认 5 分钟）。 */
  capMs?: number;
  /** 最大退避轮次（默认 8）。 */
  maxRounds?: number;
  /** jitter 比例（默认 0.3）。 */
  jitter?: number;
}

const DEFAULTS: Required<BackoffOptions> = {
  baseMs: 5_000,
  capMs: 300_000,
  maxRounds: 8,
  jitter: 0.3,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在账户池上执行一次“带故障转移 + 退避”的调用。
 *
 * @param pool        账户池
 * @param apiType     能力类型
 * @param fn          实际调用；收到 { account, apiKey }
 * @param onPaused    进入挂起态的回调（任务可据此转 PAUSED/RETRY_LATER）
 */
export async function withAccountFailover<T>(
  pool: AccountPool,
  apiType: ApiType,
  fn: (ctx: { accountId: string; alias: string; apiKey: string; baseUrl: string; modelName?: string }) => Promise<T>,
  opts: BackoffOptions = {},
  onPaused?: (info: { round: number; waitMs: number }) => void,
): Promise<T> {
  const cfg = { ...DEFAULTS, ...opts };
  let round = 0;
  let lastError: unknown;

  while (round <= cfg.maxRounds) {
    // 本轮：尽力尝试所有当前可用账户（相当于“换下一个可用者”）
    let attemptedAny = false;
    for (;;) {
      const lease = await pool.acquire(apiType);
      if (!lease) break; // 本轮无可用户 → 进入退避
      attemptedAny = true;
      const { account, apiKey, release } = lease;
      try {
        const result = await fn({
          accountId: account.id,
          alias: account.alias,
          apiKey,
          baseUrl: account.baseUrl,
          ...(account.modelName ? { modelName: account.modelName } : {}),
        });
        await pool.markSuccess(account.id);
        await release();
        return result;
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err)) {
          await release();
          throw err; // 非可重试错误直接抛出
        }
        await pool.markFailure(account.id, String(err));
        // markFailure 已释放并发计数（租约由后端置冷却）；此处无需再 release
        log.warn('switching to next account', { apiType, failedAlias: account.alias, err: String(err) });
      }
    }

    if (!attemptedAny && !pool.hasAvailable(apiType) && round === 0) {
      // 一开始就全不可用，也走退避
      log.warn('no available account; entering backoff queue', { apiType });
    }

    if (round === cfg.maxRounds) break;
    // 指数退避 + jitter
    const raw = Math.min(cfg.capMs, cfg.baseMs * 3 ** round);
    const jittered = Math.round(raw * (1 - cfg.jitter + Math.random() * cfg.jitter * 2));
    round += 1;
    onPaused?.({ round, waitMs: jittered });
    log.warn('backoff before re-selecting accounts', { apiType, round, waitMs: jittered });
    await sleep(jittered);
    // 到点后重新“过滤可用账户→加权挑选→占租约”（由循环顶部自动执行）
  }

  throw new RetryExhaustedError(
    `no available ${apiType} account after ${cfg.maxRounds} backoff rounds; last error: ${String(lastError)}`,
  );
}
