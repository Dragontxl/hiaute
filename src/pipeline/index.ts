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
import { uploadFrameToR2 } from './r2frame.js';
import type { HypitKernel } from '../kernel/index.js';
import type { ObjectStore } from '../storage/types.js';
import { renderHypitTask, type RenderShot } from '../render/hypitRender.js';

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
  /** 从 SVML 提取的逐镜头文字（description/onScreenText），供 code 模式确定性渲染。 */
  scriptShots?: Array<{ description: string; onScreenText?: string }>;
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
    // code 模式为图形动画短片：总时长压到 CONTENT_SECONDS（15-25s），每镜 3-4s，
    // 既保证观感（不冗长）又控制 HyperFrames CPU 渲染时间（每帧软渲染约 1s）。
    const CODE_TARGET_SECONDS = Math.min(Number(process.env.CODE_TARGET_SECONDS ?? 24), ctx.maxDurationSeconds);
    const freeformTarget = ctx.renderMode === 'code' ? CODE_TARGET_SECONDS : ctx.maxShots * cap;
    const targetSeconds = Math.min(art.referenceSeconds ?? freeformTarget, ctx.maxDurationSeconds);
    // 参考视频模式：不复刻压缩分镜，保留分析出的全部场景（每个分析分镜 → 一个生成分镜）。
    // 只有真正的自由创作（无参考视频）才受 maxShots 成本控制。
    const effectiveMaxShots = analysis && art.referenceSeconds ? Math.max(ctx.maxShots, analysis.shots.length) : ctx.maxShots;
    let durations = planShotDurations(analysis, targetSeconds, cap, { maxShots: effectiveMaxShots });

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
    // 无论 code 还是 llm 模式，brief 都已由 LLM 展开成脚本；code 模式据此渲染画面文字
    art.scriptShots = parseScriptShots(svml);
    log.info('script written', { scriptPath, bytes: Buffer.byteLength(svml), scriptShots: art.scriptShots.length });

    // 自由创作（无参考视频）：按脚本分镜数切分镜头，保证每个分镜都有对应的脚本内容，
    // 避免镜头数与 @moment 数不一致导致部分镜头落回通用占位 prompt。
    if (!analysis && art.scriptShots.length > 0) {
      const n = Math.min(art.scriptShots.length, ctx.maxShots);
      const promo = Math.max(1, Math.round(targetSeconds / n));
      const perShot = ctx.renderMode === 'code' ? Math.max(1, Math.min(promo, 6)) : Math.min(cap, promo);
      durations = Array.from({ length: n }, () => perShot);
      log.info('freeform shot plan (by script)', { shots: n, perShot, totalSeconds: n * perShot, mode: ctx.renderMode, scriptShots: art.scriptShots.length });
    }

    // 注意：script.svml 是 Hypitapp 自己的简化脚本方言（@moment/@cue/@visual），
    // 不是 hypit 官方 XML 源，因此**不能**交给 hypit check。
    // 官方格式的编译校验发生在 code 模式生成 author.svml 之后（见 renderHypitTask）。

    const total = durations.reduce((s, v) => s + v, 0);
    log.info('shot plan ready', { shots: durations.length, totalSeconds: total, cap });

    // code 模式主路径：一次 hypit build 渲染完整视频（官方模板，非逐镜）。
    // 成功则产出 outputs/final.mp4 并结束 GENERATE_SHOTS；失败/不可用降级到 ffmpeg 逐镜。
    if (ctx.renderMode === 'code') {
      const rendered = await this.renderCodeWithHypit(ctx, dirs, art, durations);
      if (rendered) {
        ctx.checkpoint.completedStages = dedupe([...ctx.checkpoint.completedStages, 'GENERATE_SHOTS', 'COMPOSE']);
        ctx.onCheckpoint?.(ctx.checkpoint);
        return;
      }
      log.warn('hypit render unavailable; fall back to ffmpeg per-shot code render');
    }

    // 第一遍：幂等跳过 + code 模式逐镜渲染（串行、廉价）；llm 镜头只收集不执行
    const llmJobs: Array<{ index: number; seconds: number; dest: string; framePath?: string }> = [];
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
        // code 模式：确定性渲染，不调视频模型。文字内容来自 LLM 已展开的脚本
        // （scriptShots 优先，其次参考视频分析，最后才落回原始 brief）。
        const scriptShot = art.scriptShots?.[i];
        const analysisShot = analysis?.shots[i];
        const shotDesc = scriptShot?.description || analysisShot?.description || ctx.brief || `第 ${i + 1} 个镜头`;
        const onScreen = scriptShot?.onScreenText || analysisShot?.onScreenText;
        const text = shotDesc;
        // 中文字体：GHA 装了 fonts-noto-cjk；本地 macOS/其他平台各自探测，找不到就用默认字体（英文 fallback）
        const fontfiles = [
          '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
          '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
          '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
          '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
          '/System/Library/Fonts/PingFang.ttc',
          'C:/Windows/Fonts/msyh.ttc',
        ];
        let fontfile: string | undefined;
        for (const f of fontfiles) {
          if (await fileExists(f)) {
            fontfile = f;
            break;
          }
        }
        const fontArg = fontfile ? `:fontfile=${fontfile.replace(/:/g, '\\:')}` : '';
        const esc = (s: string) =>
          s.replace(/'/g, "'\\''").replace(/\n/g, ' ').replace(/\r/g, ' ').slice(0, 200);
        const drawtexts = [
          `drawtext=text='${esc(text)}':fontcolor=white:fontsize=44:x=(w-text_w)/2:y=h/2-60${fontArg}`,
          ...(onScreen
            ? [`drawtext=text='${esc(onScreen)}':fontcolor=yellow:fontsize=36:x=(w-text_w)/2:y=h/2+40${fontArg}`]
            : []),
          `drawtext=text='${i + 1}':fontcolor=white@0.4:fontsize=120:x=w-180:y=h-180${fontArg}`,
        ];
        await ffmpeg(ctx.taskId, [
          '-f', 'lavfi', '-i', 'color=c=0x10216e:s=1280x720:r=24',
          '-vf', drawtexts.join(','),
          '-t', String(seconds), '-r', '24', '-pix_fmt', 'yuv420p', '-y', dest,
        ]);
        art.clipPaths[i] = dest;
        ctx.checkpoint.completedShots.push(i);
        ctx.onCheckpoint?.(ctx.checkpoint);
        log.info('shot generated (code)', { index: i, seconds, text: text.slice(0, 40), font: fontfile });
        continue;
      }
      // 抽帧按 analysis.shots 的 index 落盘，这里把生成序号映射回原始分镜序号。
      // 防御：帧文件可能缺失（抽帧对失败镜头是跳过而非中断），缺失则降级为纯文生，
      // 避免生成阶段 readFile 抛 ENOENT 拖垮整个任务。
      const rawFrame = art.framePaths[analysis?.shots[i]?.index ?? -1];
      const framePath = rawFrame && (await fileExists(rawFrame)) ? rawFrame : undefined;
      if (rawFrame && !framePath) {
        log.warn('frame missing; fall back to text-to-video', { index: i, framePath: rawFrame });
      }
      llmJobs.push({ index: i, seconds, dest, ...(framePath ? { framePath } : {}) });
    }

    // 第二遍：llm 镜头受控并发生成。
    // 并行上限 = MAX_PARALLEL_GENERATION（默认 4）；账户池每账户 max_concurrent=1，
    // 保证同时最多占用 4 个不同账户（ABCD 而非 AACD）。
    if (llmJobs.length > 0) {
      const MAX_PARALLEL = clampInt(Number(process.env.MAX_PARALLEL_GENERATION ?? 4), 1, 5);
      // 单片段硬失败重试次数（默认 2：最多 3 次尝试），仍失败则跳过该片段、不拖垮整个任务
      const SHOT_RETRIES = clampInt(Number(process.env.MAX_SHOT_RETRIES ?? 2), 0, 5);
      // 生成阶段墙钟预算（§8.4 兜底）：超时后停止调度新镜头，带着已完成片段进入 COMPOSE，
      // 避免被外部（CI 超时 / 控制面取消）中途掐断导致整单无 final.mp4。
      const GENERATE_BUDGET_MS = clampInt(Number(process.env.GENERATE_BUDGET_SECONDS ?? 5400), 60, 6 * 3600) * 1000;
      const generateStartedAt = Date.now();
      // checkpoint 落盘串行化：并发写同一文件会乱序丢进度
      let commitTail: Promise<void> = Promise.resolve();
      const commit = () => {
        commitTail = commitTail.then(() => ctx.onCheckpoint?.(ctx.checkpoint));
      };
      await runWithConcurrency(llmJobs, MAX_PARALLEL, async ({ index: i, seconds, dest, framePath }) => {
        // 预算耗尽：不再发起新的生成（在途的会跑完），直接让 COMPOSE 使用已有片段。
        if (Date.now() - generateStartedAt > GENERATE_BUDGET_MS) {
          log.warn('generate budget exhausted; skipping remaining shots', {
            index: i,
            budgetSeconds: GENERATE_BUDGET_MS / 1000,
          });
          return;
        }
        // 参考帧作为图生视频首帧：优先上传到控制面 R2 拿公开直链（Agnes 图生视频 ti2vid）。
        // 本地/常驻形态 store.put 返回 memory:// 或 file:// 时不上传，直接 fallback 纯文生。
        let imageUrl: string | undefined;
        if (framePath) {
          try {
            const remote = await ctx.store.put(
              `tasks/${ctx.taskId}/frames/shot-${pad(i)}.jpg`,
              await readFile(framePath),
              'image/jpeg',
            );
            imageUrl = /^https?:\/\//i.test(remote) ? remote : undefined;
            if (!imageUrl) {
              // GHA 内 FS store 返回 file://，改用 callback/artifact 上传到控制面 R2 拿直链
              imageUrl = (await uploadFrameToR2(framePath, i)) ?? undefined;
            }
          } catch (err) {
            // 帧上传失败不影响该镜生成（降级纯文生），不抛未捕获异常
            log.warn('frame upload failed; fall back to text-to-video', {
              index: i,
              framePath,
              err: String(err).slice(0, 200),
            });
            imageUrl = undefined;
          }
        }

        // 简单重试：单片段失败最多重试 SHOT_RETRIES 次；仍失败则跳过该片段（不抛错）。
        let lastErr: unknown;
        let ok = false;
        for (let attempt = 0; attempt <= SHOT_RETRIES; attempt += 1) {
          try {
            const result = await ctx.providers.agnesVideo.generate({
              prompt: shotPromptFor(ctx.brief, art.scriptShots?.[i], analysis, i, imageUrl ? '<Picture 1> 保持该参考图的人物与美术风格一致。' : undefined),
              seconds,
              resolution: ctx.outputResolution,
              ...(imageUrl ? { referenceImages: [imageUrl] } : {}),
            });
            await downloadFile(result.videoUrl, dest);
            art.clipPaths[i] = dest;
            ctx.checkpoint.remoteTasks[`shot-${i}`] = result.taskId;
            ctx.checkpoint.completedShots.push(i);
            commit();
            log.info('shot generated', { index: i, seconds, remoteTaskId: result.taskId, attempt });
            ok = true;
            break;
          } catch (err) {
            lastErr = err;
            log.warn('shot generate failed; retrying', { index: i, attempt, shots: String(err).slice(0, 200) });
            if (attempt < SHOT_RETRIES) {
              await new Promise((res) => setTimeout(res, 15_000 * (attempt + 1)));
            }
          }
        }
        if (!ok) {
          // 跳过失败片段：不加入 clipPaths，合成时自然缺位；不抛错保证其余片段继续
          log.warn('shot skipped after retries', { index: i, shots: String(lastErr).slice(0, 300) });
        }
      });
      await commitTail;
    }
  }

  /**
   * code 模式主路径：用 hypit 官方模板一次渲染完整视频。
   * 返回 true 表示成功（outputs/final.mp4 已就位）；false 表示降级到 ffmpeg。
   */
  private async renderCodeWithHypit(
    ctx: PipelineContext,
    dirs: PipelineDirs,
    art: Artifacts,
    durations: number[],
  ): Promise<boolean> {
    if (!(await ctx.kernel.available())) return false;
    try {
      // 组装渲染内容：每镜 标题（scriptShots/analysis/brief）+ 副标题（旁白）
      const shots: RenderShot[] = durations.map((_, i) => {
        const scriptShot = art.scriptShots?.[i];
        const analysisShot = analysisOf(art, i);
        const title = scriptShot?.description || analysisShot?.description || ctx.brief || `第 ${i + 1} 个镜头`;
        const subtitle = scriptShot?.onScreenText || analysisShot?.onScreenText;
        return { title, ...(subtitle ? { subtitle } : {}) };
      });
      const finalPath = join(dirs.outputs, 'final.mp4');
      const result = await renderHypitTask({
        workDir: dirs.work,
        shots,
        secondsPerShot: durations,
        videoKey: `tasks/${ctx.taskId}/final.mp4`,
        kernel: ctx.kernel,
        store: ctx.store,
      });
      // 供 COMPOSE 直接复用
      art.finalPath = result.finalPath;
      art.clipPaths = [];
      // 标记所有分镜完成，避免外层循环再走逐镜生成
      for (let i = 0; i < durations.length; i += 1) {
        if (!ctx.checkpoint.completedShots.includes(i)) ctx.checkpoint.completedShots.push(i);
      }
      ctx.onCheckpoint?.(ctx.checkpoint);
      log.info('hypit render completed', { taskId: ctx.taskId, buildId: result.buildId, finalPath });
      return true;
    } catch (err) {
      log.warn('hypit render failed; will fall back to ffmpeg', { taskId: ctx.taskId, err: String(err).slice(0, 500) });
      return false;
    }
  }

  /* ---------------- 阶段 6：COMPOSE 合成 ---------------- */

  private async compose(ctx: PipelineContext, dirs: PipelineDirs, art: Artifacts): Promise<string | undefined> {
    // hypit 渲染路径：GENERATE_SHOTS 已产出完整 final.mp4，直接上传
    if (art.finalPath && (await fileExists(art.finalPath))) {
      log.info('compose reuse hypit final', { finalPath: art.finalPath });
      const key = `tasks/${ctx.taskId}/final.mp4`;
      try {
        const url = await ctx.store.put(key, await readFile(art.finalPath), 'video/mp4');
        log.info('final uploaded', { key, url, resolution: ctx.outputResolution });
      } catch (err) {
        log.error('upload final failed; video kept on disk', { finalPath: art.finalPath, err: String(err) });
      }
      return key;
    }
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

/** 取参考视频分析里第 i 个镜头（undefined 安全）。 */
function analysisOf(art: Artifacts, i: number): { description: string; onScreenText?: string } | undefined {
  return art.analysis?.shots[i];
}

/** 数组去重（保序）。 */
function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** 整数钳制到 [lo, hi]。 */
function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}

/**
 * 受控并发执行：最多 `limit` 个 worker 同时处理 items。
 * 每个 worker 独立从队列取任务；配合账户池每账户 max_concurrent=1，
 * 保证同时最多占用 limit 个不同账户（ABCD 而非 AACD）。
 */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(workers);
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

/**
 * 组装单镜生成 prompt。优先用 LLM 展开的脚本分镜（scriptShots，自由创作场景），
 * 其次参考视频分析（复刻场景），并带上主题 brief，确保生成内容与需求相关。
 */
function shotPromptFor(
  brief: string | undefined,
  scriptShot: { description: string; onScreenText?: string } | undefined,
  analysis: VideoAnalysis | undefined,
  i: number,
  extraDirective?: string,
): string {
  const parts: string[] = [];
  if (brief) parts.push(`视频主题：${brief}`);
  if (scriptShot) {
    parts.push(`第 ${i + 1} 个镜头：${scriptShot.description}`);
    if (scriptShot.onScreenText) parts.push(`旁白/屏上字幕：${scriptShot.onScreenText}`);
  } else {
    const s = analysis?.shots[i];
    if (s) {
      parts.push(`镜头 ${s.index}（${s.startSec}s–${s.endSec}s）：${s.description}`);
      if (s.onScreenText) parts.push(`屏上文字：${s.onScreenText}`);
      if (s.effects && s.effects.length > 0) parts.push(`特效：${s.effects.join('、')}`);
    } else {
      parts.push(`第 ${i + 1} 个镜头。`);
    }
  }
  if (extraDirective) parts.push(extraDirective);
  return parts.join('\n');
}

/**
 * 从 SVML 脚本里提取逐镜头文字，供 code 模式确定性渲染：
 * 依次匹配每个 @moment 块中的 @cue 旁白 与 @visual 画面描述，映射到该分镜。
 *
 * SVML 契约示例：
 *   @moment 0s 3s
 *     @cue narrator: 旁白文字
 *     @visual 描述该镜头画面
 *
 * 说明：这是轻量解析，模型输出可能不严格遵循语法——找不到就逐行兜底，
 * 保证 brief 展开后的文字内容不会被丢弃（这正是用户命题需要 LLM 扩充的部分）。
 */
export function parseScriptShots(svml: string): Array<{ description: string; onScreenText?: string }> {
  const shots: Array<{ description: string; onScreenText?: string }> = [];
  const lines = svml.split('\n');
  let desc = '';
  let onScreen = '';
  let cue: string | undefined;

  const flush = () => {
    if (desc || onScreen || cue) {
      // @visual 是画面描述（作主文字），@cue 是旁白台词（作屏上文字）。
      // 若 @visual 缺失则用旁白当主文字，保证非空。
      const d = desc.trim() || (cue ? cue.trim() : '');
      const o = cue && desc ? cue.trim() : onScreen.trim();
      if (d || o) shots.push({ description: d || '（本镜画面）', ...(o ? { onScreenText: o } : {}) });
      desc = '';
      onScreen = '';
      cue = undefined;
    }
  };

  let inMoment = false;
  let sawVisual = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('@moment')) {
      inMoment = true;
      sawVisual = false;
      flush();
      continue;
    }
    if (!inMoment) continue;
    if (line.startsWith('@visual')) {
      // 同一 moment 内出现第二个 @visual 才视为下一镜；否则它是本镜的画面描述
      if (sawVisual) flush();
      sawVisual = true;
      desc = line.replace(/^@visual\s*/, '').trim();
      continue;
    }
    if (line.startsWith('@cue')) {
      // @cue narrator: 旁白文字（合并进当前分镜，作为屏上文字）
      const m = line.match(/^@cue\s*[^:]*:\s*(.+)$/);
      cue = m?.[1] ?? line.replace(/^@cue\s*/, '');
      continue;
    }
    // 其他行（台词正文、注释等）忽略
  }
  flush();
  return shots;
}
