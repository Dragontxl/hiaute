/**
 * HTTP 服务入口（依 V2 §2 第 ① 层）
 *
 * 用 Hono 提供控制面；可跑在 Node（本地 / 常驻）或部署到 Cloudflare Workers。
 * 启动：npx tsx src/index.ts serve（或 node dist/server/index.js）
 *
 * 存储：Node 形态走 memory 驱动（任务/限流/租约在进程内），产物落 dataDir/objects。
 * 要持久化任务需切到 Workers 形态（见 src/worker.ts，Durable Objects + D1 + R2）。
 *
 * 注意：Studio（生成后编辑）需要常驻进程，Cloudflare Workers 无法承载；
 * 该能力仅在 Node 常驻形态可用（见 src/kernel/studio.ts 的约束说明）。
 */
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { buildRoutes } from './routes/index.js';
import { createStorage } from '../storage/index.js';
import { StudioManager } from '../kernel/studio.js';
import { loadConfig } from '../index.js';
import { log } from '../core/logger.js';

export function createApp() {
  const cfg = loadConfig();
  // Node/常驻形态：memory 驱动 + 产物落盘（供前端/远端模型按 URL 访问）
  const storage = createStorage('memory', undefined, { objectsDir: join(cfg.dataDir, 'objects') });
  const studio = new StudioManager({ cli: cfg.hypitCli, cwd: cfg.dataDir });
  const app = buildRoutes(cfg, storage, studio);
  return { app, cfg, storage, studio };
}

export function main(): void {
  const { app, cfg, storage, studio } = createApp();
  const port = Number(process.env.PORT ?? 8787);
  const server = serve({ fetch: app.fetch, port }, (info: { port: number }) => {
    log.info('Hypitapp control plane listening', {
      port: info.port,
      driver: storage.driver,
      auth: cfg.apiToken ? 'bearer-token' : 'DISABLED',
      maxDurationSeconds: cfg.maxDurationSeconds,
      normalizeSize: cfg.normalizeSize,
    });
    if (!cfg.apiToken) {
      log.warn('HYPITAPP_API_TOKEN not set; /api/v1 endpoints are unauthenticated');
    }
  });

  // 优雅关闭：结束所有 Studio 会话后退出。
  const shutdown = (): void => {
    log.info('shutting down; stopping studio sessions');
    void studio.stopAll().finally(() => {
      server.close(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isDirect = process.argv[1] && /server[/\\]index\.(ts|js)$/.test(process.argv[1]);
if (isDirect) main();
