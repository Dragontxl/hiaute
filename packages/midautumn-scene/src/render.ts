/**
 * 中秋图形动画组件（hypit HyperFrames 代码渲染）。
 *
 * 用 browserProgram（HTML/CSS/JS）画：渐变夜空 + 发光圆月 + 闪烁繁星 + 玉兔剪影 + 桂花飘落，
 * 每帧由 setup 回调驱动动画。零模型成本，纯代码确定性渲染。
 *
 * 说明：画面只渲染图形动画，不渲染任何文字内容——script 里的 title/subtitle 只是
 * "画什么"的指令，不显示在画面上。
 */
import { sealVisualTrack } from "@hypit/hypit/composition";
import type { VisualElement } from "@hypit/hypit/composition";
import { browserProgram } from "@hypit/hypit/hyperframes";
import type { FontStackRef } from "@hypit/hypit/media";
import type { Timeline } from "@hypit/hypit/timeline";
import type { CanvasSpace } from "@hypit/hypit/spatial";
import { assertTemporalWindowFor } from "@hypit/hypit/temporal";
import type { TemporalWindow } from "@hypit/hypit/temporal";

export type SceneOptions = {
  id: string;
  /** 主标题文字（仅作元数据，不渲染到画面）。 */
  title: string;
  /** 副标题文字（仅作元数据，不渲染到画面）。 */
  subtitle?: string;
  /** 画面主色（十六进制，如 #0b1e3a）。 */
  sky?: string;
  /** 月亮颜色。 */
  moon?: string;
  /** 淡入帧数。 */
  entranceFrames: number;
  /** 是否显示玉兔。 */
  rabbit?: boolean;
  /** 桂花飘落数量。 */
  petals?: number;
};

/** 夜空星星的固定位置（相对坐标 0-100）。 */
const STARS = [
  { x: 12, y: 18, r: 1.2 }, { x: 28, y: 10, r: 0.9 }, { x: 41, y: 24, r: 1.4 },
  { x: 55, y: 8, r: 1.0 }, { x: 68, y: 30, r: 1.3 }, { x: 82, y: 14, r: 0.8 },
  { x: 90, y: 40, r: 1.1 }, { x: 18, y: 46, r: 0.7 }, { x: 36, y: 55, r: 1.0 },
  { x: 74, y: 52, r: 1.2 }, { x: 8, y: 60, r: 0.9 }, { x: 60, y: 66, r: 0.8 },
];

/** 桂花花瓣（飘落动画）。 */
const PETALS = [
  { x: 18, delay: 0 }, { x: 30, delay: 0.4 }, { x: 44, delay: 0.8 }, { x: 58, delay: 1.2 },
  { x: 70, delay: 1.6 }, { x: 82, delay: 2.0 }, { x: 50, delay: 2.4 },
];

function starMarkup(star: (typeof STARS)[number], i: number): string {
  return `<i class="star" style="left:${star.x}%;top:${star.y}%;width:${star.r * 8}px;height:${star.r * 8}px;--delay:${(i % 5) * 0.3}s"></i>`;
}

function petalMarkup(petal: (typeof PETALS)[number]): string {
  return `<i class="petal" style="left:${petal.x}%;--pdelay:${petal.delay}s"></i>`;
}

export function renderMidautumnScene(
  timeline: Timeline,
  canvas: CanvasSpace,
  window: TemporalWindow,
  font: FontStackRef,
  options: SceneOptions,
) {
  assertTemporalWindowFor(window, { subjectId: options.id, space: timeline });
  if (!Number.isSafeInteger(options.entranceFrames) || options.entranceFrames < 1) {
    throw new Error("Midautumn entrance-frames must be a positive integer.");
  }

  const program = browserProgram({
    html: `<div class="sky">
  <div class="moon"></div>
  <div class="moon-glow"></div>
  ${STARS.map(starMarkup).join("\n  ")}
  ${options.rabbit ? `<div class="rabbit">
    <div class="r-ear l"></div><div class="r-ear r"></div>
    <div class="r-body"></div><div class="r-head"></div>
  </div>` : ""}
  <div class="petals">${PETALS.map(petalMarkup).join("")}</div>
  <div class="mountain back"></div>
  <div class="mountain front"></div>
</div>`,
    css: `:scope{overflow:hidden}
  .sky{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 0%, ${options.sky ?? '#14284a'} 0%, #060d1c 70%);overflow:hidden}
  .moon{position:absolute;right:16%;top:14%;width:130px;height:130px;border-radius:50%;
    background:radial-gradient(circle at 35% 35%, #fffbe8, ${options.moon ?? '#f6d684'} 60%, #e0b96a);box-shadow:0 0 60px 18px rgba(255,240,200,.35)}
  .moon-glow{position:absolute;right:14%;top:12%;width:170px;height:170px;border-radius:50%;
    background:radial-gradient(circle, rgba(255,240,200,.28), transparent 70%);animation:glow 4s ease-in-out infinite}
  .star{position:absolute;border-radius:50%;background:#fff;opacity:.85;animation:twinkle 3.2s ease-in-out var(--delay) infinite}
  @keyframes twinkle{0%,100%{opacity:.2}50%{opacity:.95}}
  @keyframes glow{0%,100%{transform:scale(1);opacity:.8}50%{transform:scale(1.08);opacity:1}}
  .rabbit{position:absolute;left:22%;bottom:24%;width:70px;height:70px;animation:hop 2.6s ease-in-out infinite}
  .r-ear{position:absolute;width:16px;height:42px;border-radius:8px;background:#f2f2ee;top:-16px}
  .r-ear.l{left:12px;transform:rotate(-12deg)}.r-ear.r{right:12px;transform:rotate(12deg)}
  .r-head{position:absolute;width:52px;height:44px;border-radius:50% 50% 42% 42%;background:#f2f2ee;top:16px;left:9px}
  .r-body{position:absolute;width:56px;height:42px;border-radius:48%;background:#f2f2ee;top:44px;left:7px}
  @keyframes hop{0%,100%{transform:translateY(0)}50%{transform:translateY(-14px)}}
  .petals{position:absolute;inset:0;overflow:hidden;pointer-events:none}
  .petal{position:absolute;top:-8%;width:14px;height:14px;background:#f2c94c;border-radius:60% 40% 60% 40%;opacity:.9;
    animation:fall 8s linear var(--pdelay) infinite}
  @keyframes fall{0%{transform:translateY(-10%) rotate(0deg);opacity:0}10%{opacity:.9}90%{opacity:.85}100%{transform:translateY(110vh) rotate(720deg);opacity:0}}
  .mountain{position:absolute;bottom:0;left:0;right:0;clip-path:polygon(0 100%,0 55%,16% 38%,30% 60%,48% 30%,62% 55%,80% 36%,100% 60%,100% 100%)}
  .mountain.back{height:42%;background:#0d1a30;opacity:.9}
  .mountain.front{height:26%;background:#0a1424;opacity:.95}`,
    data: { entrance: options.entranceFrames },
    setup: `const scene=root;\n      return localFrame=>{\n        const t=Math.min(1,localFrame/data.entrance), p=1-Math.pow(1-t,3);\n        scene.style.opacity=String(p);\n      };`,
  });

  return sealVisualTrack({
    id: options.id,
    programSpaceId: timeline.id,
    visualIr: "hypit.visual-ir@1",
    presents: [{
      id: options.id,
      span: window.span,
      stacking: { order: 0, tieBreak: options.id },
      elements: [
        {
          id: "scene",
          kind: "program",
          order: 0,
          program,
          style: [
            { name: "position", value: "absolute" },
            { name: "inset", value: 0 },
            { name: "width", value: `${canvas.widthPx}px` },
            { name: "height", value: `${canvas.heightPx}px` },
          ],
        },
      ],
    }],
  });
}
