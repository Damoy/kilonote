// The pane next to the editor, for the documents that have a second view:
//   Markdown       → rendered preview (follows the scrolling)
//   HTML and SVG   → the page, in a sandboxed frame (html-preview.ts)
//   JSON, YAML, XML → an editable tree (tree-view.ts)
//   Mermaid        → the diagram (diagram-view.ts)
//   SQL            → schema diagram, tables, data, statements (sql-view.ts)
// Each view is turned on or off on its own (kept with the session).

import type { Text } from "@codemirror/state";
import type { App, Doc } from "../app";
import { handleKeydown } from "../core/commands";
import { extname, stem } from "../core/path";
import { findTheme } from "../core/themes";
import { diagramError, fixSvgSize, renderMermaid, svgDataUrl } from "../editor/diagrams";
import { renderMarkdown } from "../editor/markdown-render";
import { todayISO } from "../editor/tasks";
import { DiagramView } from "./diagram-view";
import { debounce, h, icon } from "./dom";
import { escapeHtmlText, HtmlFrame, markTextRuns, type TextRun } from "./html-preview";
import { SqlView } from "./sql-view";
import { TreeView } from "./tree-view";

export type SideKind = "markdown" | "html" | "tree" | "diagram" | "sql";
export const SIDE_KINDS: SideKind[] = ["markdown", "html", "tree", "diagram", "sql"];

/** Above this size, only the beginning is previewed (keeps typing fluid). */
const MAX_PREVIEW = 1_000_000;

export function sideKindFor(doc: Doc | null | undefined): SideKind | null {
  if (!doc) return null;
  if (doc.lang === "markdown") return "markdown";
  if (doc.lang === "html" || (doc.path && extname(doc.path) === "svg")) return "html";
  if (doc.lang === "jsonc" || doc.lang === "yaml" || doc.lang === "xml") return "tree";
  if (doc.lang === "mermaid") return "diagram";
  if (doc.lang === "sql") return "sql";
  return null;
}

export const SIDE_LABELS: Record<SideKind, { label: string; icon: string; title: string }> = {
  markdown: { label: "Preview", icon: "eye", title: "Markdown preview" },
  html: { label: "Preview", icon: "eye", title: "Page preview" },
  tree: { label: "Tree", icon: "tree", title: "Tree view" },
  diagram: { label: "Diagram", icon: "diagram", title: "Diagram" },
  sql: { label: "Schema", icon: "database", title: "Database view" },
};

export class Preview {
  /** The views the user turned on (for this window). */
  open = new Set<SideKind>();
  /** Share of the width given to the pane (the separator moves it). */
  size = 0.5;
  /** The pane takes the whole width (the editor is hidden). */
  only = false;
  private resizer = h("div", { class: "pv-resizer", role: "separator", "aria-orientation": "vertical", title: "Drag to resize · double-click: half and half" });
  private onlyBtn = h("button", { class: "pv-only-btn" });
  /** HTML: edit the text of the page in the preview. */
  htmlEdit = false;
  private editBtn = h("button", { class: "pv-only-btn pv-edit-btn" });
  /** Where each editable run of text is, in the text the preview was drawn from. */
  private runs: TextRun[] = [];
  private runsDoc: Text | null = null;
  /** Writing an edit made in the preview: the page already shows it. */
  private writingRun = false;
  private pane: HTMLElement;
  private md = h("div", { class: "pv-md", tabindex: "-1" });
  private frame: HtmlFrame;
  private tree: TreeView;
  private diagram: DiagramView;
  private sql: SqlView;
  private rendered: unknown = null;
  private mdToken = 0;
  private renderedKind: SideKind | null = null;
  private syncing = false;

  constructor(private app: App) {
    let pane = document.getElementById("preview");
    if (!pane) {
      pane = document.createElement("div");
      pane.id = "preview";
      document.getElementById("editor-host")!.after(pane);
    }
    this.pane = pane;
    pane.hidden = true;
    this.frame = new HtmlFrame((url) => void app.backend.openUrl(url));
    this.tree = new TreeView(app);
    this.diagram = new DiagramView(app);
    this.sql = new SqlView(app);
    // Created once and never moved: a moved frame would reload.
    pane.replaceChildren(this.md, this.frame.el, this.tree.el, this.diagram.el, this.sql.el, this.editBtn, this.onlyBtn);
    this.editBtn.replaceChildren(icon("pencil"));
    this.editBtn.addEventListener("click", () => this.setHtmlEdit(!this.htmlEdit));
    this.frame.onEdit = (i, text) => this.writeRun(i, text);
    this.frame.onKey = (e) => void handleKeydown(e);
    pane.before(this.resizer);
    this.onlyBtn.addEventListener("click", () => this.setOnly(!this.only));
    this.setupResizer();
    // Links: only http(s) and mailto, opened in the browser.
    this.md.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("a[data-url]");
      if (!a) return;
      e.preventDefault();
      void app.backend.openUrl(a.dataset.url!);
    });
    const soon = debounce(() => this.update(), 160);
    const slow = debounce(() => this.update(), 450);
    app.on("selection", () => {
      // A page reloads its frame, a diagram is drawn again: a little more patience while typing.
      if (this.kind === "html" || this.kind === "diagram") slow();
      else soon();
    });
    app.on("active", () => this.update(true));
    app.on("settings", () => this.update(true));
    app.on("docs", () => this.update());
    // The preview follows the editor's scrolling.
    this.md.addEventListener("scroll", () => this.follow(this.md, app.view.scrollDOM));
  }

  private setupResizer() {
    const r = this.resizer;
    r.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing");
      const area = document.getElementById("editor-area")!.getBoundingClientRect();
      const move = (ev: PointerEvent) => this.setSize((area.right - ev.clientX) / area.width, false);
      const up = () => {
        r.removeEventListener("pointermove", move);
        r.removeEventListener("pointerup", up);
        document.body.classList.remove("resizing");
        this.app.emit("workspace"); // kept with the session
      };
      r.addEventListener("pointermove", move);
      r.addEventListener("pointerup", up);
    });
    r.addEventListener("dblclick", () => this.setSize(0.5));
  }

  /** Share of the width for the pane, between 15 % and 85 %. */
  setSize(size: number, save = true) {
    this.size = Math.min(0.85, Math.max(0.15, Number.isFinite(size) ? size : 0.5));
    document.getElementById("editor-area")?.style.setProperty("--pv-size", `${(this.size * 100).toFixed(1)}%`);
    if (save) this.app.emit("workspace");
  }

  /** The pane alone (the editor hidden), or side by side again. */
  setOnly(only: boolean) {
    this.only = only;
    this.update(true);
    this.app.emit("workspace");
    if (!only) this.app.focusEditor();
  }

  setHtmlEdit(on: boolean) {
    this.htmlEdit = on;
    this.update(true);
    if (on) this.app.toastInfo("Click a text of the page to change it: the HTML follows. Tags and attributes are edited in the text.");
  }

  /** A text changed in the preview: only that run of the HTML is rewritten (escaped). */
  private writeRun(index: number, text: string) {
    const doc = this.app.active;
    const run = this.runs[index];
    // The positions belong to the text the page was drawn from: if it changed meanwhile, redraw.
    if (!doc || !run || this.app.view.state.doc !== this.runsDoc) {
      this.update(true);
      return;
    }
    const insert = escapeHtmlText(text);
    const delta = insert.length - (run.to - run.from);
    // Only the part that changed is written: typing groups into one undo step, as in the editor.
    const old = this.app.view.state.sliceDoc(run.from, run.to);
    let a = 0;
    while (a < old.length && a < insert.length && old[a] === insert[a]) a++;
    let b = 0;
    while (b < old.length - a && b < insert.length - a && old[old.length - 1 - b] === insert[insert.length - 1 - b]) b++;
    this.writingRun = true;
    try {
      this.app.applyToDoc(doc, { changes: { from: run.from + a, to: run.to - b, insert: insert.slice(a, insert.length - b) }, userEvent: "input.type" });
    } finally {
      this.writingRun = false;
    }
    run.to = run.from + insert.length;
    for (let i = index + 1; i < this.runs.length; i++) {
      this.runs[i].from += delta;
      this.runs[i].to += delta;
    }
    // The page already shows this text: no redraw (it would move the cursor).
    this.runsDoc = this.app.view.state.doc;
    this.rendered = this.runsDoc;
  }

  /** Called once the editor exists. */
  attach() {
    this.app.view.scrollDOM.addEventListener("scroll", () => this.follow(this.app.view.scrollDOM, this.md));
  }

  private follow(from: HTMLElement, to: HTMLElement) {
    if (this.pane.hidden || this.renderedKind !== "markdown" || this.syncing) return;
    const max = from.scrollHeight - from.clientHeight;
    const ratio = max > 0 ? from.scrollTop / max : 0;
    this.syncing = true;
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    requestAnimationFrame(() => (this.syncing = false));
  }

  /** The second view of the active document, if it has one. */
  get kind(): SideKind | null {
    return sideKindFor(this.app.active);
  }

  /** The pane is showing (the active document has a view, and it is on). */
  get visible(): boolean {
    const k = this.kind;
    return !!k && this.open.has(k);
  }

  toggle() {
    const k = this.kind;
    if (!k) {
      this.app.toastInfo("Second views: Markdown, HTML and SVG previews, a tree for JSON, YAML and XML, Mermaid diagrams, and a schema view for SQL. Switch the document type in the status bar if needed.");
      return;
    }
    if (this.open.has(k)) this.open.delete(k);
    else this.open.add(k);
    this.update(true);
    this.app.emit("workspace"); // saved with the session; buttons follow
    if (!this.open.has(k)) this.app.focusEditor();
  }

  update(force = false) {
    const show = this.visible;
    const kind = this.kind;
    this.pane.hidden = !show;
    this.resizer.hidden = !show;
    const area = document.getElementById("editor-area");
    area?.classList.toggle("with-preview", show);
    area?.classList.toggle("preview-only", show && this.only);
    area?.style.setProperty("--pv-size", `${(this.size * 100).toFixed(1)}%`);
    const svg = !!this.app.active?.path && extname(this.app.active.path) === "svg";
    this.editBtn.hidden = !show || kind !== "html" || svg;
    this.editBtn.classList.toggle("active", this.htmlEdit);
    this.editBtn.title = this.htmlEdit ? "Stop editing in the preview" : "Edit the text in the preview";
    const label = this.only ? "Show the editor again" : "Preview only (hide the editor)";
    if (this.onlyBtn.title !== label) {
      this.onlyBtn.title = label;
      this.onlyBtn.setAttribute("aria-label", label);
      this.onlyBtn.replaceChildren(icon(this.only ? "minimize" : "maximize"));
    }
    if (!show || !kind) {
      this.rendered = null;
      this.renderedKind = null;
      return;
    }
    const doc = this.app.view.state.doc;
    if (kind !== this.renderedKind) force = true;
    this.pane.dataset.kind = kind;
    this.md.hidden = kind !== "markdown";
    this.frame.el.hidden = kind !== "html";
    this.tree.el.hidden = kind !== "tree";
    this.diagram.el.hidden = kind !== "diagram";
    this.sql.el.hidden = kind !== "sql";
    if (this.writingRun && kind === "html") {
      this.rendered = doc;
      return;
    }
    if (force || doc !== this.rendered) {
      this.rendered = doc;
      this.renderedKind = kind;
      const text = doc.length > MAX_PREVIEW ? doc.sliceString(0, MAX_PREVIEW) : doc.toString();
      const active = this.app.active!;
      const name = active.path ? stem(active.path) : "diagram";
      if (kind === "markdown") {
        const top = this.md.scrollTop;
        this.md.replaceChildren(renderMarkdown(text, { taskCfg: this.app.taskCfg, today: todayISO() }));
        this.md.scrollTop = top;
        void this.drawMarkdownDiagrams();
      } else if (kind === "diagram") {
        void this.diagram.render(text, { dark: this.dark(), title: "MERMAID", name });
      } else if (kind === "sql") {
        this.sql.render(text, { dark: this.dark(), name });
      } else if (kind === "html") {
        const edit = this.htmlEdit && !svg;
        if (edit) {
          this.runs = markTextRuns(text).runs;
          this.runsDoc = doc;
        }
        void this.frame.show(text, svg ? "svg" : "html", edit);
      } else {
        void this.tree.render(active, doc, active.lang === "yaml" ? "yaml" : active.lang === "xml" ? "xml" : "json").then(() =>
          this.tree.followCursor(this.app.view.state.selection.main.head));
        return;
      }
    }
    if (kind === "tree") this.tree.followCursor(this.app.view.state.selection.main.head);
  }

  private dark(): boolean {
    return findTheme(this.app.settings.theme, matchMedia("(prefers-color-scheme: dark)").matches).dark;
  }

  /** ```mermaid blocks of a Markdown note, drawn in place of their code. */
  private async drawMarkdownDiagrams() {
    const token = ++this.mdToken;
    const blocks = [...this.md.querySelectorAll<HTMLElement>("pre > code[data-lang]")].filter((c) => /^mermaid\b/i.test(c.dataset.lang!));
    for (const code of blocks) {
      const pre = code.parentElement!;
      try {
        const svg = fixSvgSize(await renderMermaid(code.textContent ?? "", this.dark()));
        if (token !== this.mdToken) return;
        const img = h("img", { class: "md-diagram-img", alt: "Diagram", src: svgDataUrl(svg) });
        pre.replaceWith(h("figure", { class: "md-diagram" }, img));
      } catch (e) {
        if (token !== this.mdToken) return;
        pre.before(h("div", { class: "md-diagram-error" }, `Diagram: ${diagramError(e)}`));
      }
    }
  }
}
