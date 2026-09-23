/**
 * 对称加密工具（依 V2 §7.5：API Key 加密入库，运行期解密注入）
 *
 * 使用 Node 内置 crypto 的 AES-256-GCM。
 * - master key 来自环境变量 HYPITAPP_MASTER_KEY（32 字节，hex 或 utf8）。
 * - 密文格式：v1:<iv_hex>:<tag_hex>:<cipher_hex>
 * - 严禁将明文或密文写入日志。
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

/** 将任意长度的主密钥规整为 32 字节。 */
function deriveKey(masterKey: string): Buffer {
  // 若已是 64 位 hex，则直接用；否则用 sha256 派生，保证长度正确。
  if (/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    return Buffer.from(masterKey, 'hex');
  }
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

export function encryptSecret(plain: string, masterKey: string): string {
  if (!masterKey) throw new Error('masterKey is required to encrypt secrets');
  const key = deriveKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

export function decryptSecret(payload: string, masterKey: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('unsupported secret payload format');
  }
  const [, ivHex, tagHex, dataHex] = parts;
  const key = deriveKey(masterKey);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex!, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex!, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex!, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

/** 生成签名（用于回调 X-Callback-Signature，§7.3）。 */
export function signPayload(body: string, secret: string): string {
  return createHash('sha256').update(`${secret}.${body}`).digest('hex');
}

export function verifyPayloadSignature(body: string, secret: string, signature: string): boolean {
  return safeEqual(signPayload(body, secret), signature);
}

/** 常量时间字符串比较，避免时序侧信道（令牌/签名校验共用）。 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
