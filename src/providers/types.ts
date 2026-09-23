/**
 * Provider 契约（依 V2 §2 / §3）
 *
 * 每个 Provider 把真实服务的 API 映射为 hypit 的 Model 能力。
 * 关键原则：能力如实上报（supports），不足则带原因拒绝；绝不偷偷改共享 Model。
 */
import type { ProviderCapabilities } from '../types/index.js';

export interface Provider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** 取一次账户并执行，内部复用 withAccountFailover。 */
}

export interface TextGenerateInput {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ImageGenerateInput {
  prompt: string;
  /** 输出边长或档位。 */
  resolution?: '1K' | '2K' | '4K';
  aspectRatio?: string;
}

export interface VideoGenerateInput {
  prompt: string;
  /** 参考图（图生视频）。 */
  imageUrl?: string;
  /** 单条时长（秒）——不得超 capabilities.maxSecondsPerShot。 */
  seconds: number;
  resolution: '480p' | '720p' | '1080p';
  fps?: number;
}

export interface VideoGenerateResult {
  taskId: string;
  videoUrl: string;
  seconds: number;
  size?: string;
}

/** OpenAI 兼容的 chat/completions 消息格式。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 统一的 HTTP JSON 请求封装（带超时）。 */
export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = 120_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 60_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
