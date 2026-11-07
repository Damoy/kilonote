// Diagrams written as text (Mermaid: flowcharts, sequence, class, state,
// entity-relationship, Gantt, pie, mind maps…), rendered to SVG.
// The Mermaid library is loaded the first time a diagram is shown, runs with
// its "strict" security level (labels are cleaned, no click handlers), and its
// SVG is only ever shown as an image, which cannot run scripts.

type Mermaid = (typeof import("mermaid"))["default"];

let lib: Promise<Mermaid> | null = null;
let configured: string | null = null;
let counter = 0;
let queue: Promise<unknown> = Promise.resolve();
const cache = new Map<string, Promise<string>>();
const CACHE_SIZE = 60;

/** The first line of a Mermaid text names its kind of diagram. */
export const MERMAID_START = /^\s*(?:%%.*\n\s*)*(?:---[\s\S]*?---\s*)?(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|requirementDiagram|architecture(?:-beta)?|kanban|packet(?:-beta)?|radar(?:-beta)?|treemap(?:-beta)?|venn(?:-beta)?|zenuml)\b/;

async function render(code: string, dark: boolean): Promise<string> {
  lib ??= import("mermaid").then((m) => m.default);
  const mermaid = await lib;
  const theme = dark ? "dark" : "default";
  if (configured !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      // Plain SVG text (no HTML inside the drawing): it shows the same as an image.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      fontFamily: "system-ui, 'Segoe UI', sans-serif",
      maxTextSize: 200_000,
    });
    configured = theme;
  }
  const id = `kn-mermaid-${++counter}`;
  try {
    const { svg } = await mermaid.render(id, code);
    return svg;
  } finally {
    // Mermaid measures text in temporary elements: none may stay behind.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/** The SVG of a Mermaid diagram (rendered one at a time, kept for a while). */
export function renderMermaid(code: string, dark: boolean): Promise<string> {
  const key = `${dark ? "d" : "l"}:${code}`;
  let p = cache.get(key);
  if (p) {
    // Recently used: last to be evicted.
    cache.delete(key);
    cache.set(key, p);
    return p;
  }
  p = queue.then(() => render(code, dark));
  queue = p.catch(() => {});
  // A failure is not kept: the same text may render once a typo is fixed elsewhere.
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return p;
}

/**
 * Mermaid draws at width="100%": as an image, the drawing needs its real size,
 * taken from its viewBox.
 */
export function fixSvgSize(svg: string): string {
  const open = /<svg\b[^>]*>/.exec(svg);
  if (!open) return svg;
  const box = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(open[0]);
  if (!box) return svg;
  const tag = open[0]
    .replace(/\s(width|height)="[^"]*"/g, "")
    .replace(/\sstyle="[^"]*"/, "")
    .replace(/^<svg/, `<svg width="${Math.ceil(Number(box[1]))}" height="${Math.ceil(Number(box[2]))}"`);
  return tag + svg.slice(open.index + open[0].length);
}

/** An SVG as an image address (an image never runs scripts nor loads anything). */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The message of a Mermaid error, without its long technical tail. */
export function diagramError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  return msg.split("\n").filter(Boolean).slice(0, 4).join("\n").slice(0, 400);
}
