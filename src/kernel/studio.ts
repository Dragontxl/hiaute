/**
 * Hypit Studio 封装（依 V2 方案「生成 → 编辑 → 重出片」闭环）
 *
 * Studio 是 hypit 自带的**官方** Web 编辑器（packages/studio），
 * 它不是一个「一次执行即退出」的 CLI，而是常驻的 Vite 开发服务器：
 *   hypit studio --run build.svrun [--port 5179]
 * 启动后会打印会话 URL（默认 http://localhost:5179）。
 *
 * 因此这里用 spawn（非 execFile），返回一个句柄：{ url, pid, stop() }。
 *
 * 关键约束（务必阅读）：
 * - Studio 必须运行在**常驻**环境。GitHub Actions 的 runner 是一次性 VM，
 *   任务结束即销毁，**无法承载 Studio**。因此「生成后编辑」只适用于：
 *     (a) 本地直跑（形态 A/C），或
 *     (b) 常驻控制面（把 Run Source 拉回本地/常驻机）。
 * - Studio 的浏览器预览是本地编译，**不产生付费生成**；只有再次执行 build 出片才走 Provider。
 * - Source 面板可编辑 `.svml / .svs / .svrun`；评论写入 `<workspace>/FEEDBACK.json`。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { log } from '../core/logger.js';

export interface StudioHandle {
  /** 被编辑的 Run Source（相对 workspace）。 */
  runFile: string;
  /** 会话 URL（Studio 打印；默认 http://localhost:5179）。 */
  url: string;
  pid: number | undefined;
  startedAt: number;
  /** 结束该会话（SIGTERM → 5s 后 SIGKILL）。 */
  stop: () => Promise<void>;
}

export interface StudioOptions {
  /** CLI 可执行名，默认 hypit。 */
  cli: string;
  /** 工作目录（工程边界）。 */
  cwd: string;
  /** Run Source，如 runs/main.svrun 或 build.svrun。 */
  runFile: string;
  /** 端口；缺省时由 Vite 选 5179 或下一个可用端口。 */
  port?: number;
  /** 绑定主机（容器里常用 0.0.0.0）。 */
  host?: string;
}

const URL_RE = /https?:\/\/[^\s"']+/i;
const DEFAULT_START_TIMEOUT_MS = 20_000;

/** Run Source 只允许工程内的相对路径 + 官方脚本扩展名。 */
export const RUN_FILE_RE = /^[\w.-]+(?:[/\\][\w.-]+)*\.(svml|svs|svrun)$/i;

/**
 * 校验 runFile：必须匹配 RUN_FILE_RE，且解析后仍在 cwd 之内。
 * 违反则抛错——runFile 会作为参数交给外部 CLI，必须防止目录穿越。
 */
export function assertRunFile(cwd: string, runFile: string): string {
  if (!RUN_FILE_RE.test(runFile)) {
    throw new Error(`invalid runFile "${runFile}": expected a relative path ending in .svml/.svs/.svrun`);
  }
  const root = resolve(cwd);
  const target = resolve(root, runFile);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`runFile "${runFile}" escapes workspace ${root}`);
  }
  return target;
}

export class StudioManager {
  private sessions = new Map<string, { proc: ChildProcess; handle: StudioHandle }>();

  constructor(private defaults: { cli: string; cwd: string }) {}

  /** 列出当前所有 Studio 会话。 */
  list(): StudioHandle[] {
    return [...this.sessions.values()].map((s) => s.handle);
  }

  get(runFile: string): StudioHandle | undefined {
    return this.sessions.get(runFile)?.handle;
  }

  /**
   * 启动 Studio 并等待其打印会话 URL。
   * 对同一 runFile 的重复调用会**复用**已有会话（Studio 文档：Reuse that process for edits to the same Run）。
   */
  async start(opts: StudioOptions, timeoutMs = DEFAULT_START_TIMEOUT_MS): Promise<StudioHandle> {
    const existing = this.sessions.get(opts.runFile);
    if (existing) {
      log.info('studio reuse existing session', { runFile: opts.runFile, url: existing.handle.url });
      return existing.handle;
    }

    const cli = opts.cli || this.defaults.cli;
    const cwd = opts.cwd || this.defaults.cwd;
    const args = ['studio', '--run', assertRunFile(cwd, opts.runFile)];
    if (typeof opts.port === 'number') args.push('--port', String(opts.port));
    if (opts.host) args.push('--host', opts.host);

    log.info('studio spawn', { args: args.join(' '), cwd });
    const proc = spawn(cli, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stop = async (): Promise<void> => {
      this.sessions.delete(opts.runFile);
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          proc.kill('SIGKILL');
          res();
        }, 5000);
        proc.once('exit', () => {
          clearTimeout(t);
          res();
        });
      });
    };

    const handle: StudioHandle = {
      runFile: opts.runFile,
      url: '',
      pid: proc.pid,
      startedAt: Date.now(),
      stop,
    };

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void stop();
        reject(new Error(`studio start timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const onData = (buf: Buffer): void => {
        const text = buf.toString();
        log.info('studio output', { line: text.trim().slice(0, 300) });
        if (!handle.url) {
          const m = text.match(URL_RE);
          const found = m?.[0];
          if (found) {
            handle.url = found.replace(/\/$/, '');
            clearTimeout(timer);
            resolve();
          }
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        this.sessions.delete(opts.runFile);
        reject(new Error(`studio exited early with code ${code ?? 'null'}`));
      });
    });

    this.sessions.set(opts.runFile, { proc, handle });
    log.info('studio ready', { runFile: opts.runFile, url: handle.url, pid: handle.pid });
    return handle;
  }

  /** 结束指定 Run 的会话；不存在则返回 false。 */
  async stop(runFile: string): Promise<boolean> {
    const s = this.sessions.get(runFile);
    if (!s) return false;
    await s.handle.stop();
    return true;
  }

  /** 结束全部会话（用于进程退出优雅关闭）。 */
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((k) => this.stop(k)));
  }
}
