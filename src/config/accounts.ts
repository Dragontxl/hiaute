/**
 * 账户配置装载（依 V2 §7.5 / §12）
 *
 * 从 hypit.runtime.json 的 endpoints.<name>.config.accounts 读取账户数组，
 * 从环境变量或 credential store 解析 apiKey，加密后落入运行期账户表。
 *
 * 注意：本文件只负责“装载 + 加密”，不做选取逻辑（选取见 accountPool.ts）。
 */
import { readFile } from 'node:fs/promises';
import { encryptSecret } from '../core/crypto.js';
import type { AccountState, ApiType } from '../types/index.js';
import { log } from '../core/logger.js';

interface RawAccount {
  alias: string;
  apiKey?: { store?: string; key?: string };
  priority_weight?: number;
  daily_limit?: number;
  max_concurrent?: number;
  cooldown_seconds?: number;
  model_name?: string;
  base_url?: string;
}

interface RawEndpoint {
  use?: string;
  config?: {
    baseUrl?: string;
    modelName?: string;
    cooldown_seconds?: number;
    accounts?: RawAccount[];
  };
}

export interface RuntimeFile {
  endpoints?: Record<string, RawEndpoint>;
  bindings?: Record<string, string>;
}

/** endpoint 名 -> api_type 映射（约定，可按需改）。 */
function inferApiType(endpointName: string): ApiType {
  const n = endpointName.toLowerCase();
  if (n.includes('gemini')) return 'gemini';
  if (n.includes('video')) return 'agnes-video';
  if (n.includes('image')) return 'agnes-image';
  if (n.includes('edgetts') || n.includes('tts')) return 'edgetts';
  return 'agnes-text';
}

/** 解析 API Key：优先环境变量 HYPIT_<ALIAS>_KEY（大写、非字母数字转 _）。 */
function resolveKey(account: RawAccount): string {
  const envName = `HYPIT_${account.alias.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`;
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  // 占位：真实项目可对接 credential-store-platform
  log.warn('api key not found in env; account will be inactive', { alias: account.alias, envName });
  return '';
}

export async function loadAccounts(
  runtimePath: string,
  masterKey: string,
  dataDir: string,
): Promise<AccountState[]> {
  const raw = JSON.parse(await readFile(runtimePath, 'utf8')) as RuntimeFile;
  const out: AccountState[] = [];
  let idx = 0;
  for (const [name, ep] of Object.entries(raw.endpoints ?? {})) {
    const apiType = inferApiType(name);
    const accounts = ep.config?.accounts ?? [];
    for (const a of accounts) {
      idx += 1;
      const key = resolveKey(a);
      const modelName = a.model_name ?? ep.config?.modelName;
      out.push({
        id: `${apiType}-${idx}`,
        alias: a.alias,
        apiType,
        apiKeyEncrypted: key ? encryptSecret(key, masterKey) : '',
        baseUrl: a.base_url ?? ep.config?.baseUrl ?? '',
        ...(modelName !== undefined ? { modelName } : {}),
        maxConcurrent: a.max_concurrent ?? 1,
        priorityWeight: a.priority_weight ?? 50,
        cooldownSeconds: a.cooldown_seconds ?? ep.config?.cooldown_seconds ?? 60,
        dailyLimit: a.daily_limit ?? 1500,
        isActive: Boolean(key),
        isHealthy: true,
        totalUsage: 0,
        cooldownUntil: null,
      });
    }
  }
  log.info('accounts loaded', { count: out.length, dataDir });
  return out;
}
