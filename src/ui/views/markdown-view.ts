// The Markdown preview: the note rendered (markdown-render.ts), its links opened
// in the browser, and its ```mermaid blocks drawn as diagrams.
// While typing, only the blocks that changed are rendered and replaced in
// place: the rest of a long note is left untouched (no new layout of it).

import type { Tree } from "@lezer/common";
import type { App } from "../../app/app";
import { todayISO } from "../../text/tasks";
import { h } from "../dom";
import { markdownBlocks } from "./markdown-render";
import { diagramError, fixSvgSize, renderMermaid, svgDataUrl } from "./mermaid";

/** A block on screen: its source text and its elements. */
interface Shown {
  source: string;
  nodes: Node[];
}

export class MarkdownView {
  readonly el = h("div", { class: "pv-md", tabindex: "-1" });
  private root = h("div", { class: "md" });
  private shown: Shown[] = [];
  /** Code blocks whose diagram is being drawn. */
  private drawing = new WeakSet<Element>();

  constructor(private app: App) {
    this.el.append(this.root);
    // Links: only http(s) and mailto, opened in the browser.
    this.el.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("a[data-url]");
      if (!a) return;
      e.preventDefault();
      void app.backend.openUrl(a.dataset.url!);
    });
  }

  /**
   * Renders the note. `tree` is the editor's syntax tree when it has one (no
   * parsing then); `fresh` renders everything again (another note, or new
   * settings).
   */
  render(text: string, dark: boolean, opts: { tree?: Tree; fresh?: boolean } = {}) {
    const blocks = markdownBlocks(text, { taskCfg: this.app.taskCfg, today: todayISO(), tree: opts.tree });
    const old = opts.fresh ? [] : this.shown;
    // The unchanged blocks at the start and at the end stay as they are.
    let start = 0;
    while (start < old.length && start < blocks.length && old[start].source === blocks[start].source) start++;
    let end = 0;
    while (end < old.length - start && end < blocks.length - start && old[old.length - 1 - end].source === blocks[blocks.length - 1 - end].source) end++;
    const removed = old.slice(start, old.length - end);
    // A block that only moved (or a copy of one) is reused.
    const pool = new Map<string, Node[][]>();
    for (const r of removed) pool.set(r.source, [...(pool.get(r.source) ?? []), r.nodes]);
    const middle = blocks.slice(start, blocks.length - end).map((b) => ({ source: b.source, nodes: pool.get(b.source)?.shift() ?? b.render() }));
    const top = this.el.scrollTop;
    if (opts.fresh) this.root.replaceChildren();
    else for (const r of removed) for (const n of r.nodes) n.parentNode?.removeChild(n);
    // Before the first element of the unchanged end (a link definition shows nothing).
    let anchor: Node | null = null;
    for (let i = old.length - end; i < old.length && !anchor; i++) anchor = old[i].nodes[0] ?? null;
    for (const m of middle) for (const n of m.nodes) this.root.insertBefore(n, anchor);
    this.shown = [...old.slice(0, start), ...middle, ...old.slice(old.length - end)];
    this.el.scrollTop = top;
    void this.drawDiagrams(middle, dark);
  }

  /**
   * ```mermaid blocks, drawn in place of their code. A drawing goes on while the
   * note is edited elsewhere; a block that was changed or removed meanwhile is
   * skipped (its new version is drawn by the rendering that showed it).
   */
  private async drawDiagrams(blocks: Shown[], dark: boolean) {
    for (const block of blocks) {
      for (const node of [...block.nodes]) {
        if (!(node instanceof HTMLElement)) continue;
        // (A selector is matched in the whole document: a code block that is the node itself is found too.)
        for (const code of node.querySelectorAll<HTMLElement>("pre > code[data-lang]")) {
          if (!/^mermaid\b/i.test(code.dataset.lang!)) continue;
          const pre = code.parentElement!;
          if (this.drawing.has(pre) || !this.root.contains(pre)) continue;
          this.drawing.add(pre);
          let replacement: HTMLElement;
          try {
            const svg = fixSvgSize(await renderMermaid(code.textContent ?? "", dark));
            replacement = h("figure", { class: "md-diagram" }, h("img", { class: "md-diagram-img", alt: "Diagram", src: svgDataUrl(svg) }));
          } catch (e) {
            // The error above the code, in one element that takes the place of the code.
            replacement = h("div", { class: "md-diagram-failed" }, h("div", { class: "md-diagram-error" }, `Diagram: ${diagramError(e)}`));
          } finally {
            this.drawing.delete(pre);
          }
          if (!this.root.contains(pre)) continue;
          pre.replaceWith(replacement);
          if (replacement.classList.contains("md-diagram-failed")) replacement.append(pre);
          // A block that was only this code now shows the diagram.
          const at = block.nodes.indexOf(pre);
          if (at >= 0) block.nodes[at] = replacement;
        }
      }
    }
  }
}
