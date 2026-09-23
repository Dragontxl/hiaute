/**
 * 应用入口 / 控制面装配（依 V2 §2 第 ① 层 + §7 部署）
 *
 * 子命令：
 *  - `tsx src/index.ts task [--dispatch]`  跑一次任务（默认本地，--dispatch 触发 GitHub Actions）
 *  - `tsx src/index.ts serve`              启动 HTTP 控制面（src/server）
 *
 * 幂等：检查点落 <dataDir>/checkpoints/<taskId>.json；同一 TASK_ID 重跑会从断点续跑。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadAccounts } from './config/accounts.js';
import { log } from './core/logger.js';
import { HypitKernel } from './kernel/index.js';
import { Pipeline } from './pipeline/index.js';
import { Planner } from './planner/index.js';
import { createProviders } from './providers/registry.js';
import { createStorage } from './storage/index.js';
import { emptyCheckpoint, parseCheckpoint } from './storage/merge.js';
import type { AppConfig, TaskCheckpoint } from './types/index.js';

const USAGE = `usage:
  tsx src/index.ts task [--dispatch]   run one task (local by default, or dispatch to GitHub Actions)
  tsx src/index.ts serve               start the HTTP control plane

env: HYPITAPP_MASTER_KEY (required), TASK_ID, TASK_REFERENCE_URL, TASK_BRIEF,
     MAX_DURATION_SECONDS, NORMALIZE_SIZE, MAX_SHOTS, OUTPUT_RESOLUTION, HYPITAPP_DATA_DIR
`;

/** 环境变量转正整数；非法值直接报错，避免 NaN 静默进入流水线。 */
export function intEnv(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got: ${raw}`);
  return n;
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.HYPITAPP_DATA_DIR ?? resolve(process.cwd(), 'data');
  const cfg: AppConfig = {
    hypitCli: process.env.HYPIT_CLI ?? 'hypit',
    maxDurationSeconds: intEnv('MAX_DURATION_SECONDS', 180),
    normalizeSize: intEnv('NORMALIZE_SIZE', 512),
    maxShots: intEnv('MAX_SHOTS', 10),
    outputResolution: (process.env.OUTPUT_RESOLUTION as AppConfig['outputResolution'] | undefined) ?? '720p',
    dataDir,
    masterKey: process.env.HYPITAPP_MASTER_KEY ?? '',
    callbackSecret: process.env.HYPITAPP_CALLBACK_SECRET ?? '',
    storageDriver: (process.env.STORAGE_DRIVER as AppConfig['storageDriver'] | undefined) ?? 'memory',
  };
  if (process.env.HYPITAPP_API_TOKEN) cfg.apiToken = process.env.HYPITAPP_API_TOKEN;
  if (process.env.GITHUB_PAT) {
    cfg.github = {
      pat: process.env.GITHUB_PAT,
      owner: process.env.GITHUB_OWNER ?? '',
      repo: process.env.GITHUB_REPO ?? '',
      eventType: process.env.GITHUB_EVENT_TYPE ?? 'hypit-task',
      callbackUrl: process.env.HYPITAPP_CALLBACK_URL ?? '',
    };
  }
  return cfg;
}

export async function bootstrap() {
  const cfg = loadConfig();
  if (!cfg.masterKey) {
    throw new Error('HYPITAPP_MASTER_KEY is required (用于加密 API Key，见 §7.5)');
  }
  // 本地/常驻形态：memory 驱动 + 产物落盘；租约/限流后端与 Provider 共用同一实例
  const storage = createStorage('memory', undefined, { objectsDir: join(cfg.dataDir, 'objects') });
  const runtimePath = process.env.HYPIT_RUNTIME ?? resolve(process.cwd(), 'hypit.runtime.json');
  const accounts = await loadAccounts(runtimePath, cfg.masterKey, cfg.dataDir);
  const providers = createProviders(accounts, cfg.masterKey, storage);
  const planner = new Planner(providers);
  const kernel = new HypitKernel({ cli: cfg.hypitCli, cwd: process.cwd() });
  const pipeline = new Pipeline();
  log.info('Hypitapp bootstrapped', {
    accounts: accounts.length,
    driver: storage.driver,
    maxDurationSeconds: cfg.maxDurationSeconds,
    normalizeSize: cfg.normalizeSize,
    maxShots: cfg.maxShots,
    outputResolution: cfg.outputResolution,
  });
  return { cfg, storage, providers, planner, kernel, pipeline };
}

/* ---------------- 检查点持久化 ---------------- */

function checkpointPath(cfg: AppConfig, taskId: string): string {
  return join(cfg.dataDir, 'checkpoints', `${taskId}.json`);
}

async function loadCheckpoint(cfg: AppConfig, taskId: string): Promise<TaskCheckpoint> {
  try {
    const raw = await readFile(checkpointPath(cfg, taskId), 'utf8');
    const cp = parseCheckpoint(JSON.parse(raw));
    log.info('checkpoint restored', {
      taskId,
      stages: cp.completedStages.length,
      shots: cp.completedShots.length,
    });
    return cp;
  } catch {
    return emptyCheckpoint();
  }
}

async function saveCheckpoint(cfg: AppConfig, taskId: string, cp: TaskCheckpoint): Promise<void> {
  const p = checkpointPath(cfg, taskId);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(cp, null, 2), 'utf8');
}

/* ---------------- 命令 ---------------- */

async function runTask(flags: string[]): Promise<void> {
  const dispatch = flags.includes('--dispatch');
  const { cfg, storage, providers, planner, kernel, pipeline } = await bootstrap();
  const taskId = process.env.TASK_ID ?? `local-${Date.now()}`;
  const referenceUrl = process.env.TASK_REFERENCE_URL ?? '';

  if (dispatch) {
    if (!cfg.github) throw new Error('GITHUB_PAT / GITHUB_OWNER / GITHUB_REPO required for --dispatch');
    const { dispatchTask } = await import('./server/dispatch.js');
    await dispatchTask(cfg.github, { taskId, referenceUrl, maxDurationSeconds: cfg.maxDurationSeconds });
    log.info('task dispatched to GitHub Actions', { taskId });
    return;
  }

  const checkpoint = await loadCheckpoint(cfg, taskId);
  const result = await pipeline.run({
    taskId,
    workDir: join(cfg.dataDir, 'tasks', taskId),
    ...(referenceUrl ? { referenceUrl } : {}),
    brief: process.env.TASK_BRIEF ?? '复刻参考视频',
    maxDurationSeconds: cfg.maxDurationSeconds,
    normalizeSize: cfg.normalizeSize,
    maxShots: cfg.maxShots,
    outputResolution: cfg.outputResolution,
    providers,
    planner,
    kernel,
    store: storage.objects,
    checkpoint,
    onCheckpoint: (cp) => saveCheckpoint(cfg, taskId, cp),
  });
  log.info('task completed', {
    taskId,
    shots: result.shotCount,
    svmlBytes: result.svml.length,
    scriptPath: result.scriptPath,
    videoKey: result.videoKey,
  });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'task':
      await runTask(rest);
      return;
    case 'serve': {
      const { main: serveMain } = await import('./server/index.js');
      serveMain();
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

// 仅当直接运行本入口时执行 main（src/server/index.ts 不会被误触发）
const isDirect = /[/\\](src|dist)[/\\]index\.(ts|js)$/.test(process.argv[1] ?? '');
if (isDirect) {
  main().catch((err) => {
    log.error('fatal', { err: String(err) });
    process.exitCode = 1;
  });
}
