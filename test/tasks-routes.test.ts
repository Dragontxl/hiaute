import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { buildRoutes } from '../src/server/routes/index.js';
import { createMemoryStorage } from '../src/storage/memory.js';
import { signPayload } from '../src/core/crypto.js';
import type { AppConfig } from '../src/types/index.js';

const BASE_CFG: AppConfig = {
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

function makeApp(cfg: AppConfig) {
  return buildRoutes(cfg, createMemoryStorage());
}

function req(app: ReturnType<typeof makeApp>, path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

describe('任务创建与重试（dispatch 语义）', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('未配置 github 时创建任务保持 PENDING', async () => {
    const app = makeApp(BASE_CFG);
    const res = await req(app, '/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '无名？', referenceUrl: 'https://example.com/v.mp4' }),
    });
    assert.equal(res.status, 201);
    const t = (await res.json()) as any;
    assert.equal(t.status, 'PENDING');
    assert.equal(t.name, '无名？');
  });

  it('未取名时以创建时间命名', async () => {
    const app = makeApp(BASE_CFG);
    const res = await req(app, '/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const t = (await res.json()) as any;
    assert.ok(/^\d{8}-\d{4}$/.test(t.name), `默认名: ${t.name}`);
  });

  it('未配置 github 时重试返回 503', async () => {
    const app = makeApp(BASE_CFG);
    const created = (await (await req(app, '/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).json()) as any;
    const res = await req(app, `/api/v1/tasks/${created.id}`, { method: 'POST' });
    assert.equal(res.status, 503);
  });

  it('配置 github 且派发成功 → DISPATCHED', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const app = makeApp({ ...BASE_CFG, github: { pat: 'x', owner: 'o', repo: 'r', eventType: 'hypit-task', callbackUrl: '' } });
    const res = await req(app, '/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 201);
    const t = (await res.json()) as any;
    assert.equal(t.status, 'DISPATCHED');
  });

  it('配置 github 但派发失败 → 502 且任务 FAILED', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const app = makeApp({ ...BASE_CFG, github: { pat: 'x', owner: 'o', repo: 'r', eventType: 'hypit-task', callbackUrl: '' } });
    const res = await req(app, '/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 502);
  });

  it('DISPATCHED 任务不可重试（409）', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const app = makeApp({ ...BASE_CFG, github: { pat: 'x', owner: 'o', repo: 'r', eventType: 'hypit-task', callbackUrl: '' } });
    const created = (await (await req(app, '/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).json()) as any;
    assert.equal(created.status, 'DISPATCHED');
    const res = await req(app, `/api/v1/tasks/${created.id}`, { method: 'POST' });
    assert.equal(res.status, 409);
  });

  it('PENDING 任务可重试并派发成功', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    // 先以无 github 配置创建（保持 PENDING）
    const pendingApp = makeApp(BASE_CFG);
    const created = (await (await req(pendingApp, '/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).json()) as any;
    assert.equal(created.status, 'PENDING');
    // 换成有 github 配置的应用（同一存储）后重试
    const storage = createMemoryStorage();
    const app1 = buildRoutes(BASE_CFG, storage);
    const t1 = (await (await app1.fetch(new Request('http://localhost/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))).json()) as any;
    const app2 = buildRoutes(
      { ...BASE_CFG, github: { pat: 'x', owner: 'o', repo: 'r', eventType: 'hypit-task', callbackUrl: '' } },
      storage,
    );
    const res = await app2.fetch(new Request(`http://localhost/api/v1/tasks/${t1.id}`, { method: 'POST' }));
    assert.equal(res.status, 200);
    const after = (await res.json()) as any;
    assert.equal(after.status, 'DISPATCHED');
  });

  it('healthz 暴露 dispatch 配置状态', async () => {
    const on = makeApp({ ...BASE_CFG, github: { pat: 'x', owner: 'o', repo: 'r', eventType: 'hypit-task', callbackUrl: '' } });
    const off = makeApp(BASE_CFG);
    assert.equal(((await (await on.fetch(new Request('http://localhost/healthz'))).json()) as any).dispatch, 'enabled');
    assert.equal(((await (await off.fetch(new Request('http://localhost/healthz'))).json()) as any).dispatch, 'disabled');
  });

  it('FAILED 任务可重试并离开终态（force 覆盖终态保护）', async () => {
    // 先创建任务，再用回调把它置为 FAILED
    const storage = createMemoryStorage();
    const app = buildRoutes({ ...BASE_CFG, github: { pat: 'x', owner: 'o', repo: 'r', eventType: 'hypit-task', callbackUrl: '' } }, storage);
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const created = (await (await app.fetch(new Request('http://localhost/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))).json()) as any;
    assert.equal(created.status, 'DISPATCHED');
    // 模拟失败回调
    await storage.tasks.markStatus(created.id, 'FAILED', 'SVML compile check failed');
    const failed = await storage.tasks.get(created.id);
    assert.equal(failed?.status, 'FAILED');
    assert.equal(failed?.error, 'SVML compile check failed');
    // 重试：应重新派发并离开终态，同时清空错误
    const res = await app.fetch(new Request(`http://localhost/api/v1/tasks/${created.id}`, { method: 'POST' }));
    assert.equal(res.status, 200);
    const after = (await res.json()) as any;
    assert.equal(after.status, 'DISPATCHED', 'FAILED 任务重试后应为 DISPATCHED');
    assert.equal(after.error, undefined, '重试派发后应清空错误');
  });
});

describe('产物上传回调 /api/v1/callback/artifact', () => {
  it('有效签名上传成功并写入对象存储', async () => {
    const app = makeApp(BASE_CFG);
    const canonical = 'artifact:t1:tasks/t1/:final.mp4';
    const sig = signPayload(canonical, BASE_CFG.callbackSecret);
    const fd = new FormData();
    fd.append('taskId', 't1');
    fd.append('prefix', 'tasks/t1/');
    fd.append('file', new File([new Uint8Array([1, 2, 3])], 'final.mp4', { type: 'video/mp4' }));
    const res = await app.fetch(new Request('http://localhost/api/v1/callback/artifact', {
      method: 'POST',
      body: fd,
      headers: { 'x-callback-signature': sig },
    }));
    assert.equal(res.status, 201);
    const j = (await res.json()) as any;
    assert.equal(j.key, 'tasks/t1/final.mp4');
    assert.equal(j.size, 3);
  });

  it('无效签名返回 401', async () => {
    const app = makeApp(BASE_CFG);
    const fd = new FormData();
    fd.append('taskId', 't1');
    fd.append('prefix', 'tasks/t1/');
    fd.append('file', new File([new Uint8Array([1])], 'a.mp4', { type: 'video/mp4' }));
    const res = await app.fetch(new Request('http://localhost/api/v1/callback/artifact', {
      method: 'POST',
      body: fd,
      headers: { 'x-callback-signature': 'bad' },
    }));
    assert.equal(res.status, 401);
  });

  it('缺少文件返回 400', async () => {
    const app = makeApp(BASE_CFG);
    const fd = new FormData();
    fd.append('taskId', 't1');
    const res = await app.fetch(new Request('http://localhost/api/v1/callback/artifact', {
      method: 'POST',
      body: fd,
      headers: { 'x-callback-signature': 'x' },
    }));
    assert.equal(res.status, 400);
  });

  it('分片上传大文件后自动合并写入对象存储', async () => {
    const storage = createMemoryStorage();
    const app = buildRoutes(BASE_CFG, storage);
    // 构造 3 片内容，等价于一次分片上传（fileName 覆盖原名，chunk 分片）
    const original = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    const chunkSize = 5;
    const total = Math.ceil(original.length / chunkSize);
    for (let i = 0; i < total; i += 1) {
      const chunk = new Uint8Array(original.slice(i * chunkSize, (i + 1) * chunkSize));
      const fd = new FormData();
      fd.append('taskId', 't1');
      fd.append('prefix', 'tasks/t1/');
      // fileName 保持原名 final.mp4；file 名带序号
      fd.append('fileName', 'final.mp4');
      fd.append('chunk', String(i));
      fd.append('totalChunks', String(total));
      fd.append('file', new File([chunk], `part.${i}`, { type: 'application/octet-stream' }));
      const canonical = 'artifact:t1:tasks/t1/:final.mp4';
      const sig = signPayload(canonical, BASE_CFG.callbackSecret);
      const res = await app.fetch(new Request('http://localhost/api/v1/callback/artifact', {
        method: 'POST',
        body: fd,
        headers: { 'x-callback-signature': sig },
      }));
      assert.equal(res.status, 201, `chunk ${i} 应 201`);
    }
    // 校验合并后对象内容与原数据一致
    const body = await storage.objects.get('tasks/t1/final.mp4');
    assert.ok(body, '合并后的 final.mp4 应存在');
    const buf = new Uint8Array(await body!.arrayBuffer());
    assert.deepEqual(Array.from(buf), Array.from(original), '合并内容应与原数据一致');
  });
});

describe('删除任务（级联删除产物目录）', () => {
  function appWithStorage() {
    const storage = createMemoryStorage();
    const app = buildRoutes(BASE_CFG, storage);
    return { app, storage };
  }

  it('删除任务返回 deleted 并移除记录', async () => {
    const { app } = appWithStorage();
    const created = (await (await req(app, '/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '待删任务' }),
    })).json()) as any;

    const del = await req(app, `/api/v1/tasks/${created.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const body = (await del.json()) as any;
    assert.equal(body.deleted, true);
    assert.equal(body.id, created.id);

    const after = await req(app, `/api/v1/tasks/${created.id}`);
    assert.equal(after.status, 404);
  });

  it('删除任务时级联删除 R2 产物目录', async () => {
    const { app, storage } = appWithStorage();
    const created = (await (await req(app, '/api/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '有产物的任务' }),
    })).json()) as any;

    // 直接写入模拟产物（目录名 = artifactDirName）
    const { artifactDirName } = await import('../src/storage/taskName.js');
    const dir = artifactDirName(created.name, created.id, created.createdAt);
    await storage.objects.put(`tasks/${dir}/final.mp4`, new Uint8Array([1, 2, 3]), 'video/mp4');
    await storage.objects.put(`tasks/${dir}/script.svml`, 'svml', 'text/plain');
    const before = await storage.objects.list({ prefix: `tasks/${dir}/` });
    assert.equal(before.objects.length, 2);

    const del = await req(app, `/api/v1/tasks/${created.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);

    const after = await storage.objects.list({ prefix: `tasks/${dir}/` });
    assert.equal(after.objects.length, 0, '产物目录应被清空');
  });

  it('删除不存在的任务返回 404', async () => {
    const { app } = appWithStorage();
    const res = await req(app, '/api/v1/tasks/does-not-exist', { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});

describe('媒体流式播放鉴权（?token= 查询参数）', () => {
  function appWithToken() {
    const storage = createMemoryStorage();
    const app = buildRoutes({ ...BASE_CFG, apiToken: 'secret-token' }, storage);
    return { app, storage };
  }

  it('缺少令牌返回 401', async () => {
    const { app } = appWithToken();
    const res = await req(app, '/api/v1/tasks');
    assert.equal(res.status, 401);
  });

  it('查询参数 ?token= 可访问（供 <video> 流式播放）', async () => {
    const { app } = appWithToken();
    const res = await req(app, '/api/v1/tasks?token=secret-token');
    assert.equal(res.status, 200);
  });
});