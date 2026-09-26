/**
 * 本地文件系统对象存储（常驻/本地形态的产物落盘）。
 *
 * 与 R2 实现同一 ObjectStore 契约：本地形态不需要 R2，但需要产物真正落盘
 * （内存对象存储只返回 memory:// 占位 URL，无法被远端模型或前端访问）。
 * getUrl 返回 file:// URL——Agnes 等远端模型无法拉取，流水线会自动跳过 imageUrl。
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ListOptions, ListResult, ObjectBody, ObjectMeta, ObjectStore } from './types.js';

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

  /** 将绝对路径还原为相对 key（用于 list 返回）。 */
  private rel(absPath: string): string {
    const root = resolve(this.rootDir);
    return absPath.slice(root.length).replace(/^[\\/]/, '');
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

  async get(key: string): Promise<ObjectBody | null> {
    const p = this.abs(key);
    let s;
    try {
      s = await stat(p);
    } catch {
      return null;
    }
    if (!s.isFile()) return null;
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(p);
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    return {
      key,
      size: s.size,
      lastModified: s.mtime.toISOString(),
      arrayBuffer: () => Promise.resolve(buf),
      text: () => Promise.resolve(new TextDecoder().decode(data)),
    };
  }

  async list(options?: ListOptions): Promise<ListResult> {
    const prefix = options?.prefix ?? '';
    const delimiter = options?.delimiter;
    const limit = options?.limit ?? 1000;

    const p = this.abs(prefix);
    let entries;
    try {
      entries = await readdir(p, { withFileTypes: true });
    } catch {
      return { objects: [], delimitedPrefixes: [], truncated: false };
    }

    const objects: ObjectMeta[] = [];
    const delimitedPrefixes: string[] = [];
    const dirPrefix = prefix.endsWith('/') ? prefix : prefix ? `${prefix}/` : '';

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (delimiter === '/') {
          delimitedPrefixes.push(`${dirPrefix}${entry.name}/`);
        } else {
          await this.walkDir(join(p, entry.name), dirPrefix, objects, limit - objects.length - delimitedPrefixes.length);
        }
      } else if (entry.isFile()) {
        if (objects.length + delimitedPrefixes.length >= limit) break;
        const key = `${dirPrefix}${entry.name}`;
        const s = await stat(join(p, entry.name));
        objects.push({ key, size: s.size, lastModified: s.mtime.toISOString() });
      }
    }

    const truncated = entries.length > objects.length + delimitedPrefixes.length;
    return { objects, delimitedPrefixes, truncated, ...(truncated ? { cursor: '' } : {}) };
  }

  private async walkDir(absPath: string, dirPrefix: string, objects: ObjectMeta[], remaining: number): Promise<void> {
    if (remaining <= 0) return;
    let entries;
    try {
      entries = await readdir(absPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (remaining <= 0) return;
      if (entry.isDirectory()) {
        await this.walkDir(join(absPath, entry.name), `${dirPrefix}${entry.name}/`, objects, remaining);
      } else if (entry.isFile()) {
        const key = `${dirPrefix}${entry.name}`;
        const s = await stat(join(absPath, entry.name));
        objects.push({ key, size: s.size, lastModified: s.mtime.toISOString() });
      }
    }
  }

  async createDirectory(prefix: string): Promise<void> {
    const p = this.abs(prefix);
    await mkdir(p, { recursive: true });
  }
}
