/**
 * 中秋图形动画组件（hypit HyperFrames 代码渲染）。
 *
 * 用 browserProgram（HTML/CSS/JS）画：渐变夜空 + 发光圆月 + 闪烁繁星 + 玉兔剪影，
 * 每帧由 setup 回调驱动动画。零模型成本，纯代码确定性渲染。
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
  /** 主标题文字（如"中秋节"）。 */
  title: string;
  /** 副标题文字（如"月圆人团圆"）。 */
  subtitle?: string;
  /** 画面主色（十六进制，如 #0b1e3a）。 */
  sky?: string;
  /** 月亮颜色。 */
  moon?: string;
  /** 淡入帧数。 */
  entranceFrames: number;
  /** 是否显示玉兔。 */
  rabbit?: boolean;
};

/** 夜空星星的固定位置（相对坐标 0-100）。 */
const STARS = [
  { x: 12, y: 18, r: 1.2 }, { x: 28, y: 10, r: 0.9 }, { x: 41, y: 24, r: 1.4 },
  { x: 55, y: 8, r: 1.0 }, { x: 68, y: 30, r: 1.3 }, { x: 82, y: 14, r: 0.8 },
  { x: 90, y: 40, r: 1.1 }, { x: 18, y: 46, r: 0.7 }, { x: 36, y: 55, r: 1.0 },
  { x: 74, y: 52, r: 1.2 }, { x: 8, y: 60, r: 0.9 }, { x: 60, y: 66, r: 0.8 },
];

/** 单颗星星的 HTML（用 box-shadow 圆点 + CSS 闪烁动画）。 */
function starMarkup(star: (typeof STARS)[number], i: number): string {
  return `<i class="star" style="left:${star.x}%;top:${star.y}%;width:${star.r * 8}px;height:${star.r * 8}px;--delay:${(i % 5) * 0.3}s"></i>`;
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

  let order = 0;
  const text = (id: string, value: string, size: number, color: string): VisualElement => ({
    id,
    kind: "text",
    parent: "scene",
    order: ++order,
    text: value,
    fonts: font.faces,
    style: [
      { name: "font-size", value: `${size}px` },
      { name: "line-height", value: 1.3 },
      { name: "color", value: color },
    ],
  });

  const children: VisualElement[] = [
    text("title", options.title, 56, "#f8f0d8"),
    ...(options.subtitle ? [text("subtitle", options.subtitle, 30, "#d9c48f")] : []),
  ];

  const program = browserProgram({
    html: `<div class="sky">
  <div class="moon"></div>
  <div class="moon-glow"></div>
  ${STARS.map(starMarkup).join("\n  ")}
  ${options.rabbit ? `<div class="rabbit">
    <div class="r-ear l"></div><div class="r-ear r"></div>
    <div class="r-body"></div><div class="r-head"></div>
  </div>` : ""}
  <h1 class="t-title">{{title}}</h1>
  ${options.subtitle ? `<p class="t-subtitle">{{subtitle}}</p>` : ""}
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
  .mountain{position:absolute;bottom:0;left:0;right:0;clip-path:polygon(0 100%,0 55%,16% 38%,30% 60%,48% 30%,62% 55%,80% 36%,100% 60%,100% 100%)}
  .mountain.back{height:42%;background:#0d1a30;opacity:.9}
  .mountain.front{height:26%;background:#0a1424;opacity:.95}
  h1.t-title{position:absolute;left:50%;bottom:22%;transform:translateX(-50%);margin:0;font-size:56px;font-weight:700;letter-spacing:4px;color:#f8f0d8;text-shadow:0 2px 18px rgba(0,0,0,.6);animation:titleIn 1.6s cubic-bezier(.2,.8,.2,1) both}
  p.t-subtitle{position:absolute;left:50%;bottom:15%;transform:translateX(-50%);margin:0;font-size:30px;color:#d9c48f;text-shadow:0 2px 12px rgba(0,0,0,.5);animation:titleIn 1.6s .4s cubic-bezier(.2,.8,.2,1) both}
  @keyframes titleIn{from{opacity:0;transform:translate(-50%,26px)}to{opacity:1;transform:translate(-50%,0)}}`,
    data: { entrance: options.entranceFrames },
    setup: `(()=>{
      const scene=document.querySelector('.sky');
      const title=scene.querySelector('.t-title');
      return frame=>{
        const t=Math.min(1,frame/data.entrance), p=1-Math.pow(1-t,3);
        scene.style.opacity=String(p);
        if(title) title.style.opacity=String(p);
      };
    })()`,
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
        ...children,
      ],
    }],
  });
}
