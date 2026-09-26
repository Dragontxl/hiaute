/**
 * 6 阶段流水线（依 V2 §7.1 / §8.4 / §8.5）
 *
 * 阶段：DETECT → ANALYZE → CROP_SHOTS → CONVERT_FRAMES → GENERATE_SHOTS → COMPOSE
 *
 * 磁盘控制要点（§8.4）：
 *  - 抽帧归一化默认 512²（可配），而非 videomodifyauto 的固定 1024²；
 *  - 中间产物按阶段落在 workDir 的 shots/ frames/ outputs/ 子目录；
 *  - 单任务时长受 maxDurationSeconds 限制，DETECT 阶段用 ffprobe 实测拦截。
 *
 * 磁盘监控（§8.5）：每阶段头尾打印 df/du；后台守护另见 docker/scripts/monitor-disk.sh。
 *
 * 依赖降级约定：ffmpeg/ffprobe 缺失时，裁切/抽帧/合成阶段**降级跳过并告警**，
 * 流水线仍产出 SVML 与分镜脚本；远端生成（Agnes）不依赖本地工具链。
 */
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { log } from '../core/logger.js';
import { STAGE_ORDER } from '../types/index.js';
import type { Stage, TaskCheckpoint, VideoAnalysis } from '../types/index.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { Planner, planShotDurations } from '../planner/index.js';
import { downloadReference } from './download.js';
import type { HypitKernel } from '../kernel/index.js';
import type { ObjectStore } from '../storage/types.js';

const run = promisify(execFile);

const ANALYSIS_PROMPT =
  '分析该参考视频：给出整体语义摘要、逐镜头区间（startSec/endSec，单位秒）、' +
  '每个镜头的画面描述、屏上文字（无则留空字符串）、特效清单，并尽量推断说话人。';

/** 单任务产物目录约定。 */
export interface PipelineDirs {
  work: string;
  shots: string;
  frames: string;
  outputs: string;
}

export interface PipelineContext {
  taskId: string;
  workDir: string;
  /** 参考视频地址；缺省则按 brief 自由创作。 */
  referenceUrl?: string;
  /** 需求文本（写入 SVML 的 brief）。 */
  brief?: string;
  /** 渲染模式：llm 生成画面 / code 代码确定性渲染。 */
  renderMode?: 'llm' | 'code';
  maxDurationSeconds: number;
  normalizeSize: number;
  outputResolution: '480p' | '720p' | '1080p';
  /** 分镜条数上限（成本控制）。 */
  maxShots: number;
  providers: ProviderRegistry;
  planner: Planner;
  kernel: HypitKernel;
  store: ObjectStore;
  checkpoint: TaskCheckpoint;
  onStage?: (stage: Stage) => void;
  /** 检查点变更后回调（供上层持久化，实现幂等恢复）。 */
  onCheckpoint?: (checkpoint: TaskCheckpoint) => void;
}

export interface PipelineResult {
  videoKey: string;
  shotCount: number;
  svml: string;
  scriptPath: string;
  clipCount: number;
  analysis?: VideoAnalysis;
  referenceSeconds?: number;
}

/** 单次运行的阶段间产物（不跨任务共享）。 */
interface Artifacts {
  referencePath?: string;
  referenceSeconds?: number;
  analysis?: VideoAnalysis;
  svml?: string;
  scriptPath?: string;
  framePaths: Array<string | undefined>;
  clipPaths: Array<string | undefined>;
  finalPath?: string;
}

export class Pipeline {
  async run(ctx: PipelineContext): Promise<PipelineResult> {
    const dirs: PipelineDirs = {
      work: ctx.workDir,
      shots: join(ctx.workDir, 'shots'),
      frames: join(ctx.workDir, 'frames'),
      outputs: join(ctx.workDir, 'outputs'),
    };
    await Promise.all([dirs.shots, dirs.frames, dirs.outputs].map((d) => mkdir(d, { recursive: true })));
    const art: Artifacts = { framePaths: [], clipPaths: [] };
    let videoKey = `tasks/${ctx.taskId}/final.mp4`;

    for (const stage of STAGE_ORDER) {
      if (ctx.checkpoint.completedStages.includes(stage)) {
        log.info('stage already completed; skip (idempotent)', { taskId: ctx.taskId, stage });
        continue;
      }
      ctx.onStage?.(stage);
      await this.snapshotDisk(ctx, `before:${stage}`);
      switch (stage) {
        case 'DETECT':
          await this.detect(ctx, dirs, art);
          break;
        case 'ANALYZE':
          await this.analyze(ctx, art);
          break;
        case 'CROP_SHOTS':
          await this.cropShots(ctx, dirs, art);
          break;
        case 'CONVERT_FRAMES':
          await this.convertFrames(ctx, dirs, art);
          break;
        case 'GENERATE_SHOTS':
          await this.generateShots(ctx, dirs, art);
          break;
        case 'COMPOSE':
          videoKey = await this.compose(ctx, dirs, art) ?? videoKey;
          break;
      }
      ctx.checkpoint.completedStages.push(stage);
      ctx.onCheckpoint?.(ctx.checkpoint);
      await this.snapshotDisk(ctx, `after:${stage}`);
    }

    const clipCount = art.clipPaths.filter(Boolean).length;
    const result: PipelineResult = {
      videoKey,
      shotCount: clipCount,
      svml: art.svml ?? '',
      scriptPath: art.scriptPath ?? '',
      clipCount,
    };
    if (art.analysis) result.analysis = art.analysis;
    if (art.referenceSeconds !== undefined) result.referenceSeconds = art.referenceSeconds;
    log.info('pipeline done', { taskId: ctx.taskId, shots: clipCount, svmlBytes: result.svml.length, videoKey });
    return result;
  }

  /* ---------------- 阶段 1：DETECT 下载素材 + 时长拦截（§8.4 主杠杆） ---------------- */

  private async detect(ctx: PipelineContext, dirs: PipelineDirs, art: Artifacts): Promise<void> {
    if (!ctx.referenceUrl) {
      log.info('DETECT: no reference video; freeform generation from brief');
      return;
    }
    const dest = join(dirs.work, 'reference.mp4');
    // 参考链接可能是视频页面（B 站/YouTube…）而非直链：优先 yt-dlp，不可用退回 fetch
    const bytes = await downloadReference(ctx.referenceUrl, dest);
    art.referencePath = dest;
    const seconds = await probeSeconds(dest);
    if (seconds !== undefined) art.referenceSeconds = seconds;
    log.info('DETECT: reference downloaded', {
      bytes,
      seconds,
      normalizeSize: ctx.normalizeSize,
    });
    if (seconds !== undefined && seconds > ctx.maxDurationSeconds) {
      throw new Error(
        `reference is ${seconds.toFixed(1)}s but MAX_DURATION_SECONDS=${ctx.maxDurationSeconds}s; ` +
          'shorten the source or raise the cap (§8.4)',
      );
    }
  }

  /* ---------------- 阶段 2：ANALYZE 参考视频理解（Gemini） ---------------- */

  private async analyze(ctx: PipelineContext, art: Artifacts): Promise<void> {
    if (!art.referencePath) {
      log.info('ANALYZE skipped: no reference video');
      return;
    }
    const bytes = await readFile(art.referencePath);
    try {
      const analysis = await ctx.providers.gemini.analyzeReference({
        bytes,
        mimeType: 'video/mp4',
        prompt: ANALYSIS_PROMPT,
      });
      art.analysis = analysis;
      log.info('ANALYZE: reference understood', {
        shots: analysis.shots.length,
        speakers: analysis.speakers?.length ?? 0,
        summaryBytes: analysis.summary.length,
      });
    } catch (err) {
      log.error('ANALYZE failed', { err: String(err) });
      throw err;
    }
  }

  /* ---------------- 阶段 3：CROP_SHOTS 按分镜裁切 ---------------- */

  private async cropShots(ctx: PipelineContext, dirs: PipelineDirs, art: Artifacts): Promise<void> {
    const shots = art.analysis?.shots ?? [];
    if (!art.referencePath || shots.length === 0) {
      log.info('CROP_SHOTS skipped: no reference or no shots');
      return;
    }
    if (!(await resolveBin('ffmpeg'))) {
      log.warn('ffmpeg not found; CROP_SHOTS skipped');
      return;
    }
    let ok = 0;
    for (const shot of shots) {
      const dest = join(dirs.shots, `shot-${pad(shot.index)}.mp4`);
      try {
        await ffmpeg(ctx.taskId, [
          '-ss', secs(shot.startSec),
          '-to', secs(shot.endSec),
          '-i', art.referencePath,
          '-c', 'copy',
          '-y', dest,
        ]);
        ok += 1;
      } catch (err) {
        log.warn('crop failed for shot; continue', { index: shot.index, err: String(err) });
      }
    }
    log.info('CROP_SHOTS done', { cropped: ok, total: shots.length });
  }

  /* ---------------- 阶段 4：CONVERT_FRAMES 抽帧归一化（§8.4 降档） ---------------- */

  private async convertFrames(ctx: PipelineContext, dirs: PipelineDirs, art: Artifacts): Promise<void> {
    const shots = art.analysis?.shots ?? [];
    if (!art.referencePath || shots.length === 0) {
      log.info('CONVERT_FRAMES skipped: no reference or no shots');
      return;
    }
    if (!(await resolveBin('ffmpeg'))) {
      log.warn('ffmpeg not found; CONVERT_FRAMES skipped');
      return;
    }
    const size = ctx.normalizeSize;
    let ok = 0;
    for (const shot of shots) {
      const dest = join(dirs.frames, `shot-${pad(shot.index)}.jpg`);
      const startSec = Number(shot.startSec) || 0;
      const endSec = Number(shot.endSec) || 0;
      const midSec = (startSec + endSec) / 2;
      try {
        await ffmpeg(ctx.taskId, [
          '-ss', secs(midSec),
          '-i', art.referencePath,
          '-frames:v', '1',
          '-vf', `scale=${size}:-2`,
          '-q:v', '3',
          '-y', dest,
        ]);
        art.framePaths[shot.index] = dest;
        ok += 1;
      } catch (err) {
        log.warn('frame extract failed for shot; continue', { index: shot.index, err: String(err) });
      }
    }
    log.info('CONVERT_FRAMES done', { frames: ok, size });
  }

  /* ---------------- 阶段 5：GENERATE_SHOTS 写脚本 + 逐镜生成 ---------------- */

  private async generateShots(ctx: PipelineContext, dirs: PipelineDirs, art: Artifacts): Promise<void> {
    const analysis = art.analysis;
    const cap = ctx.providers.agnesVideo.capabilities.maxSecondsPerShot ?? 12;
    // 目标总时长：优先对齐参考视频实际时长；自由创作/时长未知时保守取 maxShots*cap
    // （避免无参考时长时回落成 maxDurationSeconds=180 → 分镜数暴涨 → 成本失控）
    const freeformTarget = ctx.maxShots * cap;
    const targetSeconds = Math.min(art.referenceSeconds ?? freeformTarget, ctx.maxDurationSeconds);
    const durations = planShotDurations(analysis, targetSeconds, cap, { maxShots: ctx.maxShots });

    // 先落盘脚本再校验：SVML 是「生成后编辑」的入口（§5 必要条件 3）
    const svml = await ctx.planner.writeScript({
      brief: ctx.brief ?? '复刻参考视频',
      targetSeconds,
      ...(analysis ? { analysis } : {}),
    });
    const scriptPath = join(dirs.work, 'script.svml');
    await writeFile(scriptPath, svml, 'utf8');
    art.svml = svml;
    art.scriptPath = scriptPath;
    log.info('script written', { scriptPath, bytes: Buffer.byteLength(svml) });

    if (await ctx.kernel.available()) {
      try {
        await ctx.kernel.check(scriptPath);
        log.info('svml check ok', { scriptPath });
      } catch (err) {
        log.error('svml check failed', { scriptPath, err: String(err) });
        throw new Error(`SVML compile check failed for ${scriptPath}: ${String(err)}`);
      }
    } else {
      log.warn('hypit CLI not available; skip SVML compile check', { scriptPath });
    }

    const total = durations.reduce((s, v) => s + v, 0);
    log.info('shot plan ready', { shots: durations.length, totalSeconds: total, cap });

    for (let i = 0; i < durations.length; i += 1) {
      const dest = join(dirs.outputs, `shot-${pad(i)}.mp4`);
      if (ctx.checkpoint.completedShots.includes(i) && art.clipPaths[i]) {
        continue;
      }
      // 幂等恢复：上一轮已生成且文件仍在磁盘上，直接复用（不重复花钱）
      if (ctx.checkpoint.completedShots.includes(i) && (await fileExists(dest))) {
        art.clipPaths[i] = dest;
        log.info('shot reused from disk (idempotent)', { index: i, dest });
        continue;
      }
      const seconds = durations[i]!;
      if (ctx.renderMode === 'code') {
        await ffmpeg(ctx.taskId, [
          '-f', 'lavfi', '-i', 'color=c=0x10216e:s=1280x720:r=24',
          '-vf', `drawtext=text='Shot ${i + 1}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=(h-text_h)/2`,
          '-t', String(seconds), '-r', '24', '-pix_fmt', 'yuv420p', '-y', dest,
        ]);
        art.clipPaths[i] = dest;
        ctx.checkpoint.completedShots.push(i);
        ctx.onCheckpoint?.(ctx.checkpoint);
        log.info('shot generated (code)', { index: i, seconds });
        continue;
      }
      // 抽帧按 analysis.shots 的 index 落盘，这里把生成序号映射回原始分镜序号
      const framePath = art.framePaths[analysis?.shots[i]?.index ?? -1];

      // 抽帧作为图生视频的首帧（仅当对象存储给出可公网访问的 URL 时可用）
      let imageUrl: string | undefined;
      if (framePath) {
        const url = await ctx.store.put(
          `tasks/${ctx.taskId}/frames/shot-${pad(i)}.jpg`,
          await readFile(framePath),
          'image/jpeg',
        );
        if (/^https?:\/\//i.test(url)) imageUrl = url;
      }

      const result = await ctx.providers.agnesVideo.generate({
        prompt: shotPrompt(analysis, i),
        seconds,
        resolution: ctx.outputResolution,
        ...(imageUrl ? { imageUrl } : {}),
      });

      await downloadFile(result.videoUrl, dest);
      art.clipPaths[i] = dest;
      ctx.checkpoint.remoteTasks[`shot-${i}`] = result.taskId;
      ctx.checkpoint.completedShots.push(i);
      ctx.onCheckpoint?.(ctx.checkpoint);
      log.info('shot generated', { index: i, seconds, remoteTaskId: result.taskId });
    }
  }

  /* ---------------- 阶段 6：COMPOSE 合成 ---------------- */

  private async compose(ctx: PipelineContext, dirs: PipelineDirs, art: Artifacts): Promise<string | undefined> {
    let clips = art.clipPaths.filter((p): p is string => Boolean(p));
    // 幂等恢复：GENERATE_SHOTS 已标记完成时本轮不会重跑，需从磁盘扫回分镜片段
    if (clips.length === 0) {
      art.clipPaths = await scanClips(dirs.outputs);
      clips = art.clipPaths.filter((p): p is string => Boolean(p));
    }
    log.info('compose clips', { clipCount: clips.length });
    if (clips.length === 0) {
      log.warn('COMPOSE skipped: no generated clips');
      return undefined;
    }
    const finalPath = join(dirs.outputs, 'final.mp4');
    try {
      if (clips.length === 1 || !(await resolveBin('ffmpeg'))) {
        if (clips.length === 1) {
          await copyFile(clips[0]!, finalPath);
        } else {
          log.warn('ffmpeg not found; COMPOSE skipped, clips left in outputs/');
          return undefined;
        }
      } else {
        const listPath = join(dirs.outputs, 'concat.txt');
        // 使用绝对路径写入 concat.txt：ffmpeg 的 concat demuxer 会把 file 条目解析为
        // 相对于 concat.txt 所在目录的路径，若条目本身已是相对路径则会被再次拼接导致路径翻倍。
        const absClips = clips.map(c => resolve(c));
        await writeFile(listPath, absClips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
        await ffmpeg(ctx.taskId, ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', finalPath]);
      }
    } catch (err) {
      log.error('compose failed', { err: String(err) });
      return undefined;
    }

    const key = `tasks/${ctx.taskId}/final.mp4`;
    try {
      const url = await ctx.store.put(key, await readFile(finalPath), 'video/mp4');
      log.info('final uploaded', { key, url, resolution: ctx.outputResolution });
    } catch (err) {
      log.error('upload final failed; video kept on disk', { finalPath, err: String(err) });
    }
    art.finalPath = finalPath;
    return key;
  }

  /** 阶段边界磁盘快照（§8.5 ①）。失败不阻断流水线。 */
  private async snapshotDisk(ctx: PipelineContext, label: string): Promise<void> {
    if (process.platform === 'win32') return; // df/du 不可用，交由 monitor-disk.sh 覆盖
    try {
      const { stdout } = await run('bash', ['-lc', `df -Pm / | awk 'NR==2{print $3","$4","$5}'; du -sm "${ctx.workDir}" 2>/dev/null | awk '{print $1}'`]);
      const lines = stdout.trim().split('\n').filter(Boolean);
      log.info('disk snapshot', {
        label,
        used_avail_pct_MB: lines[0],
        workdir_MB: lines[1],
      });
    } catch {
      // 非 Linux 或工具缺失：忽略
    }
  }
}

/* ---------------- 工具函数 ---------------- */

function pad(n: number): string {
  return String(n).padStart(3, '0');
}

function secs(v: number): string {
  return Number.isFinite(v) && v >= 0 ? v.toFixed(3) : '0.000';
}

/** 常见二进制的回退绝对路径（防止 runner 上 PATH 解析不到）。 */
const BIN_FALLBACKS: Record<string, string[]> = {
  ffmpeg: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg'],
  ffprobe: ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', '/bin/ffprobe'],
};

/** 解析可用的二进制路径（结果缓存）；找不到返回 null。 */
const binCache = new Map<string, string | null>();

async function resolveBin(bin: string): Promise<string | null> {
  if (binCache.has(bin)) return binCache.get(bin) ?? null;
  let found: string | null = null;
  for (const candidate of [bin, ...(BIN_FALLBACKS[bin] ?? [])]) {
    try {
      await run(candidate, ['-version'], { timeout: 8_000 });
      found = candidate;
      break;
    } catch (err) {
      log.debug('resolveBin miss', { candidate, err: String(err).slice(0, 200) });
    }
  }
  if (!found) log.warn('binary not found', { bin, tried: [bin, ...(BIN_FALLBACKS[bin] ?? [])] });
  binCache.set(bin, found);
  return found;
}

/** ffmpeg 统一入口：使用解析到的路径；错误输出进 stderr，非零退出抛错。 */
async function ffmpeg(_taskId: string, args: string[]): Promise<string> {
  const bin = await resolveBin('ffmpeg');
  if (!bin) throw new Error('ffmpeg not found');
  const { stdout, stderr } = await run(bin, ['-hide_banner', '-loglevel', 'error', ...args], {
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return [stdout, stderr].filter(Boolean).join('\n');
}

/** ffprobe 实测时长（秒）；工具缺失或失败返回 undefined。 */
async function probeSeconds(path: string): Promise<number | undefined> {
  const bin = await resolveBin('ffprobe');
  if (!bin) return undefined;
  try {
    const { stdout } = await run(
      bin,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
      { timeout: 30_000 },
    );
    const n = Number.parseFloat(stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** 文件是否存在（用于断点恢复时判断中间产物是否可复用）。 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 从 outputs/ 扫回 shot-NNN.mp4，返回按下标对齐的数组（幂等恢复用）。 */
async function scanClips(outDir: string): Promise<Array<string | undefined>> {
  let entries: string[];
  try {
    entries = await readdir(outDir);
  } catch {
    return [];
  }
  const out: Array<string | undefined> = [];
  for (const e of entries) {
    const m = /^shot-(\d{3})\.mp4$/.exec(e);
    if (m) out[Number.parseInt(m[1]!, 10)] = join(outDir, e);
  }
  return out;
}

/** 下载到本地文件，返回字节数。 */
async function downloadFile(url: string, dest: string, timeoutMs = 10 * 60_000): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    if (!res.body) throw new Error('download failed: empty response body');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('download failed: zero bytes');
    await writeFile(dest, buf);
    return buf.length;
  } finally {
    clearTimeout(timer);
  }
}

/** 组装单镜 prompt：画面 + 屏上文字 + 特效，保证复刻要素不丢。 */
function shotPrompt(analysis: VideoAnalysis | undefined, i: number): string {
  const s = analysis?.shots[i];
  if (!s) return `按脚本生成第 ${i + 1} 个镜头的画面。`;
  const parts = [`镜头 ${s.index}（${s.startSec}s–${s.endSec}s）：${s.description}`];
  if (s.onScreenText) parts.push(`屏上文字：${s.onScreenText}`);
  if (s.effects && s.effects.length > 0) parts.push(`特效：${s.effects.join('、')}`);
  return parts.join('\n');
}
