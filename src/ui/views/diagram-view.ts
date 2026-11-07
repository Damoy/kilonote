// A rendered diagram (Mermaid file, or the schema of a SQL file): zoom, fit to
// the pane, save as SVG. The drawing is an image: it cannot run anything.

import type { App } from "../../app/app";
import { diagramError, fixSvgSize, renderMermaid, svgDataUrl } from "./mermaid";
import { h, icon } from "../dom";
import { toast } from "../overlay";

export class DiagramView {
  readonly el: HTMLElement;
  private stage = h("div", { class: "dv-stage" });
  private img = h("img", { class: "dv-img", alt: "Diagram", draggable: "false" }) as HTMLImageElement;
  private status = h("div", { class: "tv-status", hidden: true });
  private title = h("span", { class: "tv-title" });
  private zoomLabel = h("button", { class: "kn-btn subtle dv-zoom", title: "Fit to the pane / actual size" });
  /** null: fit to the pane. */
  private scale: number | null = null;
  private svg = "";
  private token = 0;
  private name = "diagram";

  constructor(private app: App, extra?: HTMLElement) {
    this.zoomLabel.addEventListener("click", () => this.setScale(this.scale === null ? 1 : null));
    const tools = h("div", { class: "tv-tools" },
      this.title,
      h("span", { class: "kn-spacer" }),
      h("button", { class: "kn-icon-btn", title: "Zoom out (Ctrl+wheel)", onclick: () => this.zoom(1 / 1.25) }, icon("zoomOut")),
      this.zoomLabel,
      h("button", { class: "kn-icon-btn", title: "Zoom in (Ctrl+wheel)", onclick: () => this.zoom(1.25) }, icon("zoomIn")),
      h("button", { class: "kn-icon-btn", title: "Save as SVG…", onclick: () => void this.save() }, icon("save")),
    );
    this.stage.append(this.img);
    this.el = h("div", { class: "dv" }, tools, this.status, this.stage, extra ?? null);
    this.stage.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
    this.img.addEventListener("load", () => this.applyScale());
    this.applyScale();
  }

  /** Draws a Mermaid text; on an error, the last drawing stays (dimmed) under the message. */
  async render(code: string, opts: { dark: boolean; title: string; name: string }) {
    const token = ++this.token;
    this.title.textContent = opts.title;
    this.name = opts.name;
    try {
      const svg = fixSvgSize(await renderMermaid(code, opts.dark));
      if (token !== this.token) return;
      this.svg = svg;
      if (this.img.dataset.src !== svg) {
        this.img.dataset.src = svg;
        this.img.src = svgDataUrl(svg);
      }
      this.status.hidden = true;
      this.status.classList.remove("info");
      this.stage.classList.remove("stale");
    } catch (e) {
      if (token !== this.token) return;
      this.status.replaceChildren(icon("x"), h("span", {}, diagramError(e)));
      this.status.classList.remove("info");
      this.status.hidden = false;
      this.stage.classList.add("stale");
    }
  }

  /** Nothing to draw (e.g. a SQL file without tables). */
  clear(message: string) {
    ++this.token;
    this.svg = "";
    this.img.removeAttribute("src");
    delete this.img.dataset.src;
    this.status.replaceChildren(h("span", {}, message));
    this.status.hidden = false;
    this.status.classList.add("info");
  }

  private zoom(factor: number) {
    const current = this.scale ?? this.fitScale();
    this.setScale(Math.min(8, Math.max(0.1, current * factor)));
  }

  private fitScale(): number {
    const w = this.img.naturalWidth || 1;
    const h = this.img.naturalHeight || 1;
    const box = this.stage.getBoundingClientRect();
    return Math.min(1, (box.width - 32) / w, (box.height - 32) / h) || 1;
  }

  private setScale(scale: number | null) {
    this.scale = scale;
    this.applyScale();
  }

  private applyScale() {
    const fit = this.scale === null;
    this.stage.classList.toggle("fit", fit);
    if (fit) {
      this.img.style.width = "";
      this.zoomLabel.textContent = "Fit";
    } else {
      this.img.style.width = `${Math.round((this.img.naturalWidth || 0) * this.scale!)}px`;
      this.zoomLabel.textContent = `${Math.round(this.scale! * 100)} %`;
    }
  }

  private async save() {
    if (!this.svg) return;
    const path = await this.app.backend.pickSavePath(`${this.name}.svg`);
    if (!path) return;
    try {
      await this.app.backend.writeText(path, this.svg);
      toast("Diagram saved as SVG.", { kind: "success" });
    } catch (e) {
      toast(`Could not save the diagram: ${e}`, { kind: "error" });
    }
  }
}
