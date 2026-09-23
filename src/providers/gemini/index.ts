/**
 * Gemini Provider（视频理解）
 *
 * 兼容两种 key 格式（AIza... 老格式 / AQ.Ab8R... 新格式），统一走 `x-goog-api-key` 请求头，
 * 不把 key 拼进 URL，避免日志/URL 泄露。
 *
 * 视频传输：≤20MB 的参考视频直接 `inlineData`（base64）内联进 generateContent，
 * 无需 File API 上传 + 轮询（参考视频来源先被下载成文件，再 base64）。
 * 结构化输出：responseMimeType=application/json + responseSchema 强制 JSON。
 *
 * 免费层约束：15 RPM / 1500 RPD；输入可能被用于改进模型 → 涉密素材不要传。
 */
import type { AccountPool } from '../../core/accountPool.js';
import { withAccountFailover } from '../../core/retry.js';
import { log } from '../../core/logger.js';
import type { Provider } from '../types.js';
import type { ProviderCapabilities, VideoAnalysis } from '../../types/index.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** inline 传输的内存上限（Google 约 20MB，留余量）。 */
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

/** ANALYSIS.md / TIMELINE.md 字段的 schema 映射（§4）。 */
export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          startSec: { type: 'number' },
          endSec: { type: 'number' },
          description: { type: 'string' },
          onScreenText: { type: 'string' },
          effects: { type: 'array', items: { type: 'string' } },
        },
        required: ['index', 'startSec', 'endSec', 'description'],
      },
    },
    speakers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, role: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  required: ['summary', 'shots'],
} as const;

export class GeminiProvider implements Provider {
  readonly name = 'provider-gemini';
  readonly capabilities: ProviderCapabilities = {
    apiType: 'gemini',
    models: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'],
    structuredOutput: true,
  };

  constructor(private pool: AccountPool) {}

  /**
   * 分析参考视频。bytes 直接内联上传；无法内联（超限）时抛错，由调用方决定降级。
   */
  async analyzeReference(input: {
    bytes?: Uint8Array;
    mimeType?: string;
    prompt: string;
    model?: string;
  }): Promise<VideoAnalysis> {
    // Gemini 免费层每天仅 ~20 次：收紧重试（4 轮、15s 起），避免 503 过载时空转烧额度
    return withAccountFailover(
      this.pool,
      'gemini',
      async ({ apiKey, baseUrl, modelName }) => {
        const base = (baseUrl || DEFAULT_BASE).replace(/\/$/, '');
        const model = modelName ?? input.model ?? 'gemini-3.5-flash';
        const url = `${base}/models/${model}:generateContent`;

        const parts: GeminiPart[] = [{ text: input.prompt }];
        if (input.bytes && input.bytes.byteLength > 0) {
          if (input.bytes.byteLength > MAX_INLINE_BYTES) {
            throw new Error(
              `gemini: reference ${input.bytes.byteLength} bytes exceeds inline limit ${MAX_INLINE_BYTES}; ` +
                '请压缩/裁剪参考视频，或改用 File API（未实现）',
            );
          }
          parts.push({
            inlineData: { mimeType: input.mimeType ?? 'video/mp4', data: Buffer.from(input.bytes).toString('base64') },
          });
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: ANALYSIS_SCHEMA,
              temperature: 0.2,
            },
          }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${detail.slice(0, 500)}`);
        }
        const json = (await res.json()) as GeminiResponse;
        const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        if (!text) throw new Error('gemini: empty analysis');
        const parsed = JSON.parse(text) as VideoAnalysis;
        if (!Array.isArray(parsed.shots)) throw new Error('gemini: analysis missing shots array');
        log.info('gemini analysis ok', { model, shots: parsed.shots.length });
        return parsed;
      },
      { maxRounds: 4, baseMs: 15_000, capMs: 120_000 },
    );
  }
}