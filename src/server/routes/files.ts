/**
 * 文件管理路由（R2 / FS / 内存 三驱动通用）。
 *
 * 端点：
 *  - GET    /files?prefix=&limit=       列举目录（虚拟目录聚合）
 *  - POST   /files/upload               上传文件（multipart/form-data）
 *  - GET    /files/download?key=        下载文件（需 Bearer 鉴权）
 *  - GET    /files/preview?key=         预览文件（支持 Range / 206）
 *  - DELETE /files?key=                 删除文件或目录（递归）
 *  - POST   /files/folder               创建目录标记
 *
 * 设计参考 videomodifyauto 项目的文件管理：
 *  - 对象存储即文件系统：无独立元数据表，list() 即真相
 *  - 目录用末尾 '/' 标记对象（R2）/ 实际目录（FS）
 *  - 预览支持 HTTP Range（206 Partial Content），保证视频可拖动
 *  - 下载需 Bearer 令牌（不能裸 <a href>）
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { StorageBundle } from '../../storage/types.js';

/* ---------------- 常量 ---------------- */

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const MAX_CHUNK_SIZE = 50 * 1024 * 1024; // 50MB per chunk

/* ---------------- key 校验 ---------------- */

/** 文件 key 白名单：允许字母数字、下划线、连字符、点、斜杠、中文等；拒绝 .. 逃逸。 */
const KEY_RE = /^[^\x00-\x1f\x7f]*$/;

/** 返回 null 表示非法 key（而非抛异常，便于路由层统一返回 400）。空字符串合法。 */
function safeKey(key: string): string | null {
  const k = key.replace(/^[/\\]+/, '');
  if (k === '') return '';
  if (!KEY_RE.test(k)) return null;
  const parts = k.split('/');
  for (const p of parts) {
    if (p === '..') return null;
  }
  return k;
}

function joinPrefix(prefix: string, name: string): string {
  const p = prefix.endsWith('/') ? prefix : prefix ? `${prefix}/` : '';
  return p + name;
}

/** 安全解析 query key，非法返回 400。 */
function readKey(c: any, queryKey: 'key' | 'prefix', maxLen: number): string | null {
  const raw = c.req.query();
  const val = raw[queryKey];
  if (!val) return null;
  if (typeof val !== 'string' || val.length > maxLen) return null;
  return safeKey(val);
}

/* ---------------- schema ---------------- */

const listQuery = z.object({
  prefix: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const folderBody = z.object({
  prefix: z.string().max(512).optional(),
  name: z.string().min(1).max(256),
});

/* ---------------- 工具函数 ---------------- */

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', avi: 'video/avi', mov: 'video/quicktime',
  mkv: 'video/x-matroska', flv: 'video/x-flv', wmv: 'video/x-ms-wmv',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac',
  flac: 'audio/flac', m4a: 'audio/mp4',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  tar: 'application/x-tar', rar: 'application/x-rar-compressed',
  js: 'text/javascript', css: 'text/css', html: 'text/html', htm: 'text/html',
  json: 'application/json', xml: 'application/xml',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain',
  ts: 'text/plain', tsx: 'text/plain', py: 'text/plain', sh: 'text/plain',
  yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain', ini: 'text/plain',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  svml: 'text/plain', svs: 'text/plain', svrun: 'text/plain',
};

function mimeFromKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/* ---------------- 路由 ---------------- */

export function buildFileRoutes(storage: StorageBundle): Hono {
  const app = new Hono();
  const store = storage.objects;

  /** 列举目录（虚拟目录聚合）。 */
  app.get('/', async (c) => {
    const raw = c.req.query();
    const parsed = listQuery.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid query', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    }
    const prefix = parsed.data.prefix ?? '';
    const safePrefix = safeKey(prefix);
    if (safePrefix === null) return c.json({ error: 'invalid prefix' }, 400);
    const limit = parsed.data.limit ?? 200;

    const result = await store.list({ prefix: safePrefix, delimiter: '/', limit });

    const items = [
      ...result.delimitedPrefixes.map((p) => ({
        name: p.replace(/\/$/, '').split('/').pop() || p,
        key: p,
        size: 0,
        type: 'directory' as const,
        lastModified: '',
        contentType: 'application/x-directory',
      })),
      ...result.objects.map((o) => ({
        name: o.key.split('/').pop() || o.key,
        key: o.key,
        size: o.size,
        type: 'file' as const,
        lastModified: o.lastModified,
        ...(o.contentType ? { contentType: o.contentType } : {}),
      })),
    ].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));

    return c.json({ prefix: safePrefix, items, truncated: result.truncated, ...(result.cursor ? { cursor: result.cursor } : {}) });
  });

  /** 上传文件（multipart/form-data）。支持分片上传。 */
  app.post('/upload', async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'missing file', detail: 'expected multipart/form-data with a "file" field' }, 400);
    }
    const prefixVal = formData.get('prefix');
    const rawPrefix = typeof prefixVal === 'string' ? prefixVal : '';
    const safePrefix = safeKey(rawPrefix);
    if (safePrefix === null) return c.json({ error: 'invalid prefix' }, 400);
    const fileName = formData.get('fileName');
    const name = (typeof fileName === 'string' && fileName) || file.name || 'unnamed';
    const key = safeKey(joinPrefix(safePrefix, name));
    if (key === null) return c.json({ error: 'invalid file name' }, 400);

    const chunkIdxVal = formData.get('chunk');
    const totalChunksVal = formData.get('totalChunks');
    const chunkIdx = typeof chunkIdxVal === 'string' ? chunkIdxVal : null;
    const totalChunks = typeof totalChunksVal === 'string' ? totalChunksVal : null;
    const contentType = file.type || mimeFromKey(key);

    // 分片上传模式
    if (chunkIdx !== null && totalChunks !== null) {
      const idx = parseInt(chunkIdx, 10);
      const total = parseInt(totalChunks, 10);
      if (isNaN(idx) || isNaN(total) || idx < 0 || total < 1 || idx >= total) {
        return c.json({ error: 'invalid chunk parameters' }, 400);
      }
      if (file.size > MAX_CHUNK_SIZE) {
        return c.json({ error: 'chunk too large', detail: `max ${MAX_CHUNK_SIZE} bytes` }, 413);
      }
      const buf = await file.arrayBuffer();
      const chunkKey = `chunk:${key}:${idx}`;
      await store.put(chunkKey, buf, 'application/octet-stream');

      // 如果是最后一个分片，触发合并
      if (idx === total - 1) {
        const chunksToMerge = [];
        for (let i = 0; i < total; i++) {
          const ck = `chunk:${key}:${i}`;
          const body = await store.get(ck);
          if (!body) {
            return c.json({ error: 'missing chunk', detail: `chunk ${i} not found` }, 400);
          }
          chunksToMerge.push(await body.arrayBuffer());
        }
        const totalSize = chunksToMerge.reduce((s, b) => s + b.byteLength, 0);
        if (totalSize > MAX_FILE_SIZE) {
          return c.json({ error: 'file too large', detail: `max ${MAX_FILE_SIZE} bytes` }, 413);
        }
        const merged = new Uint8Array(totalSize);
        let offset = 0;
        for (let i = 0; i < chunksToMerge.length; i++) {
          const chunk = chunksToMerge[i];
          if (!chunk) continue;
          merged.set(new Uint8Array(chunk), offset);
          offset += chunk.byteLength;
          await store.delete(`chunk:${key}:${i}`);
        }
        await store.put(key, merged.buffer, contentType);
        return c.json({ key, size: totalSize, contentType, chunks: chunksToMerge.length, merged: true }, 201);
      }

      return c.json({ key, chunk: idx, total, received: buf.byteLength }, 201);
    }

    // 单文件上传
    if (file.size > MAX_FILE_SIZE) {
      return c.json({ error: 'file too large', detail: `max ${MAX_FILE_SIZE} bytes` }, 413);
    }
    const buf = await file.arrayBuffer();
    await store.put(key, buf, contentType);
    return c.json({ key, size: buf.byteLength, contentType }, 201);
  });

  /** 下载文件（Content-Disposition: attachment）。R2 配置了 PUBLIC_URL 时直接重定向。 */
  app.get('/download', async (c) => {
    const key = readKey(c, 'key', 2048);
    if (!key) return c.json({ error: 'invalid key', detail: 'key is required' }, 400);

    const directUrl = store.getUrl(key);
    if (directUrl.startsWith('http')) {
      return new Response(null, {
        status: 302,
        headers: {
          'location': directUrl,
          'content-disposition': `attachment; filename="${encodeURIComponent(key.split('/').pop() || key)}"`,
        },
      });
    }

    const body = await store.get(key);
    if (!body) return c.json({ error: 'not found', detail: `key: ${key}` }, 404);

    const buf = await body.arrayBuffer();
    const name = key.split('/').pop() || key;
    const contentType = body.contentType || mimeFromKey(key);

    return new Response(buf, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(buf.byteLength),
        'content-disposition': `attachment; filename="${encodeURIComponent(name)}"`,
      },
    });
  });

  /** 预览文件（支持 HTTP Range / 206，保证视频可拖动）。 */
  app.get('/preview', async (c) => {
    const key = readKey(c, 'key', 2048);
    if (!key) return c.json({ error: 'invalid key', detail: 'key is required' }, 400);

    const body = await store.get(key);
    if (!body) return c.json({ error: 'not found', detail: `key: ${key}` }, 404);

    const buf = await body.arrayBuffer();
    const contentType = body.contentType || mimeFromKey(key);
    const total = buf.byteLength;
    const headers: Record<string, string> = {
      'content-type': contentType,
      'accept-ranges': 'bytes',
    };

    const rangeHeader = c.req.header('range');
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const start = parseInt(m[1]!, 10);
        const end = m[2] ? parseInt(m[2]!, 10) : total - 1;
        if (start >= total) {
          return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
        }
        const chunk = buf.slice(start, end + 1);
        headers['content-range'] = `bytes ${start}-${end}/${total}`;
        headers['content-length'] = String(chunk.byteLength);
        return new Response(chunk, { status: 206, headers });
      }
    }

    headers['content-length'] = String(total);
    return new Response(buf, { status: 200, headers });
  });

  /** 删除文件或目录（递归）。 */
  app.delete('/', async (c) => {
    const key = readKey(c, 'key', 2048);
    if (!key) return c.json({ error: 'invalid key', detail: 'key is required' }, 400);

    await store.delete(key);
    return c.json({ deleted: key });
  });

  /** 搜索文件（跨目录，限制 500 个结果）。 */
  app.get('/search', async (c) => {
    const q = c.req.query('q');
    if (!q || q.length < 1) return c.json({ error: 'missing query' }, 400);

    const results: Array<{ key: string; name: string; size: number; lastModified: string; contentType?: string }> = [];
    const query = q.toLowerCase();

    async function searchPrefix(prefix: string, depth: number): Promise<void> {
      if (results.length >= 500 || depth > 10) return;

      let cursor: string | undefined;
      let truncated = true;

      while (truncated && results.length < 500) {
        const listResult = await store.list({ prefix, delimiter: '/', limit: 1000, ...(cursor ? { cursor } : {}) });

        for (const obj of listResult.objects) {
          const name = obj.key.split('/').pop() || obj.key;
          if (name.toLowerCase().includes(query)) {
            results.push({ key: obj.key, name, size: obj.size, lastModified: obj.lastModified, ...(obj.contentType ? { contentType: obj.contentType } : {}) });
          }
        }

        // 递归搜索子目录
        for (const dir of listResult.delimitedPrefixes) {
          if (results.length >= 500) break;
          await searchPrefix(dir, depth + 1);
        }

        truncated = listResult.truncated;
        cursor = listResult.cursor;
      }
    }

    await searchPrefix('', 0);

    return c.json({ query: q, results, truncated: results.length >= 500 });
  });

  /** 批量删除（最多 100 个）。 */
  app.post('/batch-delete', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = z.object({ keys: z.array(z.string().min(1).max(2048)).min(1).max(100) }).safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid request' }, 400);

    const results: Array<{ key: string; ok: boolean; error?: string }> = [];
    for (const k of parsed.data.keys) {
      const safe = safeKey(k);
      if (safe === null) {
        results.push({ key: k, ok: false, error: 'invalid key' });
        continue;
      }
      try {
        await store.delete(safe);
        results.push({ key: k, ok: true });
      } catch (err) {
        results.push({ key: k, ok: false, error: String(err) });
      }
    }
    return c.json({ results });
  });

  /** 创建目录标记。 */
  app.post('/folder', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body', detail: 'expected JSON body' }, 400);
    }
    const parsed = folderBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    }
    const safePrefix = safeKey(parsed.data.prefix ?? '');
    if (safePrefix === null) return c.json({ error: 'invalid prefix' }, 400);
    const name = parsed.data.name.replace(/[\\/]/g, '_');
    const key = safeKey(joinPrefix(safePrefix, name));
    if (key === null) return c.json({ error: 'invalid folder name' }, 400);
    const dirKey = key.endsWith('/') ? key : `${key}/`;

    await store.createDirectory(dirKey);
    return c.json({ key: dirKey, type: 'directory' }, 201);
  });

  return app;
}
