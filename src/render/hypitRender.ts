/**
 * hypit 官方模板渲染器（code 模式主路径）。
 *
 * 思路：仓库维护 hypit 官方 code-render 组件（midautumn-scene），
 * LLM planner 已把 brief 展开成逐镜头文字（scriptShots），本模块把它们
 * 填充进任务专属 .svml（每镜一个 midautumn:Scene：渐变夜空+圆月+星星+玉兔+标题淡入），
 * 生成 .svrun，再调 `hypit plan/build/get` 走官方 HyperFrames 渲染（纯本地、零模型成本）。
 *
 * hypit 不可用时上层会降级到 ffmpeg 兜底渲染（pipeline 的 code 分支）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log } from '../core/logger.js';
import type { HypitKernel } from '../kernel/index.js';
import type { ObjectStore } from '../storage/types.js';

/** 单镜头渲染内容（来自 planner 的 scriptShots / brief）。 */
export interface RenderShot {
  title: string;
  subtitle?: string;
}

export interface HypitRenderOptions {
  /** 任务沙箱目录（含 .svml/.svrun）。 */
  workDir: string;
  /** 渲染内容（每镜标题+副标题）。 */
  shots: RenderShot[];
  /** 每镜时长（秒）；求和 = 视频总时长。 */
  secondsPerShot: number[];
  /** 目标文件 key（上传 R2 用），如 tasks/<taskId>/final.mp4。 */
  videoKey: string;
  kernel: HypitKernel;
  store: ObjectStore;
  /** 模板目录；缺省用仓库内置模板。 */
  templateDir?: string;
}

/** 本地渲染成功后返回的产物路径。 */
export interface HypitRenderResult {
  finalPath: string;
  videoKey: string;
  buildId?: string;
}

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function xmlEscape(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => XML_ESCAPE[c] ?? c);
}

/** 各镜结束时间（秒）。 */
export function cumulativeEnds(secondsPerShot: number[]): number[] {
  const ends: number[] = [];
  let acc = 0;
  for (const s of secondsPerShot) {
    acc += s;
    ends.push(acc);
  }
  return ends;
}

export async function renderHypitTask(opts: HypitRenderOptions): Promise<HypitRenderResult> {
  const templateDir = resolve(opts.templateDir ?? join(process.cwd(), 'docker/templates/code-render'));
  const workDir = resolve(opts.workDir);
  const svmlPath = join(workDir, 'author.svml');
  const svsPath = join(workDir, 'main.svs');
  const runPath = join(workDir, 'build.svrun');
  const runtimePath = join(workDir, 'hypit.runtime.json');

  const ends = cumulativeEnds(opts.secondsPerShot);
  const totalSeconds = ends[ends.length - 1] ?? 0;

  // 样式 + runtime 配置从模板目录复制（内容由本任务填充）
  const templateSvs = await readFile(join(templateDir, 'main.svs'), 'utf8');
  const templateRuntime = await readFile(join(templateDir, 'hypit.runtime.json'), 'utf8');

  await mkdir(workDir, { recursive: true });

  // 组装 .svml：每镜一个 midautumn:Scene（时间窗按 start/end 切分）
  const sceneLines: string[] = [];
  opts.shots.forEach((shot, i) => {
    const start = i === 0 ? 0 : ends[i - 1]!;
    const end = ends[i]!;
    const sceneId = `night-${i + 1}`;
    const attrs = [
      `id="${sceneId}"`,
      'timeline={animation.timeline}',
      'canvas={canvas}',
      'font={font}',
      `start="${start}s" end="${end}s"`,
      `title="${xmlEscape(shot.title)}"`,
      ...(shot.subtitle ? [`subtitle="${xmlEscape(shot.subtitle)}"`] : []),
      'rabbit="true"',
    ];
    sceneLines.push(`  <midautumn:Scene ${attrs.join(' ')}/>`);
  });

  const svml = `<?svml using="@hypit/markup@1"?>
<svml>
  <import as="time" from="@hypit/timeline-author@1"/>
  <import as="spatial" from="@hypit/spatial@1"/>
  <import as="fonts" from="@hypit/fonts-open@1"/>
  <import as="midautumn" from="@hypitapp/midautumn-scene@1"/>
  <import as="film" from="@hypit/film@1"/>
  <import as="render" from="@hypit/render-hyperframes@1"/>
  <import as="style" source="./main.svs"/>

  <time:Clock id="clock" frame-rate="30"/>
  <time:Timeline id="animation" clock={clock} end="${totalSeconds}s"/>
  <spatial:Canvas id="canvas" width="1080" height="1920"/>
  <fonts:Stack id="font" family="inter" weight="600" style="normal"/>

${sceneLines.join('\n')}

  <film:Film id="main" canvas={canvas} timeline={animation.timeline} appearance={style.film.main}>
    ${sceneLines.map((_, i) => `<film:Track source={night-${i + 1}.track}/>`).join('\n    ')}
  </film:Film>
  <render:Video id="final" composition={main.composition} timeline={animation.timeline}/>
</svml>
`;

  const svrun = `<?svml using="@hypit/run-markup@1"?>
<svrun version="1">
  <author source="./author.svml"/>
  <target output="final.video"/>
</svrun>
`;

  await writeFile(svmlPath, svml, 'utf8');
  await writeFile(svsPath, templateSvs, 'utf8');
  await writeFile(runPath, svrun, 'utf8');
  await writeFile(runtimePath, templateRuntime, 'utf8');
  await writeFile(join(workDir, 'package.json'), JSON.stringify({ name: 'hypitapp-task', private: true, type: 'module' }, null, 2), 'utf8');

  log.info('hypit task source written', { svmlPath, shots: opts.shots.length, totalSeconds, bytes: Buffer.byteLength(svml) });

  // 校验 + plan（失败抛出，由上层决定是否降级）
  await opts.kernel.runtimeUse(runtimePath);
  await opts.kernel.check(svmlPath);
  await opts.kernel.plan(runPath);

  // 渲染并取回产物（写到 outputs/，与 ffmpeg 兜底路径一致，供 run-pipeline.sh 上传 R2）
  const buildId = await opts.kernel.build(runPath, { title: `task-${opts.videoKey.split('/')[1] ?? 'render'}`, maxWaitMs: 20 * 60_000 });
  const finalPath = join(workDir, 'outputs', 'final.mp4');
  await mkdir(join(workDir, 'outputs'), { recursive: true });
  await opts.kernel.get(buildId, 'final.video', finalPath);

  // 对象存储上传：GHA 上 store 是本地 FS，产物由 run-pipeline.sh 统一传 R2；
  // 仅当 store 是远程对象存储（put 返回 http url）时才在此上传。
  const probe = await opts.store.put(`__probe__/${Date.now()}`, new Uint8Array(1), 'application/octet-stream');
  const isRemote = /^https?:\/\//i.test(probe);
  if (isRemote) {
    const url = await opts.store.put(opts.videoKey, await readFile(finalPath), 'video/mp4');
    log.info('hypit render uploaded (remote store)', { videoKey: opts.videoKey, url, buildId });
  } else {
    log.info('hypit render done; local store, output left for R2 upload', { finalPath, buildId });
  }

  return { finalPath, videoKey: opts.videoKey, buildId };
}
