/**
 * LLM 规划器（依 V2 §2 / §5）
 *
 * 职责：替代 Coding Agent，理解需求 → 产出 .svml / .svrun 脚本。
 *  - 脚本编写（纯文本、不需视觉）由 Agnes 文本模型承担（§5），以省 Gemini 额度。
 *  - 视觉理解由 Gemini 承担（见 pipeline/analyze）。
 *  - 提示词内附 SVML 契约示例 + few-shot；产出后用 `hypit check/plan` 校验（kernel 层）。
 */
import type { ProviderRegistry } from '../providers/registry.js';
import type { VideoAnalysis } from '../types/index.js';
import { log } from '../core/logger.js';

/** SVML 契约最小示例（few-shot 锚点）。真实契约见 hypit docs/zh/quickstart/script.md。 */
const SVML_CONTRACT_HINT = `
SVML 是 hypit 的场景脚本（Scene Markup）。最小骨架示例：

  # role: narrator
  # role: character_a

  @moment 0s 3s
    @cue narrator: 旁白文字
    @visual 描述该镜头画面
    @transition fade

要点：
- 用 @moment 标记时间区间；用 @cue 关联说话人台词。
- 保留参考视频的时间轴节奏与镜头切分。
- 只输出 SVML 正文，不要解释。
`.trim();

export interface PlanRequest {
  /** 用户需求文本。 */
  brief: string;
  /** 参考视频分析结果（可选；有则可对齐时间轴）。 */
  analysis?: VideoAnalysis;
  /** 目标总时长（秒），应 <= maxDurationSeconds。 */
  targetSeconds: number;
}

export class Planner {
  constructor(private providers: ProviderRegistry) {}

  /** 产出 SVML 脚本文本。 */
  async writeScript(req: PlanRequest): Promise<string> {
    const analysisBlock = req.analysis
      ? `参考视频分析（请据此对齐镜头与时长）：\n${JSON.stringify(req.analysis, null, 2)}`
      : '（无参考视频，按需求自由创作。）';

    const system = [
      '你是 hypit 的脚本作者，负责把需求转写成符合 SVML 契约的脚本。',
      SVML_CONTRACT_HINT,
    ].join('\n\n');

    const prompt = [
      `需求：${req.brief}`,
      `目标总时长：约 ${req.targetSeconds} 秒（不得超过）。`,
      analysisBlock,
      '请只输出 SVML 正文。',
    ].join('\n\n');

    log.info('planner.writeScript start', { targetSeconds: req.targetSeconds });
    const svml = await this.providers.agnesText.generate({
      system,
      prompt,
      maxTokens: 8192,
      temperature: 0.4,
    });
    return stripCodeFence(svml);
  }
}

export interface PlanShotDurationsOptions {
  /** 分镜条数上限（成本控制，默认 10）。 */
  maxShots?: number;
}

/**
 * 分配各分镜时长，满足三条硬约束：
 *  1. 总和 === targetSeconds（不静默丢失目标时长）；
 *  2. 每条 <= officialCap（Agnes 官方保守上限，§3.1）；
 *  3. 每条 >= 1s。
 *
 * 策略：优先按参考视频的镜头时长做权重分配，尽量对齐原片节奏；
 * 若权重分配无法满足上述约束（分镜过少导致单条超 cap），退化为等分——
 * 分镜数取 max(ceil(target/cap), min(maxShots, 参考分镜数))，从而保证单条不超 cap。
 */
export function planShotDurations(
  analysis: VideoAnalysis | undefined,
  targetSeconds: number,
  officialCap: number,
  opts: PlanShotDurationsOptions = {},
): number[] {
  const target = Math.max(1, Math.round(targetSeconds));
  const cap = Math.max(1, Math.round(officialCap));
  const maxShots = Math.max(1, Math.floor(opts.maxShots ?? 10));
  const shots = analysis?.shots ?? [];
  const minShots = Math.ceil(target / cap);

  if (shots.length > 0 && shots.length <= maxShots) {
    const weights = shots.map((s) => Math.max(0.5, (Number(s.endSec) || 0) - (Number(s.startSec) || 0)));
    const d = largestRemainder(target, weights);
    if (d.every((v) => v >= 1 && v <= cap)) return d;
  }

  if (shots.length > maxShots) {
    log.warn('analysis has more shots than maxShots; merging by equal split', {
      analysisShots: shots.length,
      maxShots,
    });
  }
  const count = clamp(Math.max(minShots, Math.min(maxShots, shots.length)), 1, target);
  return largestRemainder(target, Array.from({ length: count }, () => 1));
}

/** 按权重把 total 秒拆成整数数组，总和严格等于 total（最大余数法）。 */
export function largestRemainder(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const w = weights.map((v) => Math.max(0, v));
  const sum = w.reduce((s, v) => s + v, 0) || n;
  const exact = w.map((v) => (total * v) / sum);
  const out = exact.map((v) => Math.floor(v));
  const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  let rest = total - out.reduce((s, v) => s + v, 0);
  let k = 0;
  while (rest > 0) {
    const idx = order[k % order.length]!.i;
    out[idx] = (out[idx] ?? 0) + 1;
    rest -= 1;
    k += 1;
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 去除模型可能包裹的 ``` 代码围栏。 */
function stripCodeFence(text: string): string {
  const fence = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return (fence?.[1] ?? text).trim();
}
