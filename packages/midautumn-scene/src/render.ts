/**
 * 中秋图形动画组件（hypit HyperFrames 代码渲染）。
 *
 * 用 browserProgram（HTML/CSS/JS）绘制中秋场景，按 variant 渲染不同画面：
 *   - moon     夜空圆月
 *   - rabbit   玉兔捣药（月宫）
 *   - family   阖家团圆（房屋 + 围坐剪影 + 圆月）
 *   - mooncake 月饼（桌面 + 月饼盘）
 *   - osmanthus 桂花（桂树 + 飘落花瓣 + 圆月）
 *   - lantern  灯笼（悬挂灯笼 + 夜空）
 *
 * 画面只渲染图形动画，不渲染任何文字——script 的 title/subtitle 只是"画什么"的指令。
 * 零模型成本，纯代码确定性渲染。
 */
import { sealVisualTrack } from "@hypit/hypit/composition";
import { browserProgram } from "@hypit/hypit/hyperframes";
import type { FontStackRef } from "@hypit/hypit/media";
import type { Timeline } from "@hypit/hypit/timeline";
import type { CanvasSpace } from "@hypit/hypit/spatial";
import { assertTemporalWindowFor } from "@hypit/hypit/temporal";
import type { TemporalWindow } from "@hypit/hypit/temporal";

export type SceneVariant = "moon" | "rabbit" | "family" | "mooncake" | "osmanthus" | "lantern";

export type SceneOptions = {
  id: string;
  /** 主标题（仅作元数据，不渲染）。 */
  title: string;
  subtitle?: string;
  variant: SceneVariant;
  sky?: string;
  moon?: string;
  entranceFrames: number;
};

/** 夜空星星固定位置（相对坐标 0-100）。 */
const STARS = [
  { x: 12, y: 18, r: 1.2 }, { x: 28, y: 10, r: 0.9 }, { x: 41, y: 24, r: 1.4 },
  { x: 55, y: 8, r: 1.0 }, { x: 68, y: 30, r: 1.3 }, { x: 82, y: 14, r: 0.8 },
  { x: 90, y: 40, r: 1.1 }, { x: 18, y: 46, r: 0.7 }, { x: 36, y: 55, r: 1.0 },
  { x: 74, y: 52, r: 1.2 }, { x: 8, y: 60, r: 0.9 }, { x: 60, y: 66, r: 0.8 },
];

const skyStars = () => STARS.map((s, i) =>
  `<i class="star" style="left:${s.x}%;top:${s.y}%;width:${s.r * 8}px;height:${s.r * 8}px;--delay:${(i % 5) * 0.3}s"></i>`).join("");

/** 飘落桂花。 */
const petals = (n = 7) => Array.from({ length: n }, (_, i) =>
  `<i class="petal" style="left:${8 + i * 12}%;--pdelay:${(i * 0.5).toFixed(1)}s"></i>`).join("");

const SKY_CSS = `:scope{overflow:hidden}
  .scene{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 0%, var(--sky) 0%, #060d1c 72%);overflow:hidden}
  .star{position:absolute;border-radius:50%;background:#fff;opacity:.85;animation:twinkle 3.2s ease-in-out var(--delay) infinite}
  @keyframes twinkle{0%,100%{opacity:.2}50%{opacity:.95}}
  .moon{position:absolute;right:16%;top:13%;width:132px;height:132px;border-radius:50%;
    background:radial-gradient(circle at 35% 35%, #fffbe8, var(--moon) 62%, #e0b96a);box-shadow:0 0 60px 18px rgba(255,240,200,.35)}
  .moon-glow{position:absolute;right:13.5%;top:11%;width:174px;height:174px;border-radius:50%;
    background:radial-gradient(circle, rgba(255,240,200,.28), transparent 70%);animation:glow 4s ease-in-out infinite}
  @keyframes glow{0%,100%{transform:scale(1);opacity:.8}50%{transform:scale(1.08);opacity:1}}
  .ground{position:absolute;bottom:0;left:0;right:0;height:30%;
    background:linear-gradient(#0a1424, #060c18);clip-path:polygon(0 100%,0 42%,20% 26%,42% 52%,64% 30%,100% 55%,100% 100%)}
  .mountain{position:absolute;bottom:0;left:0;right:0;clip-path:polygon(0 100%,0 55%,16% 38%,30% 60%,48% 30%,62% 55%,80% 36%,100% 60%,100% 100%);background:#0b1729;height:34%;opacity:.85}
  .petals{position:absolute;inset:0;overflow:hidden;pointer-events:none}
  .petal{position:absolute;top:-8%;width:13px;height:13px;background:#f2c94c;border-radius:60% 40% 60% 40%;opacity:.9;animation:fall 8s linear var(--pdelay) infinite}
  @keyframes fall{0%{transform:translateY(-10%) rotate(0);opacity:0}10%{opacity:.9}90%{opacity:.85}100%{transform:translateY(110vh) rotate(720deg);opacity:0}}`;

function variantMarkup(opts: SceneOptions): { html: string; css: string } {
  const moon = `<div class="moon"></div><div class="moon-glow"></div>`;
  switch (opts.variant) {
    case "rabbit":
      return {
        html: `<div class="scene">${moon}${skyStars()}<div class="ground"></div>
  <div class="tree"></div>
  <div class="rabbit"><div class="ear l"></div><div class="ear r"></div><div class="head"></div><div class="body"></div></div>
  <div class="mortar"></div><div class="pestle"></div></div>`,
        css: `${SKY_CSS}
  .tree{position:absolute;left:14%;bottom:26%;width:16px;height:34%;background:#3a2a1c;border-radius:8px}
  .tree::after{content:"";position:absolute;left:-70px;top:-40px;width:156px;height:120px;border-radius:50%;background:radial-gradient(circle,#4b6b3a,#2c421f)}
  .rabbit{position:absolute;left:40%;bottom:24%;width:96px;height:110px;animation:hop 2.4s ease-in-out infinite}
  .rabbit .ear{position:absolute;width:22px;height:58px;border-radius:12px;background:#f4f2ec;top:-26px}
  .rabbit .ear.l{left:20px;transform:rotate(-10deg)}.rabbit .ear.r{right:20px;transform:rotate(10deg)}
  .rabbit .head{position:absolute;width:70px;height:58px;border-radius:50% 50% 44% 44%;background:#f4f2ec;top:24px;left:13px}
  .rabbit .head::before,.rabbit .head::after{content:"";position:absolute;top:22px;width:8px;height:8px;border-radius:50%;background:#c96}
  .rabbit .head::before{left:18px}.rabbit .head::after{right:18px}
  .rabbit .body{position:absolute;width:76px;height:58px;border-radius:48%;background:#f4f2ec;top:62px;left:10px}
  .mortar{position:absolute;left:58%;bottom:24%;width:64px;height:56px;border-radius:8px 8px 26px 26px;background:linear-gradient(#8a6a45,#5c4328)}
  .pestle{position:absolute;left:62%;bottom:44%;width:12px;height:70px;background:#9c7a52;border-radius:6px;transform-origin:bottom center;animation:pound 1.2s ease-in-out infinite}
  @keyframes hop{0%,100%{transform:translateY(0)}50%{transform:translateY(-16px)}}
  @keyframes pound{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(12deg)}}`,
      };
    case "family":
      return {
        html: `<div class="scene">${moon}${skyStars()}<div class="ground"></div>
  <div class="house"><div class="roof"></div><div class="win"></div></div>
  <div class="table"></div>
  <div class="people">${Array.from({ length: 5 }, (_, i) => `<span style="--i:${i}"></span>`).join("")}</div></div>`,
        css: `${SKY_CSS}
  .house{position:absolute;left:8%;bottom:28%;width:130px;height:110px;background:#122036}
  .house .roof{position:absolute;left:-14px;top:-42px;border-left:79px solid transparent;border-right:79px solid transparent;border-bottom:44px solid #1c2f4d}
  .house .win{position:absolute;left:46px;top:30px;width:38px;height:38px;background:#ffd98a;border-radius:4px;box-shadow:0 0 26px 8px rgba(255,200,110,.6);animation:glowwin 3s ease-in-out infinite}
  @keyframes glowwin{0%,100%{opacity:.75}50%{opacity:1}}
  .table{position:absolute;left:52%;bottom:22%;width:150px;height:12px;background:#5c4328;border-radius:6px}
  .people{position:absolute;left:48%;bottom:22%;width:210px;height:120px}
  .people span{position:absolute;bottom:0;left:calc(var(--i)*20%);width:34px;height:64px;border-radius:50% 50% 20% 20%;background:#203650;animation:sway 3s ease-in-out calc(var(--i)*.25s) infinite}
  .people span::before{content:"";position:absolute;top:-26px;left:6px;width:22px;height:22px;border-radius:50%;background:#203650}
  @keyframes sway{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}`,
      };
    case "mooncake":
      return {
        html: `<div class="scene warm"><div class="moon small"></div><div class="plate"></div>
  <div class="cakes">${Array.from({ length: 3 }, (_, i) => `<span style="--i:${i}"></span>`).join("")}</div>
  <div class="steam">${Array.from({ length: 4 }, () => "<i></i>").join("")}</div></div>`,
        css: `:scope{overflow:hidden}
  .scene{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 80%, #3a2412 0%, #160c06 75%);overflow:hidden}
  .moon{position:absolute;right:14%;top:12%;width:132px;height:132px;border-radius:50%;
    background:radial-gradient(circle at 35% 35%, #fffbe8, var(--moon) 62%, #e0b96a);box-shadow:0 0 60px 18px rgba(255,240,200,.35)}
  .moon.small{width:96px;height:96px;right:12%;top:10%}
  .plate{position:absolute;left:50%;bottom:20%;transform:translateX(-50%);width:420px;height:60px;border-radius:50%;background:radial-gradient(ellipse,#d9c9a6,#9c8560)}
  .cakes{position:absolute;left:50%;bottom:26%;transform:translateX(-50%);display:flex;gap:26px}
  .cakes span{width:96px;height:96px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#e6b96a,#a86f2c);box-shadow:inset 0 0 0 6px #b98a44;animation:rise .8s ease-out calc(var(--i)*.15s) both}
  @keyframes rise{from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}
  .steam{position:absolute;left:50%;bottom:40%;transform:translateX(-50%);display:flex;gap:30px}
  .steam i{width:60px;height:8px;background:rgba(255,240,210,.15);border-radius:50%;animation:steam 3s ease-in-out infinite}
  @keyframes steam{0%,100%{transform:translateY(0);opacity:.15}50%{transform:translateY(-18px);opacity:.4}}`,
      };
    case "osmanthus":
      return {
        html: `<div class="scene">${moon}${skyStars()}<div class="ground"></div>
  <div class="osmanthus"></div>
  <div class="petals">${petals(9)}</div></div>`,
        css: `${SKY_CSS}
  .osmanthus{position:absolute;left:16%;bottom:24%;width:16px;height:38%;background:#3a2a1c;border-radius:8px}
  .osmanthus::after{content:"";position:absolute;left:-84px;top:-60px;width:184px;height:150px;border-radius:50%;background:radial-gradient(circle,#e6b84c,#a67a1f)}`,
      };
    case "lantern":
      return {
        html: `<div class="scene">${moon}${skyStars()}
  <div class="lanterns">${Array.from({ length: 6 }, (_, i) => `<span style="--i:${i}"></span>`).join("")}</div>
  <div class="ground"></div></div>`,
        css: `${SKY_CSS}
  .lanterns{position:absolute;inset:0}
  .lanterns span{position:absolute;top:calc(6% + var(--i)*7%);left:calc(8% + (var(--i)*7) % 70%);width:52px;height:66px;border-radius:50%;
    background:radial-gradient(circle at 40% 35%,#ffb36b,#d8452c);box-shadow:0 0 40px 12px rgba(255,150,80,.5);
    animation:swing 3.4s ease-in-out calc(var(--i)*.3s) infinite}
  .lanterns span::before{content:"";position:absolute;left:50%;top:-40px;width:2px;height:40px;background:rgba(255,220,180,.4)}
  @keyframes swing{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}}`,
      };
    case "moon":
    default:
      return {
        html: `<div class="scene">${moon}${skyStars()}<div class="mountain"></div><div class="ground"></div>
  <div class="petals">${petals(5)}</div></div>`,
        css: SKY_CSS,
      };
  }
}

export function renderMidautumnScene(
  timeline: Timeline,
  canvas: CanvasSpace,
  window: TemporalWindow,
  _font: FontStackRef,
  options: SceneOptions,
) {
  assertTemporalWindowFor(window, { subjectId: options.id, space: timeline });
  if (!Number.isSafeInteger(options.entranceFrames) || options.entranceFrames < 1) {
    throw new Error("Midautumn entrance-frames must be a positive integer.");
  }

  const { html, css } = variantMarkup(options);
  const program = browserProgram({
    html,
    css: `:scope{--sky:${options.sky ?? "#14284a"};--moon:${options.moon ?? "#f6d684"};overflow:hidden}${css}`,
    data: { entrance: options.entranceFrames },
    setup: `const scene=root.querySelector('.scene')||root;
      return localFrame=>{
        const t=Math.min(1,localFrame/data.entrance), p=1-Math.pow(1-t,3);
        scene.style.opacity=String(p);
      };`,
  });

  return sealVisualTrack({
    id: options.id,
    programSpaceId: timeline.id,
    visualIr: "hypit.visual-ir@1",
    presents: [{
      id: options.id,
      span: window.span,
      stacking: { order: 0, tieBreak: options.id },
      elements: [{
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
      }],
    }],
  });
}