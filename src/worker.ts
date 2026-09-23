/**
 * Cloudflare Workers 入口（推荐方案）。
 *
 * 装配顺序：读取 env 绑定 → 构造 Cloudflare 存储（DO + D1 + R2）→ 交给 Hono 路由。
 *
 * 注意：
 * - Workers 无状态，**不能**用内存 Map；因此强制 storage driver = cloudflare。
 * - Hypit Studio（生成后编辑）需常驻进程，**不在 Workers 提供**；
 *   该能力保留在本地/常驻形态（见 src/kernel/studio.ts 与 docs/DEPLOY.md §5）。
 * - 这里不注册 Studio 路由（传 undefined）。
 */
import { buildRoutes } from './server/routes/index.js';
import { createStorage } from './storage/index.js';
import type { CloudflareEnv } from './storage/cloudflare/bindings.js';
import type { ApiType, AppConfig } from './types/index.js';

/** 平台账户密钥下挂的 apiType（与 hypit.runtime.json 对齐）。 */
const API_TYPES: ApiType[] = ['gemini', 'agnes-text', 'agnes-image', 'agnes-video', 'edgetts'];

export interface WorkerEnv extends CloudflareEnv {
  HYPITAPP_MASTER_KEY: string;
  HYPITAPP_CALLBACK_SECRET: string;
  HYPITAPP_API_TOKEN?: string;
  GITHUB_PAT?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  HYPITAPP_CALLBACK_URL?: string;
  STORAGE_DRIVER?: string;
  MAX_DURATION_SECONDS?: string;
  NORMALIZE_SIZE?: string;
  MAX_SHOTS?: string;
  OUTPUT_RESOLUTION?: string;
}

/** 从 Workers env 构造 AppConfig（与 Node 端 loadConfig 字段对齐）。 */
function cfgFromEnv(env: WorkerEnv): AppConfig {
  const cfg: AppConfig = {
    hypitCli: 'hypit',
    maxDurationSeconds: Number(env.MAX_DURATION_SECONDS ?? 180),
    normalizeSize: Number(env.NORMALIZE_SIZE ?? 512),
    maxShots: Number(env.MAX_SHOTS ?? 10),
    outputResolution: (env.OUTPUT_RESOLUTION as AppConfig['outputResolution']) ?? '720p',
    dataDir: '/tmp',
    masterKey: env.HYPITAPP_MASTER_KEY,
    callbackSecret: env.HYPITAPP_CALLBACK_SECRET,
    storageDriver: 'cloudflare',
  };
  if (env.HYPITAPP_API_TOKEN) cfg.apiToken = env.HYPITAPP_API_TOKEN;
  if (env.GITHUB_PAT) {
    cfg.github = {
      pat: env.GITHUB_PAT,
      owner: env.GITHUB_OWNER ?? '',
      repo: env.GITHUB_REPO ?? '',
      eventType: 'hypit-task',
      callbackUrl: env.HYPITAPP_CALLBACK_URL ?? '',
    };
  }
  return cfg;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const cfg = cfgFromEnv(env);
    const storage = createStorage('cloudflare', env, { apiTypes: API_TYPES });
    // Workers 形态不提供 Studio（需常驻进程）。
    const app = buildRoutes(cfg, storage, undefined);
    return app.fetch(request);
  },
};

// 导出 DO 类，供 wrangler 绑定。
export { RateLimiterDO, AccountLeaseDO } from './storage/cloudflare/durableObject.js';
