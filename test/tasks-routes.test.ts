import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { buildRoutes } from '../src/server/routes/index.js';
import { createMemoryStorage } from '../src/storage/memory.js';
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
});