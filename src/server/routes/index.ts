/**
 * HTTP 路由（依 V2 §7.1 / §7.3）
 *
 * 端点：
 *  - POST /api/v1/tasks              创建任务（可选 dispatch 到 Actions）
 *  - GET  /api/v1/tasks              列出任务
 *  - GET  /api/v1/tasks/:id          查询任务状态
 *  - POST /api/v1/tasks/:id/studio   启动该任务的 Studio 编辑会话（生成后编辑闭环）
 *  - GET  /api/v1/studio             列出活动 Studio 会话
 *  - POST /api/v1/studio/stop        结束 Studio 会话（body: { runFile }）
 *  - POST /api/v1/callback/github    接收 Actions 回调（校验签名 X-Callback-Signature，不走 Bearer）
 *  - GET  /healthz                   健康检查
 *
 * 安全边界：
 *  - 除 /api/v1/callback/* 外的 /api/v1 全部要求 Authorization: Bearer <HYPITAPP_API_TOKEN>；
 *    未配置令牌时仅放行（仅限本地开发），并在启动日志里告警。
 *  - 所有 JSON body 经 zod 校验，超限/非法直接 400，不透传给下游。
 *
 * 存储无关：仅依赖统一 StorageBundle（memory / cloudflare 驱动皆可）。
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { dispatchTask } from '../dispatch.js';
import { buildFileRoutes, safeKey, mimeFromKey } from './files.js';
import { verifyPayloadSignature, safeEqual } from '../../core/crypto.js';
import { log } from '../../core/logger.js';
import { RUN_FILE_RE, StudioManager } from '../../kernel/studio.js';
import { parseCheckpoint } from '../../storage/merge.js';
import type { StorageBundle } from '../../storage/types.js';
import { artifactDirName } from '../../storage/taskName.js';
import type { AppConfig } from '../../types/index.js';

/* ---------------- 校验 schema ---------------- */

const STAGE_ENUM = z.enum(['DETECT', 'ANALYZE', 'CROP_SHOTS', 'CONVERT_FRAMES', 'GENERATE_SHOTS', 'COMPOSE'] as const);
const STATUS_ENUM = z.enum(['PENDING', 'DISPATCHED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED'] as const);

function buildSchemas(cfg: AppConfig) {
  // 上限即 cfg 的值：单任务请求不得放大系统级降档策略（§8.4）
  const createTask = z
    .object({
      name: z.string().max(128),
      referenceUrl: z.string().url().max(2048),
      brief: z.string().max(4000),
      maxDurationSeconds: z.number().int().min(1).max(cfg.maxDurationSeconds),
      maxShots: z.number().int().min(1).max(200),
      outputResolution: z.enum(['480p', '720p', '1080p'] as const),
      renderMode: z.enum(['llm', 'code'] as const),
      runFile: z.string().max(512).regex(RUN_FILE_RE),
    })
    .partial();

  const studioStart = z
    .object({
      runFile: z.string().max(512).regex(RUN_FILE_RE),
      port: z.number().int().min(1024).max(65535),
    })
    .partial();

  const studioStop = z.object({ runFile: z.string().max(512).regex(RUN_FILE_RE) });

  const callback = z.object({
    taskId: z.string().min(1).max(128),
    status: STATUS_ENUM.optional(),
    stage: STAGE_ENUM.optional(),
    error: z.string().max(8000).optional(),
    checkpoint: z.unknown().optional(),
  });

  return { createTask, studioStart, studioStop, callback };
}

/* ---------------- 请求体解析 ---------------- */

type Parsed<T> = { ok: true; data: T } | { ok: false; error: string; detail: string };

function fmtZod(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** 读 JSON + zod 校验；任何失败都返回可判定的 Parsed 结构，不抛未处理异常。 */
async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<Parsed<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, error: 'invalid JSON body', detail: 'request body must be a valid JSON object' };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: 'invalid request', detail: fmtZod(parsed.error) };
}

function reject(c: Context, p: { error: string; detail: string }) {
  return c.json({ error: p.error, detail: p.detail }, 400);
}

/**
 * 分发任务到 GitHub Actions（幂等重放安全）。
 *
 * 返回：
 *  - 'skipped'：未配置 GITHUB_PAT/OWNER/REPO，任务保持 PENDING（由重试端点稍后重放）
 *  - 'ok'     ：已派发，任务置 DISPATCHED
 *  - 'failed' ：派发失败，任务置 FAILED 并记录错误
 */
async function tryDispatch(
  cfg: AppConfig,
  storage: StorageBundle,
  taskId: string,
  referenceUrl: string,
  maxDurationSeconds: number,
  taskDir?: string,
  brief?: string,
  renderMode?: 'llm' | 'code',
): Promise<'skipped' | 'ok' | 'failed'> {
  if (!cfg.github) {
    log.warn('github dispatch skipped: GITHUB_PAT/GITHUB_OWNER/GITHUB_REPO not configured', { taskId });
    return 'skipped';
  }
  try {
    await dispatchTask(cfg.github, {
      taskId,
      ...(taskDir ? { taskDir } : {}),
      referenceUrl,
      maxDurationSeconds,
      ...(brief ? { brief } : {}),
      ...(renderMode ? { renderMode } : {}),
    });
    await storage.tasks.markStatus(taskId, 'DISPATCHED');
    return 'ok';
  } catch (err) {
    log.error('dispatch failed', { taskId, err: String(err) });
    await storage.tasks.markStatus(taskId, 'FAILED', String(err));
    return 'failed';
  }
}

/* ---------------- 鉴权 ---------------- */

function bearerAuth(cfg: AppConfig): MiddlewareHandler {
  if (!cfg.apiToken) return async (_c, next) => next();
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const sp = header.indexOf(' ');
    const scheme = sp >= 0 ? header.slice(0, sp) : '';
    const token = sp >= 0 ? header.slice(sp + 1).trim() : '';
    if (scheme.toLowerCase() !== 'bearer' || !safeEqual(token, cfg.apiToken!)) {
      return c.json({ error: 'unauthorized', detail: 'expected header: Authorization: Bearer <HYPITAPP_API_TOKEN>' }, 401);
    }
    await next();
  };
}

/* ---------------- 路由 ---------------- */

export function buildRoutes(cfg: AppConfig, storage: StorageBundle, studio?: StudioManager): Hono {
  const schemas = buildSchemas(cfg);
  const app = new Hono();

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      driver: storage.driver,
      auth: cfg.apiToken ? 'enabled' : 'disabled',
      // dispatch=disabled 时新建任务将保持 PENDING（未配置 GITHUB_PAT/OWNER/REPO）
      dispatch: cfg.github ? 'enabled' : 'disabled',
      ts: Date.now(),
    }),
  );

  /**
   * Actions 回调：校验签名后更新状态（§7.3 带签名回调闭环）。
   * 必须注册在 /api/v1 子路由**之前**——否则会被子路由的 Bearer 中间件拦下。
   */
  app.post('/api/v1/callback/github', async (c) => {
    const raw = await c.req.text();
    const signature = c.req.header('x-callback-signature') ?? '';
    if (!cfg.callbackSecret) {
      log.warn('callback accepted without secret configured', { bodyBytes: raw.length });
    } else if (!verifyPayloadSignature(raw, cfg.callbackSecret, signature)) {
      log.warn('callback signature mismatch');
      return c.json({ error: 'invalid signature' }, 401);
    }
    const body = await readBody(c, schemas.callback);
    if (!body.ok) return reject(c, body);
    const p = body.data;
    const t = await storage.tasks.get(p.taskId);
    if (!t) return c.json({ error: 'unknown task' }, 404);
    if (p.status) await storage.tasks.markStatus(p.taskId, p.status, p.error);
    if (p.stage) await storage.tasks.advanceStage(p.taskId, p.stage);
    if (p.checkpoint !== undefined) await storage.tasks.mergeCheckpoint(p.taskId, parseCheckpoint(p.checkpoint));
    log.info('callback applied', { taskId: p.taskId, status: p.status });
    return c.json(await storage.tasks.get(p.taskId));
  });

  /**
   * 产物上传回调（GHA → 控制面 → R2）。
   *
   * 用与状态回调相同的 HMAC 签名（X-Callback-Signature = sha256(`${secret}.${canonical}`)）鉴权，
   * canonical = `artifact:${taskId}:${prefix}:${filename}`，使 GHA 无需持有控制面 Bearer 令牌
   * 即可把 final.mp4 / script.svml / frames 写入 R2（出现在文件管理页面）。必须注册在 /api/v1 子路由之前。
   */
  app.post('/api/v1/callback/artifact', async (c) => {
    if (!cfg.callbackSecret) return c.json({ error: 'callback secret not configured' }, 503);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: 'missing file' }, 400);
    const taskIdRaw = form.get('taskId');
    const prefixField = form.get('prefix');
    const taskId = typeof taskIdRaw === 'string' ? taskIdRaw : '';
    const prefixRaw = typeof prefixField === 'string' ? prefixField : '';
    const filename = file.name || 'artifact.bin';
    const canonical = `artifact:${taskId}:${prefixRaw}:${filename}`;
    if (!verifyPayloadSignature(canonical, cfg.callbackSecret, c.req.header('x-callback-signature') ?? '')) {
      log.warn('artifact signature mismatch', { taskId, filename });
      return c.json({ error: 'invalid signature' }, 401);
    }
    const prefix = safeKey(prefixRaw);
    if (prefix === null) return c.json({ error: 'invalid prefix' }, 400);
    const key = safeKey(`${prefix}${filename}`);
    if (key === null) return c.json({ error: 'invalid filename' }, 400);
    const buf = await file.arrayBuffer();
    const contentType = file.type && file.type !== 'application/octet-stream' ? file.type : mimeFromKey(key);
    await storage.objects.put(key, buf, contentType);
    log.info('artifact uploaded to R2', { key, bytes: buf.byteLength });
    return c.json({ key, size: buf.byteLength }, 201);
  });

  // 需要 Bearer 令牌的控制面路由
  const api = new Hono();
  api.use(bearerAuth(cfg));

  api.post('/tasks', async (c) => {
    const body = await readBody(c, schemas.createTask);
    if (!body.ok) return reject(c, body);
    const b = body.data;
      const task = await storage.tasks.create({
        ...(b.name ? { name: b.name } : {}),
        ...(b.referenceUrl ? { referenceUrl: b.referenceUrl } : {}),
        ...(b.runFile ? { runFile: b.runFile } : {}),
        maxDurationSeconds: b.maxDurationSeconds ?? cfg.maxDurationSeconds,
        normalizeSize: cfg.normalizeSize,
        outputResolution: b.outputResolution ?? cfg.outputResolution,
        ...(b.renderMode ? { renderMode: b.renderMode } : {}),
        ...(b.brief ? { brief: b.brief } : {}),
      });
      await tryDispatch(cfg, storage, task.id, task.referenceUrl ?? '', task.maxDurationSeconds, artifactDirName(task.name, task.id, task.createdAt), task.brief, task.renderMode);
    const created = await storage.tasks.get(task.id);
    // 派发失败：与旧行为一致返回 502，便于前端明确感知
    if (created?.status === 'FAILED' && created.error) {
      return c.json({ error: 'dispatch failed', detail: created.error }, 502);
    }
    return c.json(created, 201);
  });

  api.get('/tasks', async (c) => c.json({ tasks: await storage.tasks.list() }));

  api.get('/tasks/:id', async (c) => {
    const t = await storage.tasks.get(c.req.param('id'));
    if (!t) return c.json({ error: 'not found' }, 404);
    return c.json(t);
  });

  /**
   * 任务重试：对 PENDING/FAILED/PAUSED 任务重新分发到 GitHub Actions。
   * 典型场景：任务创建时未配置 GITHUB_PAT/OWNER/REPO 导致 dispatch 被跳过而永远停在 PENDING，
   * 配置补齐后由此端点重放分发。终态 COMPLETED/DISPATCHED/RUNNING 不可重试。
   */
  api.post('/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const t = await storage.tasks.get(id);
    if (!t) return c.json({ error: 'not found' }, 404);
    if (t.status !== 'PENDING' && t.status !== 'FAILED' && t.status !== 'PAUSED') {
      return c.json({ error: 'not retryable', detail: `status ${t.status} 不支持重试（仅 PENDING/FAILED/PAUSED）` }, 409);
    }
    const r = await tryDispatch(cfg, storage, id, t.referenceUrl ?? '', t.maxDurationSeconds, artifactDirName(t.name, id, t.createdAt), t.brief, t.renderMode);
    if (r === 'skipped') {
      return c.json(
        { error: 'dispatch unavailable', detail: '未配置 GITHUB_PAT/GITHUB_OWNER/GITHUB_REPO，无法派发（请先配置 worker secret）' },
        503,
      );
    }
    if (r === 'failed') {
      return c.json({ error: 'dispatch failed', detail: (await storage.tasks.get(id))?.error ?? '' }, 502);
    }
    return c.json(await storage.tasks.get(id));
  });

  /**
   * 生成后编辑：启动该任务的 Studio 会话（仅形态 A/C 或常驻控制面可用）。
   * 请求体可选 { runFile, port }，runFile 缺省用任务记录，再缺省 runs/main.svrun。
   */
  api.post('/tasks/:id/studio', async (c) => {
    if (!studio) {
      return c.json(
        { error: 'studio unavailable', detail: '本部署形态未启用 Studio（GHA 一次性 runner / Workers 无法承载常驻编辑器）' },
        503,
      );
    }
    const id = c.req.param('id');
    const t = await storage.tasks.get(id);
    if (!t) return c.json({ error: 'not found' }, 404);
    const body = await readBody(c, schemas.studioStart);
    if (!body.ok) return reject(c, body);
    const runFile = body.data.runFile ?? t.runFile ?? 'runs/main.svrun';
    try {
      const handle = await studio.start({
        cli: cfg.hypitCli,
        cwd: cfg.dataDir,
        runFile,
        ...(body.data.port !== undefined ? { port: body.data.port } : {}),
      });
      await storage.tasks.update(id, { runFile });
      return c.json({ url: handle.url, runFile: handle.runFile, pid: handle.pid }, 201);
    } catch (err) {
      log.error('studio start failed', { taskId: id, err: String(err) });
      return c.json({ error: 'studio start failed', detail: String(err) }, 502);
    }
  });

  /** 列出活动 Studio 会话。 */
  api.get('/studio', (c) => c.json({ sessions: studio ? studio.list() : [] }));

  /** 结束 Studio 会话。 */
  api.post('/studio/stop', async (c) => {
    if (!studio) return c.json({ error: 'studio unavailable' }, 503);
    const body = await readBody(c, schemas.studioStop);
    if (!body.ok) return reject(c, body);
    const stopped = await studio.stop(body.data.runFile);
    return c.json({ stopped });
  });

  /** 文件管理路由（上传/下载/列举/删除/预览）。 */
  api.route('/files', buildFileRoutes(storage));

  app.route('/api/v1', api);

  app.notFound((c) => c.json({ error: 'not found', path: c.req.path }, 404));

  return app;
}
