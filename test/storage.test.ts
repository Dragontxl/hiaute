import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MemoryAccountLeaseStore, MemoryObjectStore, MemoryRateLimitBackend, MemoryTaskRepository } from '../src/storage/memory.js';
import { emptyCheckpoint, mergeCheckpoints, parseCheckpoint } from '../src/storage/merge.js';
import { FsObjectStore } from '../src/storage/fs.js';
import { rateRulesFor } from '../src/storage/rules.js';
import { formatTaskName } from '../src/storage/taskName.js';

describe('checkpoint 合并语义', () => {
  it('completedStages 并集去重，重复上报不重复计数', () => {
    const a = emptyCheckpoint();
    a.completedStages.push('DETECT', 'ANALYZE');
    const merged = mergeCheckpoints(a, { completedStages: ['ANALYZE', 'CROP_SHOTS'] });
    assert.deepEqual(merged.completedStages, ['DETECT', 'ANALYZE', 'CROP_SHOTS']);
  });

  it('completedShots 并集去重', () => {
    const a = emptyCheckpoint();
    a.completedShots.push(0, 1);
    const merged = mergeCheckpoints(a, { completedShots: [1, 2] });
    assert.deepEqual(merged.completedShots, [0, 1, 2]);
  });

  it('remoteTasks 同 key 后者覆盖', () => {
    const a = emptyCheckpoint();
    a.remoteTasks['shot-0'] = 'task-1';
    const merged = mergeCheckpoints(a, { remoteTasks: { 'shot-0': 'task-2', 'shot-1': 'task-3' } });
    assert.equal(merged.remoteTasks['shot-0'], 'task-2');
    assert.equal(merged.remoteTasks['shot-1'], 'task-3');
  });

  it('base 缺省时以空检查点为底', () => {
    const merged = mergeCheckpoints(undefined, { completedStages: ['DETECT'] });
    assert.deepEqual(merged, { remoteTasks: {}, completedStages: ['DETECT'], completedShots: [] });
  });
});

describe('parseCheckpoint 防御式解析', () => {
  it('过滤非法阶段与非法镜头序号', () => {
    const cp = parseCheckpoint({
      completedStages: ['DETECT', 'NOPE', 42],
      completedShots: [0, 1.5, -1, 3, 'x'],
      remoteTasks: { 'shot-0': 'ok', 'bad': 123 },
    });
    assert.deepEqual(cp.completedStages, ['DETECT']);
    assert.deepEqual(cp.completedShots, [0, 3]);
    assert.deepEqual(cp.remoteTasks, { 'shot-0': 'ok' });
  });

  it('任意输入都返回合法结构', () => {
    for (const raw of [null, undefined, 'str', 5, [], { completedStages: 'x' }]) {
      const cp = parseCheckpoint(raw);
      assert.deepEqual(Object.keys(cp).sort(), ['completedShots', 'completedStages', 'remoteTasks']);
      assert.equal(cp.completedStages.length, 0);
      assert.equal(cp.completedShots.length, 0);
    }
  });
});

describe('MemoryRateLimitBackend 滑动窗口', () => {
  const rule = { windowMs: 60_000, max: 3 };
  const t0 = 1_000_000;

  it('窗口内第 max+1 次被拒，并给出重试时间', async () => {
    const rl = new MemoryRateLimitBackend();
    for (let i = 0; i < 3; i++) {
      assert.equal((await rl.consume('api:agnes-video', rule, t0)).allowed, true, `consume #${i + 1}`);
    }
    const denied = await rl.consume('api:agnes-video', rule, t0 + 1000);
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterMs, 59_000);
  });

  it('窗口过后重新计数', async () => {
    const rl = new MemoryRateLimitBackend();
    await rl.consume('k', rule, t0);
    await rl.consume('k', rule, t0);
    await rl.consume('k', rule, t0);
    assert.equal((await rl.consume('k', rule, t0)).allowed, false);
    assert.equal((await rl.consume('k', rule, t0 + 60_000)).allowed, true);
  });

  it('不同 key 互不影响', async () => {
    const rl = new MemoryRateLimitBackend();
    for (let i = 0; i < 3; i++) await rl.consume('global', rule, t0);
    assert.equal((await rl.consume('api:gemini', rule, t0)).allowed, true);
  });
});

describe('rateRulesFor', () => {
  it('返回全局与能力两条规则，且顺序固定', () => {
    const rules = rateRulesFor('gemini');
    assert.deepEqual(rules.map((r) => r[0]), ['global', 'api:gemini']);
    assert.equal(rules[1]![1].max, 15);
  });

  it('未知 apiType 回退全局规则', () => {
    const rules = rateRulesFor('unknown' as never);
    assert.equal(rules[1]![1].max, rules[0]![1].max);
  });
});

describe('MemoryAccountLeaseStore 租约与隔离', () => {
  const store = () => new MemoryAccountLeaseStore();
  const candidates = [
    { id: 'a', alias: 'agnes-1', weight: 100 },
    { id: 'b', alias: 'agnes-2', weight: 50 },
  ];

  it('授予租约后同一时刻不可被再次选中', async () => {
    const s = store();
    const g1 = await s.acquire('agnes-video', candidates, 60_000, 1_000);
    assert.ok(g1);
    // 未释放前，候选里只剩下另一个账户
    const g2 = await s.acquire('agnes-video', candidates, 60_000, 1_500);
    assert.equal(g2?.accountId, candidates.find((c) => c.id !== g1!.accountId)!.id);
  });

  it('TTL 到期后自动可用', async () => {
    const s = store();
    await s.acquire('agnes-video', candidates, 100, 1_000);
    const again = await s.acquire('agnes-video', [candidates[0]!], 100, 2_000);
    assert.ok(again);
  });

  it('账户级故障（403）连续 3 次被隔离，markSuccess 后恢复', async () => {
    const s = store();
    const c = candidates[0]!;
    await s.acquire('agnes-video', [c], 100, 1_000);
    for (let i = 0; i < 3; i++) await s.markFailure('agnes-video', c.id, 'HTTP 403 Forbidden');
    assert.equal((await s.snapshot()).find((x) => x.accountId === c.id)!.healthy, false);
    assert.equal(await s.acquire('agnes-video', [c], 100, 2_000), null);
    await s.markSuccess('agnes-video', c.id);
    assert.ok(await s.acquire('agnes-video', [c], 100, 3_000));
  });

  it('临时错误（503/429/timeout）不隔离账户', async () => {
    const s = store();
    const c = candidates[0]!;
    await s.acquire('agnes-video', [c], 100, 1_000);
    await s.markFailure('agnes-video', c.id, 'HTTP 503 Service Unavailable');
    await s.markFailure('agnes-video', c.id, 'HTTP 429 Too Many Requests');
    await s.markFailure('agnes-video', c.id, 'fetch failed timeout');
    // 连续 3 次临时错误后账户仍健康、仍可租用
    assert.equal((await s.snapshot()).find((x) => x.accountId === c.id)!.healthy, true);
    assert.equal((await s.snapshot()).find((x) => x.accountId === c.id)!.consecutiveFailures, 0);
    assert.ok(await s.acquire('agnes-video', [c], 100, 5_000));
  });

  it('全部候选被占用时返回 null', async () => {
    const s = store();
    await s.acquire('agnes-video', candidates, 60_000, 1_000);
    await s.acquire('agnes-video', candidates, 60_000, 1_000);
    assert.equal(await s.acquire('agnes-video', candidates, 60_000, 1_000), null);
  });
});

describe('MemoryTaskRepository 状态机幂等', () => {
  async function createTask(repo: MemoryTaskRepository) {
    return repo.create({
      maxDurationSeconds: 180,
      normalizeSize: 512,
      outputResolution: '720p',
    });
  }

  it('advanceStage 重复上报同一阶段不重复累加', async () => {
    const repo = new MemoryTaskRepository();
    const t = await createTask(repo);
    await repo.advanceStage(t.id, 'ANALYZE');
    await repo.advanceStage(t.id, 'ANALYZE');
    await repo.advanceStage(t.id, 'ANALYZE');
    const got = await repo.get(t.id);
    assert.deepEqual(got!.checkpoint!.completedStages, ['ANALYZE']);
    assert.equal(got!.stage, 'ANALYZE');
  });

  it('markStatus 终态不可被后续回调覆盖', async () => {
    const repo = new MemoryTaskRepository();
    const t = await createTask(repo);
    await repo.markStatus(t.id, 'RUNNING');
    await repo.markStatus(t.id, 'COMPLETED');
    await repo.markStatus(t.id, 'RUNNING'); // 重放的旧回调
    assert.equal((await repo.get(t.id))!.status, 'COMPLETED');
  });

  it('FAILED 同样为终态', async () => {
    const repo = new MemoryTaskRepository();
    const t = await createTask(repo);
    await repo.markStatus(t.id, 'FAILED', 'boom');
    await repo.markStatus(t.id, 'RUNNING');
    const got = await repo.get(t.id);
    assert.equal(got!.status, 'FAILED');
    assert.equal(got!.error, 'boom');
  });

  it('非终态之间可自由流转，error 只在传入时写入', async () => {
    const repo = new MemoryTaskRepository();
    const t = await createTask(repo);
    await repo.markStatus(t.id, 'PENDING', 'old-error');
    await repo.markStatus(t.id, 'RUNNING');
    const got = await repo.get(t.id);
    assert.equal(got!.status, 'RUNNING');
    assert.equal(got!.error, 'old-error');
  });

  it('mergeCheckpoint 合并而不整体覆盖', async () => {
    const repo = new MemoryTaskRepository();
    const t = await createTask(repo);
    await repo.mergeCheckpoint(t.id, { remoteTasks: { 'shot-0': 'r1' }, completedStages: ['DETECT'], completedShots: [0] });
    await repo.mergeCheckpoint(t.id, { remoteTasks: { 'shot-1': 'r2' }, completedStages: ['ANALYZE'], completedShots: [1] });
    const got = await repo.get(t.id);
    assert.deepEqual(got!.checkpoint!.remoteTasks, { 'shot-0': 'r1', 'shot-1': 'r2' });
    assert.deepEqual(got!.checkpoint!.completedStages, ['DETECT', 'ANALYZE']);
    assert.deepEqual(got!.checkpoint!.completedShots, [0, 1]);
  });

  it('list 按创建时间倒序', async () => {
    const repo = new MemoryTaskRepository();
    const a = await createTask(repo);
    await new Promise((r) => setTimeout(r, 5)); // createdAt 精度为 ms，避免同时刻排序不稳定
    const b = await createTask(repo);
    const list = await repo.list();
    assert.equal(list[0]!.id, b.id);
    assert.equal(list[1]!.id, a.id);
  });

  it('不存在的任务返回 undefined', async () => {
    const repo = new MemoryTaskRepository();
    assert.equal(await repo.get('nope'), undefined);
    assert.equal(await repo.advanceStage('nope', 'DETECT'), undefined);
    assert.equal(await repo.markStatus('nope', 'RUNNING'), undefined);
  });

  it('name 缺省时以创建时间命名（YYYYMMDD-HHmm）', async () => {
    const repo = new MemoryTaskRepository();
    const t = await createTask(repo);
    assert.ok(/^\d{8}-\d{4}$/.test(t.name ?? ''), `默认名格式: ${t.name}`);
    // 与工具函数结果一致（同一分钟）
    assert.equal(t.name, formatTaskName(t.createdAt));
  });

  it('name 显式指定时去首尾空格后原样保留', async () => {
    const repo = new MemoryTaskRepository();
    const t = await repo.create({
      name: '  我的任务  ',
      maxDurationSeconds: 60,
      normalizeSize: 512,
      outputResolution: '720p',
    });
    assert.equal(t.name, '我的任务');
  });

  it('markStatus 终态写入 completedAt；终态重放不覆盖', async () => {
    const repo = new MemoryTaskRepository();
    const t = await createTask(repo);
    assert.equal(t.completedAt, undefined);
    assert.equal((await repo.markStatus(t.id, 'RUNNING'))?.completedAt, undefined, '非终态不写结束时间');
    const done = await repo.markStatus(t.id, 'COMPLETED');
    assert.ok(done?.completedAt);
    await new Promise((r) => setTimeout(r, 5));
    const replayed = await repo.markStatus(t.id, 'FAILED');
    assert.equal(replayed?.completedAt, done!.completedAt, '终态重放不覆盖结束时间');
    assert.equal(replayed?.status, 'COMPLETED', '终态不可被覆盖');
  });
});

describe('formatTaskName', () => {
  it('格式为 YYYYMMDD-HHmm（两位数补零）', () => {
    assert.equal(formatTaskName(new Date(2026, 8, 25, 9, 5).getTime()), '20260925-0905');
  });
});

describe('FsObjectStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hypitapp-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('put 落盘并返回 file:// URL', async () => {
    const store = new FsObjectStore(dir);
    const url = await store.put('tasks/t1/final.mp4', 'video-bytes', 'video/mp4');
    assert.ok(url.startsWith('file:'));
    assert.equal(store.getUrl('tasks/t1/final.mp4'), url);
  });

  it('拒绝 .. 逃逸的 key', async () => {
    const store = new FsObjectStore(dir);
    await assert.rejects(() => store.put('../escape.mp4', 'x'), /escapes store root/);
    assert.throws(() => store.getUrl('../escape.mp4'), /escapes store root/);
  });

  it('delete 支持前缀删除', async () => {
    const store = new FsObjectStore(dir);
    await store.put('tasks/t1/a.mp4', 'a');
    await store.put('tasks/t2/b.mp4', 'b');
    await store.delete('tasks/t1');
    await store.delete('tasks/t1/a.mp4');
    await store.delete('no-such-prefix');
  });

  it('get 返回对象本体与元数据', async () => {
    const store = new FsObjectStore(dir);
    await store.put('tasks/t1/final.mp4', 'video-bytes', 'video/mp4');
    const body = await store.get('tasks/t1/final.mp4');
    assert.ok(body);
    assert.equal(body!.key, 'tasks/t1/final.mp4');
    assert.equal(body!.size, 'video-bytes'.length);
    assert.ok(body!.lastModified);
    const text = await body!.text();
    assert.equal(text, 'video-bytes');
  });

  it('get 不存在的 key 返回 null', async () => {
    const store = new FsObjectStore(dir);
    assert.equal(await store.get('no-such-key'), null);
  });

  it('list 返回对象（无分隔符时递归）', async () => {
    const store = new FsObjectStore(dir);
    await store.put('tasks/t1/a.mp4', 'a');
    await store.put('tasks/t2/b.mp4', 'b');
    const result = await store.list({ prefix: 'tasks/' });
    assert.equal(result.objects.length, 2);
    assert.equal(result.delimitedPrefixes.length, 0);
  });

  it('list 使用分隔符时返回虚拟目录', async () => {
    const store = new FsObjectStore(dir);
    await store.put('tasks/t1/a.mp4', 'a');
    await store.put('tasks/t2/b.mp4', 'b');
    await store.put('tasks/notes.txt', 'notes');
    const result = await store.list({ prefix: 'tasks/', delimiter: '/' });
    assert.equal(result.delimitedPrefixes.length, 2);
    assert.ok(result.delimitedPrefixes.includes('tasks/t1/'));
    assert.ok(result.delimitedPrefixes.includes('tasks/t2/'));
    assert.equal(result.objects.length, 1);
    assert.equal(result.objects[0]!.key, 'tasks/notes.txt');
  });

  it('list 空目录返回空结果', async () => {
    const store = new FsObjectStore(dir);
    const result = await store.list({ prefix: 'no-such-dir/' });
    assert.equal(result.objects.length, 0);
    assert.equal(result.delimitedPrefixes.length, 0);
  });

  it('createDirectory 创建目录标记', async () => {
    const store = new FsObjectStore(dir);
    await store.createDirectory('tasks/t1/');
    const result = await store.list({ prefix: 'tasks/', delimiter: '/' });
    assert.ok(result.delimitedPrefixes.includes('tasks/t1/'));
  });
});

describe('MemoryObjectStore', () => {
  it('put 并返回 memory:// URL', async () => {
    const store = new MemoryObjectStore();
    const url = await store.put('test/file.txt', 'hello');
    assert.equal(url, 'memory://test/file.txt');
  });

  it('get 返回对象本体与元数据', async () => {
    const store = new MemoryObjectStore();
    await store.put('test/file.txt', 'hello', 'text/plain');
    const body = await store.get('test/file.txt');
    assert.ok(body);
    assert.equal(body!.key, 'test/file.txt');
    assert.equal(body!.size, 5);
    assert.equal(body!.contentType, 'text/plain');
    assert.equal(await body!.text(), 'hello');
  });

  it('get 不存在的 key 返回 null', async () => {
    const store = new MemoryObjectStore();
    assert.equal(await store.get('no-such-key'), null);
  });

  it('list 返回对象（无分隔符时递归）', async () => {
    const store = new MemoryObjectStore();
    await store.put('tasks/t1/a.mp4', 'a');
    await store.put('tasks/t2/b.mp4', 'b');
    const result = await store.list({ prefix: 'tasks/' });
    assert.equal(result.objects.length, 2);
    assert.equal(result.delimitedPrefixes.length, 0);
  });

  it('list 使用分隔符时返回虚拟目录', async () => {
    const store = new MemoryObjectStore();
    await store.put('tasks/t1/a.mp4', 'a');
    await store.put('tasks/t2/b.mp4', 'b');
    await store.put('tasks/notes.txt', 'notes');
    const result = await store.list({ prefix: 'tasks/', delimiter: '/' });
    assert.equal(result.delimitedPrefixes.length, 2);
    assert.ok(result.delimitedPrefixes.includes('tasks/t1/'));
    assert.ok(result.delimitedPrefixes.includes('tasks/t2/'));
    assert.equal(result.objects.length, 1);
    assert.equal(result.objects[0]!.key, 'tasks/notes.txt');
  });

  it('createDirectory 创建目录标记', async () => {
    const store = new MemoryObjectStore();
    await store.createDirectory('tasks/t1/');
    const result = await store.list({ prefix: 'tasks/', delimiter: '/' });
    assert.ok(result.delimitedPrefixes.includes('tasks/t1/'));
  });

  it('delete 支持前缀删除', async () => {
    const store = new MemoryObjectStore();
    await store.put('tasks/t1/a.mp4', 'a');
    await store.put('tasks/t2/b.mp4', 'b');
    await store.delete('tasks/t1');
    const result = await store.list({ prefix: 'tasks/' });
    assert.equal(result.objects.length, 1);
    assert.equal(result.objects[0]!.key, 'tasks/t2/b.mp4');
  });
});
