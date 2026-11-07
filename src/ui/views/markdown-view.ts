// The Markdown preview: the note rendered (markdown-render.ts), its links opened
// in the browser, and its ```mermaid blocks drawn as diagrams.

import type { App } from "../../app/app";
import { todayISO } from "../../text/tasks";
import { h } from "../dom";
import { renderMarkdown } from "./markdown-render";
import { diagramError, fixSvgSize, renderMermaid, svgDataUrl } from "./mermaid";

export class MarkdownView {
  readonly el = h("div", { class: "pv-md", tabindex: "-1" });
  private token = 0;

  constructor(private app: App) {
    // Links: only http(s) and mailto, opened in the browser.
    this.el.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("a[data-url]");
      if (!a) return;
      e.preventDefault();
      void app.backend.openUrl(a.dataset.url!);
    });
  }

  render(text: string, dark: boolean) {
    const top = this.el.scrollTop;
    this.el.replaceChildren(renderMarkdown(text, { taskCfg: this.app.taskCfg, today: todayISO() }));
    this.el.scrollTop = top;
    void this.drawDiagrams(dark);
  }

  /** ```mermaid blocks, drawn in place of their code. */
  private async drawDiagrams(dark: boolean) {
    const token = ++this.token;
    const blocks = [...this.el.querySelectorAll<HTMLElement>("pre > code[data-lang]")].filter((c) => /^mermaid\b/i.test(c.dataset.lang!));
    for (const code of blocks) {
      const pre = code.parentElement!;
      try {
        const svg = fixSvgSize(await renderMermaid(code.textContent ?? "", dark));
        if (token !== this.token) return;
        pre.replaceWith(h("figure", { class: "md-diagram" }, h("img", { class: "md-diagram-img", alt: "Diagram", src: svgDataUrl(svg) })));
      } catch (e) {
        if (token !== this.token) return;
        pre.before(h("div", { class: "md-diagram-error" }, `Diagram: ${diagramError(e)}`));
      }
    }
  }
}
