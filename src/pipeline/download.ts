/**
 * 参考视频下载（多网站支持）。
 *
 * 背景：参考链接往往不是直链而是视频页面（B 站 / YouTube / TikTok / Instagram …）。
 * 裸 `fetch` 只能下直链，对页面 URL 会拿到 HTML。这里优先用 `yt-dlp` 解析并下载
 * （覆盖上千站点），`yt-dlp` 不可用时退回直链 `fetch`。
 *
 * 该能力原先存在于 `hypit-main` 的 `@hypit/yt-dlp` 包（`services/yt-dlp` 固定版本 +
 * `hypit media fetch`），重构为 Hypitapp 时未保留；此模块恢复其核心行为：
 *  - 只对 http/https 视为链接（Windows 盘符 `c:\...` 不会被误判）；
 *  - 视频 + 音频一起取并 mux（站点普遍音视频分离，只取最佳单流会没有声音）；
 *  - 优先 H.264 / 1080p，但只是偏好不强制（避免源站无此档直接失败）；
 *  - `--no-playlist` 防止播放列表被整页拉取；
 *  - 先落到系统临时目录再移动到目标，跨卷 EXDEV 时改为复制。
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { log } from '../core/logger.js';

const run = promisify(execFile);

/** 仅 http/https 视为可下载链接（排除本地路径与 Windows 盘符）。 */
export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** yt-dlp 常见安装位置（PATH 之外的兜底，覆盖 GHA / pipx / 用户级安装）。 */
function ytDlpFallbacks(): string[] {
  return [
    'yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    join(homedir(), '.local', 'bin', 'yt-dlp'),
    join(homedir(), '.local', 'bin', 'yt-dlp.exe'),
  ];
}

let ytDlpCache: string | null | undefined;

/** 解析可用的 yt-dlp 路径（结果缓存）；找不到返回 null。yt-dlp 用 `--version` 探测。 */
export async function resolveYtDlp(): Promise<string | null> {
  if (ytDlpCache !== undefined) return ytDlpCache;
  let found: string | null = null;
  for (const candidate of ytDlpFallbacks()) {
    try {
      await run(candidate, ['--version'], { timeout: 15_000 });
      found = candidate;
      break;
    } catch {
      /* 试下一个 */
    }
  }
  if (!found) log.warn('yt-dlp not found; falling back to plain fetch (page URLs will fail)');
  else log.info('yt-dlp resolved', { path: found });
  ytDlpCache = found;
  return found;
}

/** 测试用：重置 yt-dlp 解析缓存。 */
export function resetYtDlpCache(): void {
  ytDlpCache = undefined;
}

/** 测试用：直接设定 yt-dlp 路径（null 表示不可用），跳过探测。 */
export function setYtDlpPathForTest(path: string | null): void {
  ytDlpCache = path;
}

export interface DownloadOptions {
  /** 目标文件字节数上限（下载后校验，超限抛错）。 */
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 用 yt-dlp 下载并转封装到目标文件；返回字节数。 */
async function downloadViaYtDlp(binary: string, url: string, dest: string, opts: DownloadOptions): Promise<number> {
  const container = (extname(dest).slice(1).toLowerCase() || 'mp4');
  const allowed = ['mp4', 'mkv', 'webm', 'mov'];
  const finalContainer = allowed.includes(container) ? container : 'mp4';
  const work = await mkdtemp(join(tmpdir(), 'hypit-fetch-'));
  try {
    try {
      await run(
        binary,
        [
          '--ignore-config',
          '--no-update',
          '--no-remote-components',
          '--no-plugin-dirs',
          '--no-playlist',
          '--no-progress',
          '--quiet',
          '--format',
          'bv*+ba/b',
          '--merge-output-format',
          finalContainer,
          '--format-sort',
          'res:1080,vcodec:h264',
          '--output',
          join(work, 'video.%(ext)s'),
          url,
        ],
        {
          timeout: opts.timeoutMs ?? 15 * 60_000,
          maxBuffer: 10 * 1024 * 1024,
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
      );
    } catch (cause) {
      if (opts.signal?.aborted) throw cause;
      const err = cause as { stderr?: string; message?: string };
      const detail = (err.stderr ?? err.message ?? '').trim().slice(-2000);
      throw new Error(`yt-dlp could not fetch ${url}: ${detail}`);
    }
    const finished = (await readdir(work)).filter((name) => !name.endsWith('.part'));
    const file = finished.sort()[0];
    if (file === undefined) throw new Error(`yt-dlp reported success for ${url} but wrote no file`);
    const staged = join(work, file);
    const size = (await stat(staged)).size;
    try {
      await rename(staged, dest);
    } catch (cause) {
      // 临时目录常与项目不同卷，rename 不能跨卷；EXDEV 时改为复制
      if ((cause as NodeJS.ErrnoException).code !== 'EXDEV') throw cause;
      await copyFile(staged, dest);
    }
    return size;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** 直链下载（无 yt-dlp 时的回退，仅适用于真实媒体文件 URL）。 */
async function downloadViaFetch(url: string, dest: string, opts: DownloadOptions): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const controller = new AbortController();
  const signal = opts.signal ?? controller.signal;
  const timer = opts.signal ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    if (!res.body) throw new Error('download failed: empty response body');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('download failed: zero bytes');
    await writeFile(dest, buf);
    return buf.length;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 下载参考视频到本地文件；返回字节数。
 *
 * 优先 yt-dlp（支持视频页面），不可用时退回直链 fetch。`maxBytes` 非空时在下载后校验。
 */
export async function downloadReference(url: string, dest: string, opts: DownloadOptions = {}): Promise<number> {
  if (!isHttpUrl(url)) throw new Error(`not an http(s) url: ${url}`);
  const ytDlp = await resolveYtDlp();
  const bytes = ytDlp
    ? await downloadViaYtDlp(ytDlp, url, dest, opts)
    : await downloadViaFetch(url, dest, opts);
  if (opts.maxBytes !== undefined && bytes > opts.maxBytes) {
    throw new Error(`downloaded ${bytes} bytes exceeds limit ${opts.maxBytes}`);
  }
  log.info('reference downloaded', { url: url.slice(0, 120), bytes, via: ytDlp ? 'yt-dlp' : 'fetch' });
  return bytes;
}