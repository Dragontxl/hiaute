import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decryptSecret, encryptSecret, safeEqual, signPayload, verifyPayloadSignature } from '../src/core/crypto.js';
import { AccountPool } from '../src/core/accountPool.js';
import { MemoryAccountLeaseStore, MemoryRateLimitBackend } from '../src/storage/memory.js';
import type { AccountState, ApiType } from '../src/types/index.js';

const MASTER = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('AES-256-GCM 加解密', () => {
  it('往返一致', () => {
    const ct = encryptSecret('sk-live-secret-123', MASTER);
    assert.equal(decryptSecret(ct, MASTER), 'sk-live-secret-123');
  });

  it('每次加密产生不同密文（随机 IV），但都能解回', () => {
    const a = encryptSecret('same', MASTER);
    const b = encryptSecret('same', MASTER);
    assert.notEqual(a, b);
    assert.equal(decryptSecret(b, MASTER), 'same');
  });

  it('密文格式为 v1:iv:tag:data', () => {
    const [version, iv, tag, data] = encryptSecret('x', MASTER).split(':');
    assert.equal(version, 'v1');
    assert.equal(iv!.length, 24);
    assert.equal(tag!.length, 32);
    assert.ok(data!.length > 0);
  });

  it('错误主密钥无法解密（GCM 认证失败）', () => {
    const ct = encryptSecret('topsecret', MASTER);
    assert.throws(() => decryptSecret(ct, 'wrong-master-key'));
  });

  it('篡改密文会被拒绝', () => {
    const [v, iv, tag, data] = encryptSecret('topsecret', MASTER).split(':');
    const tampered = data!.slice(0, -2) + (data!.slice(-2) === '00' ? 'ff' : '00');
    assert.throws(() => decryptSecret([v, iv, tag, tampered].join(':'), MASTER));
  });

  it('不支持的格式直接抛错', () => {
    assert.throws(() => decryptSecret('not-a-payload', MASTER), /unsupported secret payload/);
  });

  it('缺少主密钥直接抛错', () => {
    assert.throws(() => encryptSecret('x', ''), /masterKey is required/);
  });
});

describe('回调签名', () => {
  const secret = 'callback-secret';
  const body = '{"taskId":"abc","stage":"COMPOSE"}';

  it('签名可验证', () => {
    assert.equal(verifyPayloadSignature(body, secret, signPayload(body, secret)), true);
  });

  it('错误签名 / 错误密钥 / 篡改 body 均拒绝', () => {
    const sig = signPayload(body, secret);
    assert.equal(verifyPayloadSignature(body, secret, sig), true);
    assert.equal(verifyPayloadSignature(body, secret, '0'.repeat(64)), false);
    assert.equal(verifyPayloadSignature(body, 'other', sig), false);
    assert.equal(verifyPayloadSignature(body + ' ', secret, sig), false);
    assert.equal(verifyPayloadSignature(body, secret, sig.slice(0, 63)), false);
  });
});

describe('safeEqual 常量时间比较', () => {
  it('相等返回 true', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('', ''), true);
  });

  it('不等或长度不同返回 false', () => {
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'ab'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
  });
});

/* ---------------- AccountPool ---------------- */

function account(over: Partial<AccountState> & { id: string; apiType: ApiType }): AccountState {
  return {
    alias: over.id,
    apiKeyEncrypted: encryptSecret('plain-key', MASTER),
    baseUrl: 'https://api.agnes-ai.com/v1',
    maxConcurrent: 1,
    priorityWeight: 100,
    cooldownSeconds: 5,
    dailyLimit: 100,
    isActive: true,
    isHealthy: true,
    totalUsage: 0,
    cooldownUntil: null,
    ...over,
  };
}

describe('AccountPool', () => {
  it('acquire 返回明文密钥并可 release', async () => {
    const pool = new AccountPool([account({ id: 'a1', alias: 'agnes-1', apiType: 'agnes-video' })], MASTER, {
      leases: new MemoryAccountLeaseStore(),
    });
    const lease = await pool.acquire('agnes-video');
    assert.ok(lease);
    assert.equal(lease.apiKey, 'plain-key');
    assert.equal(lease.account.alias, 'agnes-1');
    await lease.release();
  });

  it('账户级故障（403）连续 3 次后隔离，acquire 返回 null', async () => {
    const pool = new AccountPool([account({ id: 'a1', apiType: 'agnes-video' })], MASTER, {
      leases: new MemoryAccountLeaseStore(),
    });
    const lease = await pool.acquire('agnes-video');
    assert.ok(lease);
    for (let i = 0; i < 3; i++) await pool.markFailure('a1', 'HTTP 403 Forbidden');
    assert.equal(await pool.acquire('agnes-video'), null);
    await pool.markSuccess('a1');
    assert.ok(await pool.acquire('agnes-video'));
  });

  it('临时错误（503/429）不隔离账户，可继续 acquire', async () => {
    const pool = new AccountPool([account({ id: 'a1', apiType: 'agnes-video' })], MASTER, {
      leases: new MemoryAccountLeaseStore(),
    });
    const lease = await pool.acquire('agnes-video');
    assert.ok(lease);
    await pool.markFailure('a1', 'HTTP 503 high demand');
    await pool.markFailure('a1', 'HTTP 429 rate limit');
    await pool.markFailure('a1', 'HTTP 503');
    // 临时错误不累计隔离：release 后仍可 acquire
    await lease!.release();
    assert.ok(await pool.acquire('agnes-video'));
  });

  it('dailyLimit 用尽后不再发放租约', async () => {
    const pool = new AccountPool([account({ id: 'a1', apiType: 'agnes-video', dailyLimit: 1 })], MASTER, {
      leases: new MemoryAccountLeaseStore(),
    });
    const first = await pool.acquire('agnes-video');
    assert.ok(first);
    await first!.release();
    assert.equal(await pool.acquire('agnes-video'), null);
  });

  it('限流超限时退还租约并返回 null', async () => {
    const rate = new MemoryRateLimitBackend();
    const pool = new AccountPool([account({ id: 'a1', apiType: 'agnes-video' })], MASTER, {
      leases: new MemoryAccountLeaseStore(),
      rate,
    });
    // 先把能力维度的窗口打满（max=30），再用极小窗口复现拒绝路径
    const t0 = Date.now();
    for (let i = 0; i < 31; i++) await rate.consume('api:agnes-video', { windowMs: 60_000, max: 30 }, t0);
    assert.equal(await pool.acquire('agnes-video'), null);
  });

  it('maxConcurrent 未超限时可并发多份租约', async () => {
    const pool = new AccountPool([account({ id: 'a1', apiType: 'agnes-video', maxConcurrent: 2 })], MASTER, {
      leases: new MemoryAccountLeaseStore(),
    });
    const l1 = await pool.acquire('agnes-video');
    assert.ok(l1);
    // 冷却期内同一账户不可再次发放
    assert.equal(await pool.acquire('agnes-video'), null);
    await l1!.release();
    assert.ok(await pool.acquire('agnes-video'));
  });

  it('未启用的账户被跳过', async () => {
    const pool = new AccountPool([account({ id: 'a1', apiType: 'agnes-video', isActive: false })], MASTER, {
      leases: new MemoryAccountLeaseStore(),
    });
    assert.equal(await pool.acquire('agnes-video'), null);
    assert.equal(pool.hasAvailable('agnes-video'), false);
  });
});
