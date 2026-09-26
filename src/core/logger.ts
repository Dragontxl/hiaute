/**
 * 结构化日志（依 V2 §7.3：日志禁打印凭证；§8.5 磁盘监控另见 pipeline）
 *
 * 所有输出经 scrub() 脱敏，屏蔽疑似密钥/令牌。
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'INFO';

/** 屏蔽常见密钥/令牌样式，避免误入日志。 */
export function scrub(input: string): string {
  return input
    // OpenAI/Agnes 风格 sk-xxx
    .replace(/\b(sk|pk|api|key|token|bearer)[-_A-Za-z0-9]{6,}\b/gi, '[REDACTED]')
    // GitHub PAT 样式
    .replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}\b/g, '[REDACTED]')
    // 形如 32+ 位 hex/base64 的长串
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]')
    // URL 中的 apiKey / key / token 查询参数
    .replace(/([?&](?:api_?key|key|token)=)[^&\s]+/gi, '$1[REDACTED]');
}

function emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: scrub(msg),
    ...(extra ? { extra: JSON.parse(scrub(JSON.stringify(extra))) } : {}),
  };
  const text = JSON.stringify(line);
  if (level === 'ERROR') console.error(text);
  else console.log(text);
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit('DEBUG', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit('INFO', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('WARN', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('ERROR', msg, extra),
};
