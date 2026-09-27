/**
 * 参考帧上传到控制面 R2（供 Agnes 图生视频 ti2vid 使用）。
 *
 * GHA 内流水线的对象存储是本地 FS（put 返回 file://），无法直接给远端模型当 imageUrl。
 * 这里复用 callback/artifact 的 HMAC 签名通道，把抽帧上传到控制面，由 worker 写入 R2，
 * 并返回 R2 公开直链（hiauto-object.ygtxl.dpdns.org），供 Agnes 拉取。
 *
 * 依赖环境变量（GHA workflow 已注入）：
 *   CALLBACK_URL            如 https://hypitapp.ygtxl.dpdns.org/api/v1/callback/github
 *   HYPITAPP_CALLBACK_SECRET HMAC 签名密钥
 *   TASK_ID                 任务 id
 *   TASK_NAME               任务名（R2 目录用）
 * 可选：
 *   R2_PUBLIC_URL           默认 https://hiauto-object.ygtxl.dpdns.org
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { log } from '../core/logger.js';

/** 与 run-pipeline.sh 一致：<名称>_<UTC时间戳YYYYMMDDHHmm>，/ \ 替换 _。 */
export function taskDirName(name: string | undefined, id: string, createdAt: number): string {
  const base = (name && name.trim() ? name.trim() : id).replace(/[\\/]/g, '_');
  const stamp = new Date(createdAt).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `${base}_${stamp}`;
}

function signPayload(body: string, secret: string): string {
  return createHash('sha256').update(`${secret}.${body}`).digest('hex');
}

/**
 * 把一帧上传到控制面 R2，返回公开直链；失败返回 null（降级为纯文生视频）。
 * @param shotIndex 分镜序号（从 0 起，文件名用 1 起三位）
 */
export async function uploadFrameToR2(
  framePath: string,
  shotIndex: number,
  opts?: { taskId?: string; taskName?: string; createdAt?: number; callbackUrl?: string; secret?: string },
): Promise<string | null> {
  const callbackUrl = opts?.callbackUrl ?? process.env.CALLBACK_URL ?? '';
  const secret = opts?.secret ?? process.env.HYPITAPP_CALLBACK_SECRET ?? '';
  const taskId = opts?.taskId ?? process.env.TASK_ID ?? '';
  const taskName = opts?.taskName ?? process.env.TASK_NAME ?? '';
  const createdAt = opts?.createdAt ?? Date.now();
  const r2Public = process.env.R2_PUBLIC_URL ?? 'https://hiauto-object.ygtxl.dpdns.org';

  if (!callbackUrl || !secret || !taskId) {
    log.debug('uploadFrameToR2 skipped: missing callback env', { callbackUrl: !!callbackUrl, secret: !!secret, taskId: !!taskId });
    return null;
  }

  const dir = taskDirName(taskName, taskId, createdAt);
  const filename = `shot-${String(shotIndex + 1).padStart(3, '0')}.jpg`;
  const prefix = `tasks/${dir}/frames/`;
  const canonical = `artifact:${taskId}:${prefix}:${filename}`;
  const sig = signPayload(canonical, secret);

  // 从 CALLBACK_URL 推导控制面基址
  const controlBase = callbackUrl.includes('/api/v1/') ? callbackUrl.slice(0, callbackUrl.indexOf('/api/v1/')) : callbackUrl;
  const url = `${controlBase}/api/v1/callback/artifact`;

  const fd = new FormData();
  fd.append('taskId', taskId);
  fd.append('prefix', prefix);
  fd.append('fileName', filename);
  try {
    const bytes = await readFile(framePath);
    fd.append('file', new Blob([new Uint8Array(bytes)]), 'frame.jpg');
  } catch (err) {
    log.warn('uploadFrameToR2 read frame failed', { shot: shotIndex, err: String(err).slice(0, 200) });
    return null;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-callback-signature': sig },
      body: fd,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn('uploadFrameToR2 http failed', { shot: shotIndex, status: res.status, body: body.slice(0, 200) });
      return null;
    }
    const direct = `${r2Public.replace(/\/$/, '')}/${prefix}${filename}`;
    log.info('frame uploaded for image-to-video', { shot: shotIndex, key: prefix + filename, direct });
    return direct;
  } catch (err) {
    log.warn('uploadFrameToR2 exception', { shot: shotIndex, err: String(err).slice(0, 200) });
    return null;
  }
}