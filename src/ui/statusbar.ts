// Status bar: cursor position, tasks of the note, encoding, line endings, language.

import type { App } from "../app";
import { titleWithKey } from "../core/commands";
import { resolveColor } from "../core/themes";
import { LANG_LABELS, type LangId, reconfigureLanguage, settingsCompartment, settingsExtensions } from "../editor/setup";
import { findTasks } from "../editor/tasks";
import { debounce, h, icon } from "./dom";
import { showMenu } from "./overlay";

export class StatusBar {
  private left = h("div", { class: "st-left" });
  private right = h("div", { class: "st-right" });
  private pos = h("button", { class: "st-item", title: titleWithKey("Go to line", "palette.line") });
  private words = h("span", { class: "st-item st-dim" });
  private tasks = h("button", { class: "st-item st-tasks", title: titleWithKey("Headings and tasks of this note", "palette.symbol") });
  private encoding = h("span", { class: "st-item st-dim" });
  private eol = h("button", { class: "st-item", title: "Line endings" });
  private lang = h("button", { class: "st-item", title: "Document type" });
  private save = h("button", { class: "st-item st-save" });
  private counted: unknown = null;

  constructor(private app: App, el: HTMLElement) {
    const sidebarBtn = h("button", { class: "st-item st-icon", title: titleWithKey("Sidebar", "view.sidebar"), onclick: () => app.sidebar.toggle() }, icon("sidebar"));
    const themeBtn = h("button", { class: "st-item st-icon", title: "Theme", onclick: () => app.selectTheme() }, icon("palette"));
    const settingsBtn = h("button", { class: "st-item st-icon", title: titleWithKey("Settings", "settings.open"), onclick: () => app.openSettings() }, icon("gear"));
    this.left.append(sidebarBtn, this.tasks);
    this.right.append(this.pos, this.words, this.encoding, this.eol, this.lang, this.save, themeBtn, settingsBtn);
    el.append(this.left, this.right);

    this.pos.addEventListener("click", () => app.openQuickOpen(":"));
    this.tasks.addEventListener("click", () => app.openQuickOpen("@"));
    this.eol.addEventListener("click", (e) => this.eolMenu(e));
    this.lang.addEventListener("click", (e) => this.langMenu(e));
    this.save.addEventListener("click", (e) => {
      const doc = app.active;
      if (!doc?.conflict) return;
      showMenu(
        [
          { header: "Conflict with the file on disk" },
          { label: "Reload the version on disk", icon: "refresh", action: () => app.resolveConflict(doc, "disk") },
          { label: "Keep mine (overwrite)", icon: "check", action: () => app.resolveConflict(doc, "mine") },
        ],
        e.clientX,
        (e.currentTarget as HTMLElement).getBoundingClientRect().top - 4,
      );
    });

    const slow = debounce(() => this.updateCounts(), 250);
    app.on("selection", () => {
      this.updatePos();
      slow();
    });
    app.on("active", () => this.update());
    app.on("docs", () => this.updateMeta());
    app.on("settings", () => this.update());
  }

  private update() {
    this.updatePos();
    this.updateCounts(true);
    this.updateMeta();
  }

  private updatePos() {
    const doc = this.app.active;
    if (!doc) {
      this.pos.textContent = "";
      return;
    }
    const st = this.app.view.state;
    const sel = st.selection;
    const head = sel.main.head;
    const line = st.doc.lineAt(head);
    let text = `Ln ${line.number}, Col ${head - line.from + 1}`;
    if (sel.ranges.length > 1) text += ` · ${sel.ranges.length} cursors`;
    else if (!sel.main.empty) {
      const n = sel.main.to - sel.main.from;
      text += ` · ${n} char${n > 1 ? "s" : ""}`;
    }
    this.pos.textContent = text;
  }

  /** Words and tasks: recomputed only when the text changed. */
  private updateCounts(force = false) {
    const doc = this.app.active;
    const current = doc ? this.app.view.state.doc : null;
    if (!force && current === this.counted) return;
    this.counted = current;
    this.tasks.replaceChildren();
    if (!doc) {
      this.words.textContent = "";
      return;
    }
    const text = this.app.view.state.doc.toString();
    const words = text.length > 2_000_000 ? null : (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0);
    this.words.textContent = words == null ? "" : `${words} word${words === 1 ? "" : "s"}`;
    if (text.length > 2_000_000 || doc.lang === "jsonc") return;
    const cfg = this.app.taskCfg;
    const counts = new Map<string, number>();
    for (const t of findTasks(text, cfg)) counts.set(t.task.key, (counts.get(t.task.key) ?? 0) + 1);
    for (const name of Object.keys(cfg.statuses)) {
      const n = counts.get(name);
      if (!n) continue;
      this.tasks.append(h("span", { class: "st-task", style: { "--c": resolveColor(cfg.statuses[name]) } }, h("i", {}), `${n} ${name}`));
    }
  }

  private updateMeta() {
    const doc = this.app.active;
    const show = !!doc;
    for (const el of [this.encoding, this.eol, this.lang, this.save]) el.hidden = !show;
    if (!doc) return;
    const converted = doc.encoding !== "UTF-8" && doc.encoding !== "UTF-8 BOM";
    this.encoding.textContent = doc.encoding;
    this.encoding.title = converted ? "Will be saved as UTF-8" : "Encoding";
    this.eol.textContent = doc.eol === "\r\n" ? "CRLF" : "LF";
    this.lang.textContent = LANG_LABELS[doc.lang];
    this.save.replaceChildren();
    this.save.title = "";
    if (doc.conflict) {
      this.save.textContent = "conflict";
      this.save.title = "Modified by another program: click to choose";
      this.save.className = "st-item st-save warn";
    } else if (doc.missing) {
      this.save.textContent = "deleted from disk";
      this.save.className = "st-item st-save warn";
    } else if (doc.dirty) {
      this.save.append(h("i", { class: "st-dot" }), this.app.settings.autosave && doc.path ? "saving…" : "unsaved");
      this.save.className = "st-item st-save dirty";
    } else if (doc.path) {
      this.save.append(icon("check"), this.app.settings.autosave ? "auto" : "saved");
      this.save.className = "st-item st-save ok";
    } else {
      this.save.textContent = "draft";
      this.save.className = "st-item st-save";
    }
  }

  private eolMenu(e: MouseEvent) {
    const doc = this.app.active;
    if (!doc) return;
    const set = (eol: "\n" | "\r\n") => {
      if (doc.eol === eol) return;
      doc.eol = eol;
      if (doc.path) void this.app.save(doc);
      this.updateMeta();
    };
    showMenu(
      [
        { header: "Line endings" },
        { label: "LF (Linux, macOS)", checked: doc.eol === "\n", action: () => set("\n") },
        { label: "CRLF (Windows)", checked: doc.eol === "\r\n", action: () => set("\r\n") },
      ],
      e.clientX,
      (e.currentTarget as HTMLElement).getBoundingClientRect().top - 4,
    );
  }

  private langMenu(e: MouseEvent) {
    const doc = this.app.active;
    if (!doc) return;
    const set = (lang: LangId) => {
      doc.lang = lang;
      this.app.applyToDoc(doc, {
        effects: [reconfigureLanguage(lang), settingsCompartment.reconfigure(settingsExtensions(this.app.settings, this.app.taskCfg, lang))],
      });
      this.updateMeta();
    };
    showMenu(
      [{ header: "Document type" }, ...(Object.keys(LANG_LABELS) as LangId[]).map((l) => ({ label: LANG_LABELS[l], checked: doc.lang === l, action: () => set(l) }))],
      e.clientX,
      (e.currentTarget as HTMLElement).getBoundingClientRect().top - 4,
    );
  }
}
