/**
 * R2 对象存储（产物二进制：视频 / 图片 / 音频）。
 *
 * 与 KV / D1 无关——大对象应走 R2。公开访问用 R2_PUBLIC_URL 前缀拼接。
 */
import type { R2Bucket } from './bindings.js';
import type { ObjectStore } from '../types.js';

export class R2ObjectStore implements ObjectStore {
  constructor(private bucket: R2Bucket, private publicUrl?: string) {}

  async put(key: string, body: ArrayBuffer | Uint8Array | string, contentType?: string): Promise<string> {
    await this.bucket.put(key, body, contentType ? { httpMetadata: { contentType } } : undefined);
    return this.getUrl(key);
  }

  getUrl(key: string): string {
    if (!this.publicUrl) return `r2://${key}`;
    return `${this.publicUrl.replace(/\/$/, '')}/${key}`;
  }

  async delete(prefixOrKey: string): Promise<void> {
    const listed = await this.bucket.list({ prefix: prefixOrKey });
    const keys = (listed.objects ?? []).map((o) => o.key);
    if (keys.length > 0) await this.bucket.delete(keys);
  }
}
