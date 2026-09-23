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

  /** plan：生成确定性图（build plan）。 */
  async plan(scriptPath: string, planOut: string): Promise<string> {
    return this.exec(['plan', scriptPath, '--out', planOut]);
  }

  /** build：执行渲染/生成。 */
  async build(runFile: string, opts?: { stage?: string }): Promise<string> {
    const args = ['build', runFile];
    if (opts?.stage) args.push('--stage', opts.stage);
    return this.exec(args, 6 * 60 * 60_000); // 6h 上限，与 GHA 对齐
  }

  /** get：取回产物。 */
  async get(kind: string, outDir: string): Promise<string> {
    return this.exec(['get', kind, '--out', outDir]);
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
