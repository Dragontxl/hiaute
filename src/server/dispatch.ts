/**
 * GitHub Actions 分发（依 V2 §7.1 / §7.3）
 *
 * 通过 repository_dispatch 触发 workflow，带上任务 payload。
 * 安全要点：
 *  - 使用 Fine-grained PAT（最小权限）或 GitHub App token，勿用高权限经典 PAT（§7.3）。
 *  - 敏感值（API Key）不应放进 client_payload（不会被自动打码）；任务只传 taskId，
 *    账户密钥由 Actions 侧从 Secrets 自行装载。
 */
import { log } from '../core/logger.js';

export interface DispatchConfig {
  pat: string;
  owner: string;
  repo: string;
  eventType: string;
  callbackUrl: string;
}

export interface DispatchPayload {
  taskId: string;
  /** 任务名称（用作 R2 产物目录名，如 tasks/<taskName>/）。 */
  taskName?: string;
  referenceUrl: string;
  maxDurationSeconds: number;
}

export async function dispatchTask(cfg: DispatchConfig, payload: DispatchPayload): Promise<void> {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/dispatches`;
  // 注意：/dispatches 成功返回 204 + 空 body，不能用会 JSON.parse 的 postJson（空串会抛错）
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.pat}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // GitHub API 强制要求 User-Agent，否则 403
      'user-agent': 'hypitapp-control-plane',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      event_type: cfg.eventType,
      // 注意：不要在此放 api key；仅放非敏感的任务描述
      client_payload: {
        taskId: payload.taskId,
        taskName: payload.taskName ?? '',
        referenceUrl: payload.referenceUrl,
        maxDurationSeconds: payload.maxDurationSeconds,
        callbackUrl: cfg.callbackUrl,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  log.info('repository_dispatch sent', { owner: cfg.owner, repo: cfg.repo, eventType: cfg.eventType });
}
