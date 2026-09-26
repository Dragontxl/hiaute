import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  downloadReference,
  isHttpUrl,
  resetYtDlpCache,
  setYtDlpPathForTest,
} from '../src/pipeline/download.js';

describe('isHttpUrl', () => {
  it('接受 http/https 链接', () => {
    assert.equal(isHttpUrl('https://www.bilibili.com/video/BV1xx'), true);
    assert.equal(isHttpUrl('http://example.com/a.mp4'), true);
    assert.equal(isHttpUrl('  https://example.com/x  '), true);
  });

  it('拒绝本地路径与 Windows 盘符（不会被误当链接）', () => {
    assert.equal(isHttpUrl('c:\\clip.mp4'), false);
    assert.equal(isHttpUrl('/tmp/clip.mp4'), false);
    assert.equal(isHttpUrl('references/source.mp4'), false);
    assert.equal(isHttpUrl('ftp://example.com/x'), false);
    assert.equal(isHttpUrl('not a url'), false);
  });
});

describe('downloadReference（直链 fetch 回退）', () => {
  let server: Server;
  let base: string;
  let dir: string;
  const payload = Buffer.from('fake-video-bytes-0123456789');

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hypitapp-dl-'));
    server = createServer((req, res) => {
      if (req.url === '/ok.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end(payload);
      } else if (req.url === '/missing') {
        res.writeHead(404);
        res.end('nope');
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>bilibili page</html>');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
    resetYtDlpCache();
  });

  it('yt-dlp 不可用时，直链经 fetch 落盘并返回字节数', async () => {
    setYtDlpPathForTest(null);
    const dest = join(dir, 'ref.mp4');
    const bytes = await downloadReference(`${base}/ok.mp4`, dest);
    assert.equal(bytes, payload.length);
    assert.deepEqual(await readFile(dest), payload);
  });

  it('HTTP 404 抛出错误', async () => {
    setYtDlpPathForTest(null);
    await assert.rejects(
      () => downloadReference(`${base}/missing`, join(dir, 'x.mp4')),
      /HTTP 404/,
    );
  });

  it('maxBytes 超限时抛错', async () => {
    setYtDlpPathForTest(null);
    await assert.rejects(
      () => downloadReference(`${base}/ok.mp4`, join(dir, 'y.mp4'), { maxBytes: 5 }),
      /exceeds limit/,
    );
  });

  it('非 http(s) 输入直接拒绝', async () => {
    await assert.rejects(() => downloadReference('c:\\clip.mp4', join(dir, 'z.mp4')), /not an http/);
  });
});