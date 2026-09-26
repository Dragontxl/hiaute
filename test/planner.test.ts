import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { largestRemainder, planShotDurations } from '../src/planner/index.js';
import type { VideoAnalysis } from '../src/types/index.js';

function shots(seconds: number[], startIndex = 0): VideoAnalysis {
  let cursor = 0;
  return {
    summary: 'test',
    shots: seconds.map((s, i) => {
      const startSec = cursor;
      cursor += s;
      return { index: startIndex + i, startSec, endSec: cursor, description: `shot ${i}` };
    }),
  };
}

describe('largestRemainder', () => {
  it('总和严格等于 total', () => {
    for (const total of [1, 5, 17, 180]) {
      for (const weights of [[1, 1, 1], [1, 2, 3], [0, 5, 0], [7, 0, 7, 0, 7]]) {
        const out = largestRemainder(total, weights);
        assert.equal(out.length, weights.length);
        assert.equal(out.reduce((s, v) => s + v, 0), total, `total=${total} weights=${weights}`);
      }
    }
  });

  it('权重全为 0 时等分', () => {
    const out = largestRemainder(10, [0, 0, 0]);
    assert.deepEqual(out, [4, 3, 3]);
  });

  it('空权重返回空数组', () => {
    assert.deepEqual(largestRemainder(30, []), []);
  });
});

describe('planShotDurations', () => {
  const cap = 18;

  it('每条时长不超过官方上限，且总和等于目标时长', () => {
    const d = planShotDurations(shots([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]), 180, cap);
    assert.equal(d.reduce((s, v) => s + v, 0), 180);
    for (const v of d) assert.ok(v >= 1 && v <= cap, `duration ${v} out of range`);
  });

  it('分镜数超过 maxShots 时合并到 maxShots 条', () => {
    const analysis = shots(Array.from({ length: 40 }, (_, i) => i + 1));
    const d = planShotDurations(analysis, 180, cap, { maxShots: 10 });
    assert.equal(d.length, 10);
    assert.equal(d.reduce((s, v) => s + v, 0), 180);
    for (const v of d) assert.ok(v <= cap);
  });

  it('分镜过少时自动细分，保证单条不超 cap', () => {
    // 2 个分镜但目标 180s：等分会得到 90s/条，必须细分到至少 ceil(180/18)=10 条
    const d = planShotDurations(shots([90, 90]), 180, cap);
    assert.ok(d.length >= Math.ceil(180 / cap));
    assert.equal(d.reduce((s, v) => s + v, 0), 180);
    for (const v of d) assert.ok(v <= cap);
  });

  it('无分析结果时按等分铺满目标时长', () => {
    const d = planShotDurations(undefined, 60, cap, { maxShots: 10 });
    assert.equal(d.reduce((s, v) => s + v, 0), 60);
    for (const v of d) assert.ok(v >= 1 && v <= cap);
  });

  it('targetSeconds 小于分镜数时每条至少 1s 且不超目标', () => {
    const d = planShotDurations(shots(Array.from({ length: 30 }, () => 3)), 25, cap, { maxShots: 20 });
    assert.equal(d.reduce((s, v) => s + v, 0), 25);
    for (const v of d) assert.ok(v >= 1);
  });

  it('非法输入被夹取为正数', () => {
    const d = planShotDurations(undefined, 0, 0, { maxShots: 0 });
    assert.ok(d.length >= 1);
    assert.ok(d.reduce((s, v) => s + v, 0) >= 1);
  });
});
