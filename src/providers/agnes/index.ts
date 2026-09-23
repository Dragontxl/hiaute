/**
 * Agnes Provider（依 V2 §3 / §3.1 / §5，按 Agnes 真实 API 重写）
 *
 * 覆盖三类能力（base_url = https://apihub.agnes-ai.com/v1）：
 *  - agnes-text   : OpenAI 兼容 /chat/completions，模型 agnes-3.0-flash
 *  - agnes-image  : /images/generations（同步返回 data[0].url），模型 agnes-image-2.5-flash
 *  - agnes-video  : /videos 创建 + /agnesapi 轮询（注意：不在 /v1 下），模型 agnes-video-2.5-flash
 *
 * Agnes Video 2.5 Flash 关键约束（实测文档）：
 *  - seconds 为字符串 "4"–"12"（Flash 上限 12，非 18）
 *  - size 固定 "720P"（大写）
 *  - mode 必填：text / keyframe / reference
 *  - 图生视频用 first_frame（keyframe 模式），不是 image_url
 *  - 轮询：GET {origin}/agnesapi?video_id=<id>&model_name=<model>，完成取顶层 url
 */
import type { AccountPool } from '../../core/accountPool.js';
import { withAccountFailover } from '../../core/retry.js';
import { log } from '../../core/logger.js';
import { postJson, getJson } from '../types.js';
import type { Provider, TextGenerateInput, ImageGenerateInput, VideoGenerateInput, VideoGenerateResult, ChatMessage } from '../types.js';
import type { ProviderCapabilities } from '../../types/index.js';

/** Agnes Video 2.5 Flash 的单条时长上限（秒）。 */
const OFFICIAL_MAX_SECONDS_PER_SHOT = 12;

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

    return withAccountFailover(this.pool, 'agnes-text', async ({ apiKey, baseUrl, modelName }) => {
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
    });
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
    models: ['agnes-video-2.5-flash'],
    resolutions: ['720p'],
    maxSecondsPerShot: OFFICIAL_MAX_SECONDS_PER_SHOT,
    nativeAudio: true,
  };

  constructor(private pool: AccountPool) {}

  async generate(input: VideoGenerateInput): Promise<VideoGenerateResult> {
    // 防御：不得超过 Flash 上限（12s）。调用方传更大值带原因拒绝。
    if (input.seconds > OFFICIAL_MAX_SECONDS_PER_SHOT) {
      throw new Error(
        `agnes-video: requested ${input.seconds}s exceeds Flash cap ${OFFICIAL_MAX_SECONDS_PER_SHOT}s. ` +
          'Agnes Video 2.5 Flash 单条上限 12 秒；请调小 maxShots 或 maxDurationSeconds。',
      );
    }
    if (input.resolution && input.resolution !== '720p') {
      log.warn('agnes-video: Flash 仅支持 720P，强制 size=720P', { requested: input.resolution });
    }

    return withAccountFailover(this.pool, 'agnes-video', async ({ apiKey, baseUrl, modelName }) => {
      const base = baseUrl.replace(/\/$/, '');
      const origin = new URL(base).origin; // 轮询端点 /agnesapi 在 origin 下，不在 /v1 下
      const model = modelName ?? 'agnes-video-2.5-flash';
      const useKeyframe = Boolean(input.imageUrl);

      const submit = await postJson<{ video_id?: string; task_id?: string; id?: string }>(
        `${base}/videos`,
        {
          model,
          prompt: input.prompt,
          mode: useKeyframe ? 'keyframe' : 'text',
          seconds: String(input.seconds),
          size: '720P',
          aspect_ratio: '16:9',
          ...(useKeyframe ? { first_frame: input.imageUrl } : {}),
        },
        { authorization: `Bearer ${apiKey}` },
      );
      const videoId = submit.video_id ?? submit.task_id ?? submit.id;
      if (!videoId) throw new Error('agnes-video: 创建任务未返回 video_id');
      log.info('agnes-video submitted', { videoId, model, mode: useKeyframe ? 'keyframe' : 'text', seconds: input.seconds });

      return await this.pollVideo(origin, apiKey, videoId, model, input.seconds);
    });
  }

  /** 轮询 GET {origin}/agnesapi?video_id=<id>&model_name=<model>，完成取顶层 url。 */
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
      const r = await getJson<{
        status?: string;
        url?: string;
        progress?: number;
        error?: unknown;
      }>(`${origin}/agnesapi?${query}`, { authorization: `Bearer ${apiKey}` });
      if (r.status === 'completed' && r.url) {
        return { taskId: videoId, videoUrl: r.url, seconds };
      }
      if (r.status === 'failed') {
        throw new Error(`agnes-video: 任务失败 videoId=${videoId} error=${String(r.error)}`);
      }
      log.debug('agnes-video polling', { videoId, status: r.status, progress: r.progress });
      await new Promise((res) => setTimeout(res, 4000));
    }
    throw new Error(`agnes-video: 轮询超时 videoId=${videoId}`);
  }
}
