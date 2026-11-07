// The pane next to the editor, for the documents that have a second view:
//   Markdown       → rendered preview (follows the scrolling)
//   HTML and SVG   → the page, in a sandboxed frame (html-preview.ts)
//   JSON and YAML  → an editable tree (tree-view.ts)
// Each view is turned on or off on its own (kept with the session).

import type { App, Doc } from "../app";
import { extname } from "../core/path";
import { renderMarkdown } from "../editor/markdown-render";
import { todayISO } from "../editor/tasks";
import { debounce, h } from "./dom";
import { HtmlFrame } from "./html-preview";
import { TreeView } from "./tree-view";

export type SideKind = "markdown" | "html" | "tree";

/** Above this size, only the beginning is previewed (keeps typing fluid). */
const MAX_PREVIEW = 1_000_000;

export function sideKindFor(doc: Doc | null | undefined): SideKind | null {
  if (!doc) return null;
  if (doc.lang === "markdown") return "markdown";
  if (doc.lang === "html" || (doc.path && extname(doc.path) === "svg")) return "html";
  if (doc.lang === "jsonc" || doc.lang === "yaml") return "tree";
  return null;
}

export const SIDE_LABELS: Record<SideKind, { label: string; icon: string; title: string }> = {
  markdown: { label: "Preview", icon: "eye", title: "Markdown preview" },
  html: { label: "Preview", icon: "eye", title: "Page preview" },
  tree: { label: "Tree", icon: "tree", title: "Tree view" },
};

export class Preview {
  /** The views the user turned on (for this window). */
  open = new Set<SideKind>();
  private pane: HTMLElement;
  private md = h("div", { class: "pv-md", tabindex: "-1" });
  private frame: HtmlFrame;
  private tree: TreeView;
  private rendered: unknown = null;
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
    // Created once and never moved: a moved frame would reload.
    pane.replaceChildren(this.md, this.frame.el, this.tree.el);
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
      // A page reloads its frame: a little more patience while typing.
      if (this.kind === "html") slow();
      else soon();
    });
    app.on("active", () => this.update(true));
    app.on("settings", () => this.update(true));
    app.on("docs", () => this.update());
    // The preview follows the editor's scrolling.
    this.md.addEventListener("scroll", () => this.follow(this.md, app.view.scrollDOM));
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
      this.app.toastInfo("The preview is for Markdown, HTML and SVG files; JSON and YAML files get a tree view. Switch the document type in the status bar if needed.");
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
    document.getElementById("editor-area")?.classList.toggle("with-preview", show);
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
    if (force || doc !== this.rendered) {
      this.rendered = doc;
      this.renderedKind = kind;
      const text = doc.length > MAX_PREVIEW ? doc.sliceString(0, MAX_PREVIEW) : doc.toString();
      const active = this.app.active!;
      if (kind === "markdown") {
        const top = this.md.scrollTop;
        this.md.replaceChildren(renderMarkdown(text, { taskCfg: this.app.taskCfg, today: todayISO() }));
        this.md.scrollTop = top;
      } else if (kind === "html") {
        void this.frame.show(text, active.path && extname(active.path) === "svg" ? "svg" : "html");
      } else {
        void this.tree.render(active, doc.toString(), active.lang === "yaml" ? "yaml" : "json").then(() =>
          this.tree.followCursor(this.app.view.state.selection.main.head));
        return;
      }
    }
    if (kind === "tree") this.tree.followCursor(this.app.view.state.selection.main.head);
  }
}
