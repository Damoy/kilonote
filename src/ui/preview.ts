// Markdown preview, next to the editor (Markdown notes only).

import type { App } from "../app";
import { renderMarkdown } from "../editor/markdown-render";
import { todayISO } from "../editor/tasks";
import { debounce } from "./dom";

/** Above this size, only the beginning is previewed (keeps typing fluid). */
const MAX_PREVIEW = 1_000_000;

export class Preview {
  /** The user's choice for this window (kept in the session). */
  visible = false;
  private pane: HTMLElement;
  private rendered: unknown = null;
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
    pane.tabIndex = -1;
    // Links: only http(s) and mailto, opened in the browser.
    pane.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("a[data-url]");
      if (!a) return;
      e.preventDefault();
      void app.backend.openUrl(a.dataset.url!);
    });
    const soon = debounce(() => this.update(), 160);
    app.on("selection", soon);
    app.on("active", () => this.update(true));
    app.on("settings", () => this.update(true));
    app.on("docs", () => this.update());
    // The preview follows the editor's scrolling.
    pane.addEventListener("scroll", () => this.follow(pane, app.view.scrollDOM));
  }

  /** Called once the editor exists. */
  attach() {
    this.app.view.scrollDOM.addEventListener("scroll", () => this.follow(this.app.view.scrollDOM, this.pane));
  }

  private follow(from: HTMLElement, to: HTMLElement) {
    if (this.pane.hidden || this.syncing) return;
    const max = from.scrollHeight - from.clientHeight;
    const ratio = max > 0 ? from.scrollTop / max : 0;
    this.syncing = true;
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    requestAnimationFrame(() => (this.syncing = false));
  }

  get applies() {
    return this.visible && this.app.active?.lang === "markdown";
  }

  toggle() {
    if (this.app.active && this.app.active.lang !== "markdown") {
      this.app.toastInfo("The preview shows Markdown notes (.md): switch the document type in the status bar to preview this one.");
      return;
    }
    this.visible = !this.visible;
    this.update(true);
    this.app.emit("workspace"); // saved with the session
    if (!this.visible) this.app.focusEditor();
  }

  update(force = false) {
    const show = this.applies;
    this.pane.hidden = !show;
    document.getElementById("editor-area")?.classList.toggle("with-preview", show);
    if (!show) {
      this.rendered = null;
      return;
    }
    const doc = this.app.view.state.doc;
    if (!force && doc === this.rendered) return;
    this.rendered = doc;
    const text = doc.length > MAX_PREVIEW ? doc.sliceString(0, MAX_PREVIEW) : doc.toString();
    const top = this.pane.scrollTop;
    this.pane.replaceChildren(renderMarkdown(text, { taskCfg: this.app.taskCfg, today: todayISO() }));
    this.pane.scrollTop = top;
  }
}
