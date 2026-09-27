/**
 * 中秋图形动画组件（hypit 扩展包）激活入口。
 *
 * 声明 <midautumn:Scene> 元素：接收 timeline/canvas/font + title/subtitle/sky/moon 等，
 * 产出 visualTrack 交给 HyperFrames 渲染。
 */
import {
  assertAttributes,
  assertEmptyElement,
  canonicalize,
  createMarkupSurfaceHostFacet,
  sameType,
  sealGraphFragment,
  textAttribute,
} from "@hypit/hypit/author-kit";
import type {
  ComponentPackage,
  FragmentOperation,
  ModuleManifest,
  StructuredSurfaceHandler,
  SurfaceResolvedReference,
  TypeRef,
} from "@hypit/hypit/author-kit";
import { compositionTypes } from "@hypit/hypit/composition";
import { mediaTypes } from "@hypit/hypit/media";
import type { FontStackRef } from "@hypit/hypit/media";
import type { Timeline } from "@hypit/hypit/timeline";
import { timelineTypes } from "@hypit/hypit/timeline";
import { spatialTypes } from "@hypit/hypit/spatial";
import type { CanvasSpace } from "@hypit/hypit/spatial";
import { temporalTypes } from "@hypit/hypit/temporal";
import type { TemporalWindow } from "@hypit/hypit/temporal";
import {
  createTemporalWindowProjection,
  resolveTemporalContext,
  temporalContextAttributeVocabulary,
  temporalWindowAttributeNames,
  temporalWindowAttributeVocabulary,
} from "@hypit/hypit/temporal-markup";
import { renderMidautumnScene } from "./render.js";
import type { SceneOptions } from "./render.js";

const module = { name: "@hypitapp/midautumn-scene", version: "1" } as const;
const optionsType: TypeRef = { module, name: "SceneOptions" };
const producers = { render: { module, name: "render" } };

export const manifest: ModuleManifest = {
  format: "hypit.module@1",
  ...module,
  dependencies: [compositionTypes.visualTrack, mediaTypes.fontStack, timelineTypes.track, spatialTypes.canvas, temporalTypes.window].map((type) => ({ module: type.module })),
  types: [{ name: "SceneOptions" }],
  capabilities: [],
  producers: [
    {
      name: "render",
      inputs: [
        { name: "timeline", type: timelineTypes.track },
        { name: "canvas", type: spatialTypes.canvas },
        { name: "font", type: mediaTypes.fontStack },
        { name: "window", type: temporalTypes.window },
        { name: "options", type: optionsType },
      ],
      outputs: [{ name: "track", type: compositionTypes.visualTrack }],
      needs: [],
    },
  ],
};

const inline = <T>(record: { value: { kind: string; value?: unknown } } | undefined): T => {
  if (record?.value.kind !== "inline") throw new Error("Midautumn inputs must be inline values.");
  return record.value.value as T;
};
const value = (data: unknown) => ({ kind: "inline" as const, value: canonicalize(data) });

const component: ComponentPackage = {
  producers: [
    {
      producer: producers.render,
      handler: ({ inputs }) => ({
        outputs: {
          track: value(
            renderMidautumnScene(
              inline<Timeline>(inputs.timeline),
              inline<CanvasSpace>(inputs.canvas),
              inline<TemporalWindow>(inputs.window),
              inline<FontStackRef>(inputs.font),
              inline<SceneOptions>(inputs.options),
            ),
          ),
        },
        needs: {},
      }),
    },
  ],
};

export const decodeSurface: StructuredSurfaceHandler = ({ element, resolveReference }) => {
  assertAttributes(element, [
    "id", "timeline", "canvas", "font",
    "title", "subtitle", "sky", "moon", "entrance-frames", "rabbit",
    ...temporalWindowAttributeNames,
  ]);
  const id = textAttribute(element, "id");
  const context = resolveTemporalContext({ element, resolveReference });
  const window = createTemporalWindowProjection({ id: `${id}.window`, subjectId: id, element, ...context, resolveReference });

  const reference = (name: string, type: TypeRef): SurfaceResolvedReference => {
    const raw = element.attributes[name];
    if (typeof raw !== "object" || raw.kind !== "reference") throw new Error(`${name} must be a reference.`);
    const found = resolveReference(raw.path);
    if (found === undefined || !sameType(found.type, type)) throw new Error(`${name} has the wrong Type.`);
    return found;
  };

  const rabbitRaw = element.attributes.rabbit;
  const rabbit = rabbitRaw === "true" || (typeof rabbitRaw === "object" && rabbitRaw !== null && "value" in rabbitRaw && rabbitRaw.value === true);
  const options: SceneOptions = {
    id,
    title: textAttribute(element, "title"),
    ...(element.attributes.subtitle !== undefined ? { subtitle: textAttribute(element, "subtitle") } : {}),
    ...(element.attributes.sky !== undefined ? { sky: textAttribute(element, "sky") } : {}),
    ...(element.attributes.moon !== undefined ? { moon: textAttribute(element, "moon") } : {}),
    entranceFrames: Number(element.attributes["entrance-frames"] ?? "20"),
    ...(rabbit ? { rabbit: true } : {}),
  };

  const records = [
    ...window.records,
    { id: `${id}.options`, type: optionsType, value: value(options), range: element.range },
  ];

  const inputs = [
    { name: "timeline", type: timelineTypes.track },
    { name: "canvas", type: spatialTypes.canvas },
    { name: "font", type: mediaTypes.fontStack },
    { name: "window", type: temporalTypes.window },
    { name: "options", type: optionsType },
  ];
  const bindings: Record<string, SurfaceResolvedReference["ref"]> = {
    timeline: context.timeline.ref,
    canvas: reference("canvas", spatialTypes.canvas).ref,
    font: reference("font", mediaTypes.fontStack).ref,
    window: window.ref,
    options: { kind: "record", id: `${id}.options` },
  };

  assertEmptyElement(element);

  const operations: FragmentOperation[] = [
    {
      id: "render",
      producer: producers.render,
      inputs: {
        timeline: { kind: "fragment-input", name: "timeline" },
        canvas: { kind: "fragment-input", name: "canvas" },
        font: { kind: "fragment-input", name: "font" },
        window: { kind: "fragment-input", name: "window" },
        options: { kind: "fragment-input", name: "options" },
      },
      result: { kind: "output", name: "track" },
    },
  ];
  const fragment = sealGraphFragment({
    inputs,
    operations,
    exports: [{ name: "track", type: compositionTypes.visualTrack, root: { kind: "fragment-operation", operation: "render" } }],
  });

  return {
    records,
    fragments: [...window.fragments, fragment],
    components: [
      ...window.components,
      { id, fragment: fragment.id, inputs: bindings, outputs: { track: `${id}.track` }, range: element.range },
    ],
    exports: [`${id}.track`],
  };
};

const declaration = {
  name: "scene",
  tag: "Scene",
  mode: "structured" as const,
  outputs: [
    compositionTypes.visualTrack,
    timelineTypes.track,
    temporalTypes.window,
    temporalTypes.instant,
    temporalTypes.windowSpec,
    temporalTypes.instantSpec,
    optionsType,
  ],
  vocabulary: {
    summary: "A code-rendered mid-autumn night scene: gradient sky, glowing moon, twinkling stars and an optional rabbit.",
    attributes: [
      ...temporalContextAttributeVocabulary,
      ...temporalWindowAttributeVocabulary,
      ...["id", "title", "canvas", "font"].map((name) => ({ name, kind: "expression" as const, required: true, summary: name })),
      { name: "subtitle", kind: "literal" as const, required: false, summary: "Secondary caption text." },
      { name: "sky", kind: "literal" as const, required: false, summary: "Sky gradient top color (hex)." },
      { name: "moon", kind: "literal" as const, required: false, summary: "Moon color (hex)." },
      { name: "rabbit", kind: "literal" as const, required: false, summary: "Draw the moon rabbit." },
      { name: "entrance-frames", kind: "literal" as const, required: false, summary: "Fade-in duration in frames; defaults to 20." },
    ],
    children: [],
    ports: [{ name: "track", type: compositionTypes.visualTrack, summary: "The complete mid-autumn scene." }],
    example:
      '<midautumn:Scene id="night" timeline={animation.timeline} canvas={canvas} font={font} during="program" title="中秋节" subtitle="月圆人团圆" rabbit="true"/>',
  },
};

export const hypitPackage = {
  format: "hypit.node-package@1" as const,
  modules: [{ manifest }],
  components: [component],
  hostFacets: [createMarkupSurfaceHostFacet({ module, declaration, handler: decodeSurface })],
};
export default hypitPackage;
