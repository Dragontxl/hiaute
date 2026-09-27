/**
 * 一次性补传脚本：把 GHA artifact zip 里的 final.mp4 分片重传到 R2 对应项目目录。
 *
 * 用法：
 *   node scripts/reupload-artifact.mjs <artifactId> <r2Prefix> [fileName]
 *
 * 环境变量：
 *   GITHUB_TOKEN           GitHub PAT（下载 artifact）
 *   HYPITAPP_API_TOKEN     控制面 Bearer token（上传）
 *   HYPITAPP_URL           控制面地址（默认 https://hypitapp.ygtxl.dpdns.org）
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const [artifactId, r2Prefix, fileNameArg] = process.argv.slice(2);
const FILE_NAME = fileNameArg || 'final.mp4';
const API = (process.env.HYPITAPP_URL || 'https://hypitapp.ygtxl.dpdns.org').replace(/\/$/, '');
const TOKEN = process.env.HYPITAPP_API_TOKEN || '';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';

if (!artifactId || !r2Prefix || !TOKEN || !GH_TOKEN) {
  console.error('用法: node scripts/reupload-artifact.mjs <artifactId> <r2Prefix> [fileName]');
  console.error('需设置环境变量 GITHUB_TOKEN 与 HYPITAPP_API_TOKEN');
  process.exit(1);
}

const work = mkdirSync(join(tmpdir(), `reup-${artifactId}`), { recursive: true });
const zipPath = join(work, 'artifact.zip');
const CHUNK = 50 * 1024 * 1024;

/** 跟随重定向下载到文件：第一跳带 GH token（GitHub API），之后去掉 Authorization（Azure 签名 URL 自带凭据）。 */
async function downloadZip() {
  const r1 = await fetch(`https://api.github.com/repos/Dragontxl/hiaute/actions/artifacts/${artifactId}/zip`, {
    headers: { authorization: 'token ' + GH_TOKEN, 'user-agent': 'hypitapp-reupload', accept: 'application/vnd.github+json' },
    redirect: 'manual',
  });
  const loc = r1.headers.get('location');
  if (![301, 302, 307, 308].includes(r1.status) || !loc) {
    throw new Error(`GitHub artifact 响应 ${r1.status}: ${(await r1.text()).slice(0, 300)}`);
  }
  console.log('签名下载地址就绪，开始下载…');
  const r2 = await fetch(loc, { redirect: 'follow' });
  if (!r2.ok || !r2.body) throw new Error(`下载失败 HTTP ${r2.status}`);
  const buf = Buffer.from(await r2.arrayBuffer());
  writeFileSync(zipPath, buf);
  console.log('artifact 下载完成:', buf.length, 'bytes');
}

function extractFinalMp4() {
  const outDir = join(work, 'out');
  mkdirSync(outDir, { recursive: true });
  const script = `import zipfile;zipfile.ZipFile(r'${zipPath.replace(/\\/g, '/')}').extractall(r'${outDir.replace(/\\/g, '/')}')`;
  execSync(`python -c "${script}"`);
  const stack = [outDir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { stack.push(p); continue; }
      if (e.endsWith('.mp4') && /final/i.test(e)) return p;
    }
  }
  return null;
}

/** 手写 multipart 上传一片。 */
function uploadChunk(prefix, fileName, chunkIdx, totalChunks, partBuf) {
  return new Promise((resolve, reject) => {
    const boundary = '----hypit' + Date.now() + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="prefix"\r\n\r\n${prefix}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${fileName}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="chunk"\r\n\r\n${chunkIdx}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="totalChunks"\r\n\r\n${totalChunks}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="part.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, partBuf, tail]);
    const u = new URL(API + '/api/v1/files/upload');
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function uploadChunks(filePath) {
  const bytes = statSync(filePath).size;
  const data = readFileSync(filePath);
  const total = Math.ceil(bytes / CHUNK);
  console.log(`分片上传 ${FILE_NAME}: ${bytes} bytes, ${total} 片`);
  for (let i = 0; i < total; i += 1) {
    const part = data.subarray(i * CHUNK, Math.min(bytes, (i + 1) * CHUNK));
    const r = await uploadChunk(r2Prefix, FILE_NAME, i, total, part);
    const j = JSON.parse(r.body || '{}');
    if (r.status !== 201) {
      console.error(`分片 ${i + 1}/${total} 失败 ${r.status}:`, r.body.slice(0, 200));
      process.exit(1);
    }
    console.log(`分片 ${i + 1}/${total} ok${j.merged ? '（已合并）' : ''}`);
  }
  console.log('上传完成. R2 key:', r2Prefix + FILE_NAME);
}

try {
  await downloadZip();
  const mp4 = extractFinalMp4();
  if (!mp4) { console.error('artifact zip 中未找到 final.mp4'); process.exit(1); }
  console.log('final.mp4:', mp4, statSync(mp4).size, 'bytes');
  await uploadChunks(mp4);
} catch (e) {
  console.error('失败:', e.message);
  process.exit(1);
}