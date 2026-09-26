import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildVideoBody, framesFor } from '../src/providers/agnes/index.js';
import type { VideoGenerateInput } from '../src/providers/types.js';

describe('framesFor（v2.0 帧数必须 8n+1 且 ≤441）', () => {
  it('满足 8n+1 与上限约束', () => {
    for (const sec of [1, 3, 5, 8, 10, 12, 18, 100, 1000]) {
      const f = framesFor(sec, 24);
      assert.equal((f - 1) % 8, 0, `sec=${sec} frames=${f} 不是 8n+1`);
      assert.ok(f >= 1 && f <= 441, `sec=${sec} frames=${f} 超范围`);
    }
  });

  it('贴近目标秒数（文档推荐值）', () => {
    assert.equal(framesFor(5, 24), 121); // 5.04s
    assert.equal(framesFor(10, 24), 241); // 10.04s
    // 18s 目标：nearest 是 433（18.04s），仍在 441 内
    assert.equal(framesFor(18, 24), 433);
  });

  it('超长目标被夹到上限 441', () => {
    assert.equal(framesFor(1000, 24), 441);
  });

  it('非法输入不产生负帧', () => {
    assert.ok(framesFor(0, 24) >= 1);
    assert.ok(framesFor(-5, 24) >= 1);
  });
});

describe('buildVideoBody（两代视频模型字段隔离）', () => {
  const base: VideoGenerateInput = { prompt: 'a cat', seconds: 10, resolution: '720p' };

  it('2.5 系列用 seconds/size/aspect_ratio，不含 num_frames', () => {
    const b = buildVideoBody('agnes-video-2.5-flash', base);
    assert.equal(b.mode, 'text');
    assert.equal(b.seconds, '10');
    assert.equal(b.size, '720P');
    assert.equal(b.aspect_ratio, '16:9');
    assert.equal(b.num_frames, undefined);
  });

  it('v2.0 用 num_frames/frame_rate，不含 seconds（片长不一致的根因）', () => {
    const b = buildVideoBody('agnes-video-v2.0', base);
    assert.equal(b.mode, 'ti2vid');
    assert.equal(b.frame_rate, 24);
    assert.equal(b.num_frames, 241); // 10s@24fps
    assert.equal(b.seconds, undefined);
  });

  it('图生视频：2.5 用 first_frame，v2.0 用 image', () => {
    const img = { ...base, imageUrl: 'https://x/f.jpg' };
    const b25 = buildVideoBody('agnes-video-2.5-flash', img);
    assert.equal(b25.mode, 'keyframe');
    assert.equal(b25.first_frame, 'https://x/f.jpg');
    assert.equal(b25.image, undefined);

    const b20 = buildVideoBody('agnes-video-v2.0', img);
    assert.equal(b20.mode, 'keyframes');
    assert.equal(b20.image, 'https://x/f.jpg');
    assert.equal(b20.first_frame, undefined);
  });
});