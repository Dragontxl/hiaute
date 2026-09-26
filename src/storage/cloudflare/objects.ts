/**
 * R2 对象存储（产物二进制：视频 / 图片 / 音频）。
 *
 * 与 KV / D1 无关——大对象应走 R2。公开访问用 R2_PUBLIC_URL 前缀拼接。
 */
import type { R2Bucket, R2Object, R2ObjectBody } from './bindings.js';
import type { ListOptions, ListResult, ObjectBody, ObjectMeta, ObjectStore } from '../types.js';

/** R2 对象元数据 → 统一 ObjectMeta。 */
function toMeta(obj: R2Object): ObjectMeta {
  return {
    key: obj.key,
    size: obj.size ?? 0,
    lastModified: obj.lastModified ? obj.lastModified.toISOString() : new Date(0).toISOString(),
    ...(obj.httpMetadata?.contentType ? { contentType: obj.httpMetadata.contentType } : {}),
    ...(obj.etag ? { etag: obj.etag } : {}),
  };
}

/** R2 对象本体 → 统一 ObjectBody。 */
function toBody(obj: R2ObjectBody): ObjectBody {
  return {
    ...toMeta(obj),
    arrayBuffer: () => obj.arrayBuffer(),
    text: () => obj.text(),
  };
}

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

  async get(key: string): Promise<ObjectBody | null> {
    const obj = await this.bucket.get(key);
    return obj ? toBody(obj) : null;
  }

  async list(options?: ListOptions): Promise<ListResult> {
    const result = await this.bucket.list({
      ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
      ...(options?.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
    });
    return {
      objects: (result.objects ?? []).map(toMeta),
      delimitedPrefixes: result.delimitedPrefixes ?? [],
      truncated: result.truncated ?? false,
      ...(result.cursor ? { cursor: result.cursor } : {}),
    };
  }

  async createDirectory(prefix: string): Promise<void> {
    const key = prefix.endsWith('/') ? prefix : `${prefix}/`;
    await this.bucket.put(key, '', { httpMetadata: { contentType: 'application/x-directory' } });
  }
}
