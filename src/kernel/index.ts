/**
 * hypit 内核封装（依 V2 §1 / §2 第 ③ 层：内核不改动，仅包装 CLI）
 *
 * 内核命令：plan → build → get；另用 check 做编译校验（§5 必要条件 3）。
 * 本层只做「子进程调用 + 日志 + 错误归一化」，不含任何业务判断。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../core/logger.js';

const run = promisify(execFile);

export interface KernelOptions {
  /** CLI 可执行名，默认 hypit。 */
  cli: string;
  /** 工作目录（任务沙箱）。 */
  cwd: string;
  /** 超时（ms）。 */
  timeoutMs?: number;
}

/** 从 `hypit build --json --follow` 输出里解析 build id（bld_...）。 */
function extractBuildId(out: string): string {
  // 优先解析 --json 机器视图：{ format: "hypit.cli-build@1", build: { id, ... } }
  try {
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed) as { build?: { id?: string } };
        if (parsed.build?.id) return parsed.build.id;
      }
    }
  } catch {
    /* 非 JSON 输出，走正则 */
  }
  const m = out.match(/bld_[0-9A-Za-z_]+/);
  if (m) return m[0];
  throw new Error(`could not extract build id from hypit build output:\n${out.slice(0, 800)}`);
}

export class HypitKernel {
  constructor(private opts: KernelOptions) {}

  /** CLI 是否可用（用于「有内核就强制校验，没有就降级告警」的判断）。 */
  async available(): Promise<boolean> {
    try {
      await run(this.opts.cli, ['--version'], { cwd: this.opts.cwd, timeout: 8_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** 编译校验脚本；失败抛错（供上层重试）。 */
  async check(scriptPath: string): Promise<{ ok: boolean; output: string }> {
    const out = await this.exec(['check', scriptPath]);
    return { ok: true, output: out };
  }

  /** runtime use：选择运行期 Profile（对应 hypit.runtime.json）。 */
  async runtimeUse(profilePath: string): Promise<string> {
    return this.exec(['runtime', 'use', profilePath]);
  }

  /** runtime up：准备本地依赖与渲染 Worker（下载 Chromium 等）。 */
  async runtimeUp(runtime?: string): Promise<string> {
    const args = ['runtime', 'up'];
    if (runtime) args.push('--runtime', runtime);
    return this.exec(args, 30 * 60_000); // 首次下载浏览器可能较久
  }

  /** plan：生成确定性图（build plan）。 */
  async plan(runFile: string): Promise<string> {
    return this.exec(['plan', runFile]);
  }

  /**
   * build：提交构建并等待结果。
   * 返回 build id（从 --json 输出解析）。
   */
  async build(runFile: string, opts?: { title?: string; maxWaitMs?: number }): Promise<string> {
    const args = ['build', runFile, '--json', '--follow'];
    if (opts?.title) args.push('--title', opts.title);
    if (opts?.maxWaitMs !== undefined) args.push('--max-wait-ms', String(opts.maxWaitMs));
    const out = await this.exec(args, 6 * 60 * 60_000); // 6h 上限，与 GHA 对齐
    return extractBuildId(out);
  }

  /** get：取回产物（final.video -> 本地 mp4）。 */
  async get(buildId: string, outputName: string, toPath: string): Promise<string> {
    return this.exec(['get', buildId, '--output', outputName, '--to', toPath]);
  }

  private async exec(args: string[], timeoutMs = this.opts.timeoutMs ?? 10 * 60_000): Promise<string> {
    log.info('kernel exec', { args: args.join(' '), cwd: this.opts.cwd });
    try {
      const { stdout } = await run(this.opts.cli, args, {
        cwd: this.opts.cwd,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const detail = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
      log.error('kernel exec failed', { args: args.join(' '), detail: detail.slice(0, 2000) });
      throw new Error(`hypit ${args[0]} failed: ${detail.slice(0, 500)}`);
    }
  }
}
