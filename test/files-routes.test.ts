import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { buildRoutes } from '../src/server/routes/index.js';
import { createMemoryStorage } from '../src/storage/memory.js';
import { FsObjectStore } from '../src/storage/fs.js';
import type { AppConfig } from '../src/types/index.js';

const TEST_CFG: AppConfig = {
  hypitCli: 'hypit',
  maxDurationSeconds: 180,
  normalizeSize: 512,
  maxShots: 10,
  outputResolution: '720p',
  dataDir: '/tmp',
  masterKey: 'test-master-key',
  callbackSecret: 'test-callback-secret',
  storageDriver: 'memory',
};

describe('文件管理路由', () => {
  let app: ReturnType<typeof buildRoutes>;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hypitapp-file-test-'));
    const storage = createMemoryStorage({ objectsDir: dir });
    app = buildRoutes(TEST_CFG, storage);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeRequest(path: string, init?: RequestInit) {
    return app.fetch(new Request(`http://localhost${path}`, init));
  }

  async function json(res: Response): Promise<any> {
    return res.json() as Promise<any>;
  }

  async function uploadFile(name: string, content: string, prefix = '') {
    const fd = new FormData();
    fd.append('file', new File([content], name, { type: 'text/plain' }));
    if (prefix) fd.append('prefix', prefix);
    return app.fetch(new Request('http://localhost/api/v1/files/upload', {
      method: 'POST',
      body: fd,
    }));
  }

  /* ---- 列举 ---- */

  it('GET /files 空目录返回空列表', async () => {
    const res = await makeRequest('/api/v1/files');
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.equal(data.items.length, 0);
  });

  it('GET /files 返回上传的文件', async () => {
    await uploadFile('hello.txt', 'hello world');
    const res = await makeRequest('/api/v1/files');
    const data = await json(res);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].name, 'hello.txt');
    assert.equal(data.items[0].type, 'file');
    assert.equal(data.items[0].size, 11);
  });

  it('GET /files 返回虚拟目录', async () => {
    await uploadFile('a.txt', 'a', 'tasks/t1');
    await uploadFile('b.txt', 'b', 'tasks/t2');
    await uploadFile('notes.txt', 'notes', 'tasks');
    const res = await makeRequest('/api/v1/files?prefix=tasks/');
    const data = await json(res);
    const dirs = data.items.filter((i: any) => i.type === 'directory');
    const files = data.items.filter((i: any) => i.type === 'file');
    assert.equal(dirs.length, 2);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'notes.txt');
  });

  /* ---- 上传 ---- */

  it('POST /files/upload 上传文件', async () => {
    const res = await uploadFile('test.txt', 'test content');
    assert.equal(res.status, 201);
    const data = await json(res);
    assert.equal(data.key, 'test.txt');
    assert.equal(data.size, 12);
    assert.equal(data.contentType, 'text/plain');
  });

  it('POST /files/upload 带前缀上传', async () => {
    const res = await uploadFile('test.txt', 'content', 'folder/');
    assert.equal(res.status, 201);
    const data = await json(res);
    assert.equal(data.key, 'folder/test.txt');
  });

  it('POST /files/upload 无 file 字段返回 400', async () => {
    const fd = new FormData();
    fd.append('prefix', '');
    const res = await app.fetch(new Request('http://localhost/api/v1/files/upload', {
      method: 'POST',
      body: fd,
    }));
    assert.equal(res.status, 400);
  });

  /* ---- 下载 ---- */

  it('GET /files/download 下载文件', async () => {
    await uploadFile('test.txt', 'download me');
    const res = await makeRequest('/api/v1/files/download?key=test.txt');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-disposition')?.includes('attachment'));
    assert.ok(res.headers.get('content-disposition')?.includes('test.txt'));
    const text = await res.text();
    assert.equal(text, 'download me');
  });

  it('GET /files/download 不存在返回 404', async () => {
    const res = await makeRequest('/api/v1/files/download?key=nope.txt');
    assert.equal(res.status, 404);
  });

  it('GET /files/download 缺少 key 返回 400', async () => {
    const res = await makeRequest('/api/v1/files/download');
    assert.equal(res.status, 400);
  });

  /* ---- 预览 ---- */

  it('GET /files/preview 返回完整文件', async () => {
    await uploadFile('video.mp4', 'fake-video-data');
    const res = await makeRequest('/api/v1/files/preview?key=video.mp4');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    const text = await res.text();
    assert.equal(text, 'fake-video-data');
  });

  it('GET /files/preview Range 请求返回 206', async () => {
    await uploadFile('big.mp4', '0123456789');
    const res = await makeRequest('/api/v1/files/preview?key=big.mp4', {
      headers: { 'range': 'bytes=2-5' },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 2-5/10');
    const text = await res.text();
    assert.equal(text, '2345');
  });

  it('GET /files/preview Range 越界返回 416', async () => {
    await uploadFile('small.txt', 'abc');
    const res = await makeRequest('/api/v1/files/preview?key=small.txt', {
      headers: { 'range': 'bytes=100-200' },
    });
    assert.equal(res.status, 416);
  });

  it('GET /files/preview 不存在返回 404', async () => {
    const res = await makeRequest('/api/v1/files/preview?key=nope.txt');
    assert.equal(res.status, 404);
  });

  /* ---- 删除 ---- */

  it('DELETE /files 删除文件', async () => {
    await uploadFile('delete-me.txt', 'bye');
    const res = await makeRequest('/api/v1/files?key=delete-me.txt', { method: 'DELETE' });
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.equal(data.deleted, 'delete-me.txt');

    const listRes = await makeRequest('/api/v1/files');
    const listData = await json(listRes);
    assert.equal(listData.items.length, 0);
  });

  it('DELETE /files 删除目录（递归）', async () => {
    await uploadFile('a.txt', 'a', 'dir/');
    await uploadFile('b.txt', 'b', 'dir/');
    await uploadFile('c.txt', 'c', 'other/');
    const res = await makeRequest('/api/v1/files?key=dir/', { method: 'DELETE' });
    assert.equal(res.status, 200);

    const listRes = await makeRequest('/api/v1/files');
    const listData = await json(listRes);
    assert.equal(listData.items.length, 1);
    assert.equal(listData.items[0].key, 'other/');
    assert.equal(listData.items[0].type, 'directory');
  });

  it('DELETE /files 缺少 key 返回 400', async () => {
    const res = await makeRequest('/api/v1/files', { method: 'DELETE' });
    assert.equal(res.status, 400);
  });

  it('POST /files/batch-delete 批量删除', async () => {
    await uploadFile('a.txt', 'a');
    await uploadFile('b.txt', 'b');
    await uploadFile('c.txt', 'c');
    const res = await makeRequest('/api/v1/files/batch-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: ['a.txt', 'b.txt'] }),
    });
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.equal(data.results.length, 2);
    assert.ok(data.results.every((r: any) => r.ok));

    const listRes = await makeRequest('/api/v1/files');
    const listData = await json(listRes);
    assert.equal(listData.items.length, 1);
    assert.equal(listData.items[0].key, 'c.txt');
  });

  it('POST /files/batch-delete 空数组返回 400', async () => {
    const res = await makeRequest('/api/v1/files/batch-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: [] }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /files/batch-delete 超过 100 个返回 400', async () => {
    const keys = Array.from({ length: 101 }, (_, i) => 'file' + i + '.txt');
    const res = await makeRequest('/api/v1/files/batch-delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
    assert.equal(res.status, 400);
  });

  /* ---- 全局搜索 ---- */

  it('GET /files/search 搜索文件', async () => {
    await uploadFile('hello.txt', 'hello');
    await uploadFile('world.txt', 'world');
    await uploadFile('nested/hello2.txt', 'hello2', 'nested/');
    const res = await makeRequest('/api/v1/files/search?q=hello');
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.equal(data.results.length, 2);
    assert.ok(data.results.some((r: any) => r.name === 'hello.txt'));
    assert.ok(data.results.some((r: any) => r.name === 'hello2.txt'));
  });

  it('GET /files/search 空查询返回 400', async () => {
    const res = await makeRequest('/api/v1/files/search?q=');
    assert.equal(res.status, 400);
  });

  it('GET /files/search 无结果返回空数组', async () => {
    const res = await makeRequest('/api/v1/files/search?q=nonexistent');
    assert.equal(res.status, 200);
    const data = await json(res);
    assert.equal(data.results.length, 0);
  });

  /* ---- 创建目录 ---- */

  it('POST /files/folder 创建目录', async () => {
    const res = await makeRequest('/api/v1/files/folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'new-folder' }),
    });
    assert.equal(res.status, 201);
    const data = await json(res);
    assert.equal(data.key, 'new-folder/');
    assert.equal(data.type, 'directory');
  });

  it('POST /files/folder 带前缀创建', async () => {
    await uploadFile('parent.txt', 'parent');
    const res = await makeRequest('/api/v1/files/folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefix: 'sub', name: 'child' }),
    });
    assert.equal(res.status, 201);
    const data = await json(res);
    assert.equal(data.key, 'sub/child/');
  });

  it('POST /files/folder 空名称返回 400', async () => {
    const res = await makeRequest('/api/v1/files/folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    assert.equal(res.status, 400);
  });

  /* ---- key 安全 ---- */

  it('拒绝 .. 路径穿越', async () => {
    const res = await makeRequest('/api/v1/files/download?key=..%2Fsecret.txt');
    assert.equal(res.status, 400);
  });

  it('拒绝空 key', async () => {
    const res = await makeRequest('/api/v1/files/download?key=');
    assert.equal(res.status, 400);
  });

  /* ---- 鉴权 ---- */

  it('无令牌访问返回 401（配置了 apiToken 时）', async () => {
    const cfgWithToken = { ...TEST_CFG, apiToken: 'secret-token' };
    const storage = createMemoryStorage({ objectsDir: dir });
    const authApp = buildRoutes(cfgWithToken, storage);
    const res = await authApp.fetch(new Request('http://localhost/api/v1/files'));
    assert.equal(res.status, 401);
  });

  it('正确令牌可访问', async () => {
    const cfgWithToken = { ...TEST_CFG, apiToken: 'secret-token' };
    const storage = createMemoryStorage({ objectsDir: dir });
    const authApp = buildRoutes(cfgWithToken, storage);
    const res = await authApp.fetch(new Request('http://localhost/api/v1/files', {
      headers: { 'authorization': 'Bearer secret-token' },
    }));
    assert.equal(res.status, 200);
  });
});
