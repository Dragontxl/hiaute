/**
 * Agnes Provider（依 V2 §3 / §3.1 / §5，按 Agnes 真实 API 重写）
 *
 * 覆盖三类能力（base_url = https://apihub.agnes-ai.com/v1）：
 *  - agnes-text   : OpenAI 兼容 /chat/completions，模型 agnes-3.0-flash
 *  - agnes-image  : /images/generations（同步返回 data[0].url），模型 agnes-image-2.5-flash
 *  - agnes-video  : /videos 创建 + /agnesapi 轮询，模型 agnes-video-2.5-flash
 *
 * ⚠️ 两代视频模型的接口不同，时长控制方式尤其关键：
 *  - 2.5 系列（推荐，v2.0 将于 2026-09-25 下线）：`seconds`（字符串 "4"–"12"）、
 *    `size:"720P"`、`aspect_ratio`、`mode: text|keyframe|reference`、keyframe 用 `first_frame`。
 *  - v2.0（即将下线）：**没有 seconds**，时长由 `num_frames`(8n+1, ≤441) / `frame_rate` 决定
 *    （`seconds = num_frames / frame_rate`，默认 121/24≈5.04s）；`mode: ti2vid|keyframes`；
 *    单图用 `image`，多关键帧用 `extra_body.image[]`。
 *
 * 轮询：GET {origin}/agnesapi?video_id=<id>&model_name=<model>，完成取 url
 * （v2.0 兼容旧版返回 `metadata.url`，故两者都读）。
 */
import type { AccountPool } from '../../core/accountPool.js';
import { withAccountFailover } from '../../core/retry.js';
import { log } from '../../core/logger.js';
import { postJson, getJson } from '../types.js';
import type { Provider, TextGenerateInput, ImageGenerateInput, VideoGenerateInput, VideoGenerateResult, ChatMessage } from '../types.js';
import type { ProviderCapabilities } from '../../types/index.js';

/** Agnes Video 单条时长上限（秒）。2.5-flash 上限 12；v2.0 可达 18（441/24）。保守取 12。 */
const OFFICIAL_MAX_SECONDS_PER_SHOT = 12;
const VIDEO_FPS = 24;
const V20_MAX_FRAMES = 441; // v2.0 上限，且必须 8n+1

/**
 * 按目标秒数求 v2.0 的合法帧数：必须是 8n+1 且 ≤ 441（最接近目标）。
 * 例：10s@24fps → desired 240 → n=30 → 241 帧（10.04s）。
 */
export function framesFor(seconds: number, fps = VIDEO_FPS, cap = V20_MAX_FRAMES): number {
  const desired = Math.max(1, Math.round(seconds * fps));
  let n = Math.round((desired - 1) / 8);
  if (n < 0) n = 0;
  if (8 * n + 1 > cap) n = Math.floor((cap - 1) / 8);
  return 8 * n + 1;
}

/** 按模型家族选择正确 mode 枚举。 */
function modeFor(model: string, useKeyframe: boolean): string {
  const is25 = model.includes('2.5');
  if (useKeyframe) return is25 ? 'keyframe' : 'keyframes';
  return is25 ? 'text' : 'ti2vid';
}

/**
 * 组装创建任务 body —— 两代模型字段不同，这里集中处理，避免把 2.5 的字段误发给 v2.0
 * （v2.0 忽略 seconds → 回落默认 121 帧 = 5.04s，这就是片长不一致的根因）。
 */
export function buildVideoBody(model: string, input: VideoGenerateInput): Record<string, unknown> {
  const is25 = model.includes('2.5');
  const useKeyframe = Boolean(input.imageUrl);
  const base: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    mode: modeFor(model, useKeyframe),
  };
  if (is25) {
    return {
      ...base,
      seconds: String(input.seconds),
      size: '720P',
      aspect_ratio: '16:9',
      ...(useKeyframe ? { first_frame: input.imageUrl } : {}),
    };
  }
  // v2.0：时长由 num_frames / frame_rate 决定；单图走 image
  return {
    ...base,
    frame_rate: VIDEO_FPS,
    num_frames: framesFor(input.seconds, VIDEO_FPS),
    width: 1152,
    height: 768,
    ...(useKeyframe ? { image: input.imageUrl } : {}),
  };
}

export class AgnesTextProvider implements Provider {
  readonly name = 'provider-agnes-text';
  readonly capabilities: ProviderCapabilities = {
    apiType: 'agnes-text',
    models: ['agnes-3.0-flash'],
    structuredOutput: true,
  };

  constructor(private pool: AccountPool) {}

  async generate(input: TextGenerateInput): Promise<string> {
    const messages: ChatMessage[] = [];
    if (input.system) messages.push({ role: 'system', content: input.system });
    messages.push({ role: 'user', content: input.prompt });

    return withAccountFailover(
      this.pool,
      'agnes-text',
      async ({ apiKey, baseUrl, modelName }) => {
        const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
        const res = await postJson<{ choices: Array<{ message: { content: string } }> }>(
          url,
          {
            model: modelName ?? 'agnes-3.0-flash',
            messages,
            max_tokens: input.maxTokens ?? 8192,
            temperature: input.temperature ?? 0.4,
          },
          { authorization: `Bearer ${apiKey}` },
        );
        const content = res.choices?.[0]?.message?.content;
        if (!content) throw new Error('agnes-text: empty completion');
        return content;
      },
      // 文本生成偶发变慢/挂起：收紧重试（3 轮、15s 起），避免长跑
      { maxRounds: 3, baseMs: 15_000, capMs: 120_000 },
    );
  }
}

export class AgnesImageProvider implements Provider {
  readonly name = 'provider-agnes-image';
  readonly capabilities: ProviderCapabilities = {
    apiType: 'agnes-image',
    models: ['agnes-image-2.5-flash'],
  };

  constructor(private pool: AccountPool) {}

  /** 文生图/图生图，同步返回图片 URL。 */
  async generate(input: ImageGenerateInput): Promise<string> {
    return withAccountFailover(this.pool, 'agnes-image', async ({ apiKey, baseUrl, modelName }) => {
      const base = baseUrl.replace(/\/$/, '');
      const res = await postJson<{ data?: Array<{ url?: string; b64_json?: string }> }>(
        `${base}/images/generations`,
        {
          model: modelName ?? 'agnes-image-2.5-flash',
          prompt: input.prompt,
          size: input.resolution ?? '1K',
          ...(input.aspectRatio ? { ratio: input.aspectRatio } : {}),
          extra_body: { response_format: 'url' },
        },
        { authorization: `Bearer ${apiKey}` },
      );
      const url = res.data?.[0]?.url;
      if (!url) throw new Error('agnes-image: no url in response');
      return url;
    });
  }
}

export class AgnesVideoProvider implements Provider {
  readonly name = 'provider-agnes-video';
  readonly capabilities: ProviderCapabilities = {
    apiType: 'agnes-video',
    models: ['agnes-video-2.5-flash', 'agnes-video-2.5', 'agnes-video-v2.0'],
    resolutions: ['720p'],
    maxSecondsPerShot: OFFICIAL_MAX_SECONDS_PER_SHOT,
    nativeAudio: true,
  };

  constructor(private pool: AccountPool) {}

  async generate(input: VideoGenerateInput): Promise<VideoGenerateResult> {
    // 防御：不得超过上限（12s，2.5-flash 与 v2.0 都满足）。调用方传更大值带原因拒绝。
    if (input.seconds > OFFICIAL_MAX_SECONDS_PER_SHOT) {
      throw new Error(
        `agnes-video: requested ${input.seconds}s exceeds cap ${OFFICIAL_MAX_SECONDS_PER_SHOT}s. ` +
          '请调小 maxShots 或 maxDurationSeconds。',
      );
    }
    if (input.resolution && input.resolution !== '720p') {
      log.warn('agnes-video: 2.5 Flash 仅支持 720P，强制 size=720P', { requested: input.resolution });
    }

    return withAccountFailover(this.pool, 'agnes-video', async ({ apiKey, baseUrl, modelName }) => {
      const base = baseUrl.replace(/\/$/, '');
      const origin = new URL(base).origin; // 轮询端点 /agnesapi 在 origin 下，不在 /v1 下
      const model = modelName ?? 'agnes-video-2.5-flash';
      const body = buildVideoBody(model, input);

      const submit = await postJson<{ video_id?: string; task_id?: string; id?: string }>(
        `${base}/videos`,
        body,
        { authorization: `Bearer ${apiKey}` },
      );
      const videoId = submit.video_id ?? submit.task_id ?? submit.id;
      if (!videoId) throw new Error('agnes-video: 创建任务未返回 video_id');
      log.info('agnes-video submitted', {
        videoId,
        model,
        mode: body.mode,
        seconds: input.seconds,
        numFrames: body.num_frames,
      });

      return await this.pollVideo(origin, apiKey, videoId, model, input.seconds);
    });
  }

  /**
   * 轮询 GET {origin}/agnesapi?video_id=<id>&model_name=<model>，完成取顶层 url。
   *
   * 注意：轮询本身也有配额（"too many video status queries" 429）。轮询期间的
   * 429/网络抖动**必须在本方法内消化**——若向上抛出，会被 withAccountFailover 当成
   * 「本次调用失败」而**重新提交一个新视频任务**，既浪费配额又产生重复任务。
   */
  private async pollVideo(
    origin: string,
    apiKey: string,
    videoId: string,
    model: string,
    seconds: number,
  ): Promise<VideoGenerateResult> {
    const deadline = Date.now() + 20 * 60_000;
    const query = `video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(model)}`;
    while (Date.now() < deadline) {
      let r: { status?: string; url?: string; metadata?: { url?: string }; progress?: number; error?: unknown };
      try {
        r = await getJson<{ status?: string; url?: string; metadata?: { url?: string }; progress?: number; error?: unknown }>(
          `${origin}/agnesapi?${query}`,
          { authorization: `Bearer ${apiKey}` },
        );
      } catch (err) {
        // 轮询被限流/抖动：不重提任务，稍后继续查同一个 video_id
        log.warn('agnes-video poll transient error; keep polling same task', {
          videoId,
          err: String(err).slice(0, 200),
        });
        await new Promise((res) => setTimeout(res, 15_000));
        continue;
      }
      // 2.5 系列返回顶层 url；v2.0 兼容旧版返回 metadata.url —— 两者都读
      const url = r.url ?? r.metadata?.url;
      if (r.status === 'completed' && url) {
        return { taskId: videoId, videoUrl: url, seconds };
      }
      if (r.status === 'failed') {
        throw new Error(`agnes-video: 任务失败 videoId=${videoId} error=${String(r.error)}`);
      }
      log.debug('agnes-video polling', { videoId, status: r.status, progress: r.progress });
      // 间隔放宽到 10s，避免触发「too many video status queries」限流
      await new Promise((res) => setTimeout(res, 10_000));
    }
    throw new Error(`agnes-video: 轮询超时 videoId=${videoId}`);
  }
}
