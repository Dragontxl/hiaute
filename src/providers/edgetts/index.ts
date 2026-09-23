/**
 * EdgeTTS Provider（依 V2 §3：为无语音视频配音，免费）
 *
 * EdgeTTS 无需密钥（走微软在线语音合成）。这里以下调外部 `edge-tts` CLI 或
 * 纯 HTTP 方式实现；为保持零依赖，本实现将文本写入临时文件并调用 `edge-tts`。
 *
 * 注意：EdgeTTS 不进入账户池（无密钥），但仍走统一的失败重试。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../core/logger.js';
import type { Provider } from '../types.js';
import type { ProviderCapabilities } from '../../types/index.js';

const run = promisify(execFile);

export interface TtsInput {
  text: string;
  voice?: string; // 如 zh-CN-XiaoxiaoNeural
  rate?: string; // 如 +0%
}

export class EdgeTtsProvider implements Provider {
  readonly name = 'provider-edgetts';
  readonly capabilities: ProviderCapabilities = {
    apiType: 'edgetts',
    models: ['edge-tts'],
  };

  /** 合成语音，返回 mp3 字节。 */
  async synthesize(input: TtsInput): Promise<Uint8Array> {
    const dir = await mkdtemp(join(tmpdir(), 'edgetts-'));
    const textFile = join(dir, 'text.txt');
    const outFile = join(dir, 'out.mp3');
    try {
      await writeFile(textFile, input.text, 'utf8');
      await run('edge-tts', [
        '--file', textFile,
        '--voice', input.voice ?? 'zh-CN-XiaoxiaoNeural',
        '--rate', input.rate ?? '+0%',
        '--write-media', outFile,
      ]);
      const bytes = await readFile(outFile);
      log.info('edgetts synthesized', { bytes: bytes.length, voice: input.voice });
      return bytes;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
