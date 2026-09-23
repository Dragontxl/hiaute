/**
 * 本地文件系统对象存储（常驻/本地形态的产物落盘）。
 *
 * 与 R2 实现同一 ObjectStore 契约：本地形态不需要 R2，但需要产物真正落盘
 * （内存对象存储只返回 memory:// 占位 URL，无法被远端模型或前端访问）。
 * getUrl 返回 file:// URL——Agnes 等远端模型无法拉取，流水线会自动跳过 imageUrl。
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ObjectStore } from './types.js';

export class FsObjectStore implements ObjectStore {
  constructor(private readonly rootDir: string) {}

  private abs(key: string): string {
    const root = resolve(this.rootDir);
    const target = resolve(root, key.replace(/^[/\\]+/, ''));
    // 拒绝 .. 逃逸，避免把产物写到对象根之外
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`object key escapes store root: ${key}`);
    }
    return target;
  }

  async put(key: string, body: ArrayBuffer | Uint8Array | string, _contentType?: string): Promise<string> {
    const p = this.abs(key);
    await mkdir(dirname(p), { recursive: true });
    // ArrayBuffer 在 writeFile 的类型签名里不被接受，统一转成 Uint8Array
    const data = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
    await writeFile(p, data);
    return this.getUrl(key);
  }

  getUrl(key: string): string {
    return pathToFileURL(this.abs(key)).toString();
  }

  async delete(prefixOrKey: string): Promise<void> {
    const p = this.abs(prefixOrKey);
    try {
      const s = await stat(p);
      if (s.isDirectory()) await rm(p, { recursive: true, force: true });
      else await rm(p, { force: true });
    } catch {
      // 不存在则忽略
    }
  }
}
