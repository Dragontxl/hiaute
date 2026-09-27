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
  readonly multipart = true;
  constructor(private bucket: R2Bucket, private publicUrl?: string) {}

  async put(key: string, body: ArrayBuffer | Uint8Array | string, contentType?: string): Promise<string> {
    await this.bucket.put(key, body, contentType ? { httpMetadata: { contentType } } : undefined);
    return this.getUrl(key);
  }

  getUrl(key: string): string {
    if (!this.publicUrl) return `r2://${key}`;
    return `${this.publicUrl.replace(/\/$/, '')}/${key}`;
  }

  /** R2 原生 multipart 辅助：跨请求状态存到临时对象（worker 无状态，uploadId 必须持久化）。 */
  private mpStateKey(key: string): string {
    return `__mpstate:${key}`;
  }

  /** 开始 multipart：创建并持久化状态（uploadId + 已传 parts），返回是否"由本片创建"。 */
  async beginMultipart(key: string, contentType?: string): Promise<void> {
    const up = await this.bucket.createMultipartUpload(key, contentType ? { httpMetadata: { contentType } } : undefined);
    const state = JSON.stringify({ uploadId: up.uploadId, parts: [] });
    await this.bucket.put(this.mpStateKey(key), state, { httpMetadata: { contentType: 'application/json' } });
  }

  /** 上传一片：读状态 → uploadPart → 追加 etag → 存回。返回累计 part 数。 */
  async uploadMultipartPart(key: string, partNumber: number, body: ArrayBuffer | Uint8Array): Promise<{ totalParts: number; etag: string }> {
    const stateObj = await this.bucket.get(this.mpStateKey(key));
    if (!stateObj) throw new Error(`multipart state missing for ${key}`);
    const state = JSON.parse(await stateObj.text()) as { uploadId: string; parts: Array<{ partNumber: number; etag: string }> };
    const part = await this.bucket.uploadPart(key, state.uploadId, partNumber, body);
    state.parts.push({ partNumber: part.partNumber, etag: part.etag });
    state.parts.sort((a, b) => a.partNumber - b.partNumber);
    await this.bucket.put(this.mpStateKey(key), JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
    return { totalParts: state.parts.length, etag: part.etag };
  }

  /** 完成合并：completeMultipartUpload + 清理状态。 */
  async completeMultipart(key: string): Promise<{ size: number; etag?: string }> {
    const stateObj = await this.bucket.get(this.mpStateKey(key));
    if (!stateObj) throw new Error(`multipart state missing for ${key}`);
    const state = JSON.parse(await stateObj.text()) as { uploadId: string; parts: Array<{ partNumber: number; etag: string }> };
    if (state.parts.length === 0) throw new Error(`multipart has no parts for ${key}`);
    const done = await this.bucket.completeMultipartUpload(key, state.uploadId, state.parts);
    await this.bucket.delete(this.mpStateKey(key));
    return { size: done.size ?? 0, ...(done.etag ? { etag: done.etag } : {}) };
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
