// Status bar: cursor position, tasks of the note, encoding, line endings, language.

import type { App } from "../app/app";
import { titleWithKey } from "../core/commands";
import { resolveColor } from "../core/themes";
import { isCodeLang, languageLabel } from "../editor/languages";
import { countLabel, goToOccurrence, LARGE_DOC, occurrences } from "../editor/matches";
import { findTasks } from "../text/tasks";
import { debounce, h, icon } from "./dom";
import { showMenu } from "./overlay";
import { openCheatSheet } from "./lazy";
import { SIDE_LABELS, sideKindFor } from "./views/preview";
import { openQuickOpen, selectLanguage, selectTheme } from "../app/pickers";

const ENCODINGS: [string, string][] = [
  ["UTF-8", "UTF-8"],
  ["UTF-8 BOM", "UTF-8 with BOM"],
  ["UTF-16 LE", "UTF-16 LE"],
  ["UTF-16 BE", "UTF-16 BE"],
  ["Windows-1252", "Windows-1252 (Western)"],
];

export class StatusBar {
  private left = h("div", { class: "st-left" });
  private right = h("div", { class: "st-right" });
  private pos = h("button", { class: "st-item", title: titleWithKey("Go to line", "palette.line") });
  private occurrences = h("button", { class: "st-item st-occ" });
  private words = h("span", { class: "st-item st-dim" });
  private tasks = h("button", { class: "st-item st-tasks", title: titleWithKey("Headings and tasks of this note", "palette.symbol") });
  private encoding = h("button", { class: "st-item st-dim", title: "Encoding: click to convert" });
  private eol = h("button", { class: "st-item", title: "Line endings" });
  private lang = h("button", { class: "st-item", title: titleWithKey("Document type (syntax coloring)", "view.language") });
  private save = h("button", { class: "st-item st-save" });
  private previewBtn = h("button", { class: "st-item st-icon st-preview" });
  private counted: unknown = null;

  constructor(private app: App, el: HTMLElement) {
    const sidebarBtn = h("button", { class: "st-item st-icon", title: titleWithKey("Sidebar", "view.sidebar"), onclick: () => app.sidebar.toggle() }, icon("sidebar"));
    const themeBtn = h("button", { class: "st-item st-icon", title: "Theme", onclick: () => selectTheme(app) }, icon("palette"));
    const settingsBtn = h("button", { class: "st-item st-icon", title: titleWithKey("Settings", "settings.open"), onclick: () => app.openSettings() }, icon("gear"));
    const keysBtn = h("button", { class: "st-item st-icon", title: titleWithKey("Keyboard shortcuts", "help.shortcuts"), onclick: () => void openCheatSheet(app) }, icon("keyboard"));
    this.left.append(sidebarBtn, this.tasks);
    this.right.append(this.pos, this.occurrences, this.words, this.encoding, this.eol, this.lang, this.previewBtn, this.save, themeBtn, keysBtn, settingsBtn);
    this.previewBtn.addEventListener("click", () => app.preview.toggle());
    el.append(this.left, this.right);

    this.pos.addEventListener("click", () => openQuickOpen(app, ":"));
    this.occurrences.addEventListener("click", (e) => {
      if (app.active && goToOccurrence(app.view, !e.shiftKey)) app.view.focus();
    });
    this.tasks.addEventListener("click", () => openQuickOpen(app, "@"));
    this.eol.addEventListener("click", (e) => this.eolMenu(e));
    this.encoding.addEventListener("click", (e) => this.encodingMenu(e));
    this.lang.addEventListener("click", () => selectLanguage(app));
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
    app.on("workspace", () => this.updateMeta());
  }

  private update() {
    this.updatePos();
    this.updateCounts(true);
    this.updateMeta();
  }

  /** The occurrences of a selection in a large note: counted once selecting pauses. */
  private occurrencesSoon = debounce(() => this.updateOccurrences(), 150);

  private updatePos() {
    const doc = this.app.active;
    if (doc && this.app.view.state.doc.length > LARGE_DOC && !this.app.view.state.selection.main.empty) this.occurrencesSoon();
    else this.updateOccurrences();
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

  /** How many times the selected text appears in the note. */
  private updateOccurrences() {
    const m = this.app.active ? occurrences(this.app.view.state) : null;
    this.occurrences.hidden = !m;
    if (!m) return;
    const many = m.from.length > 1;
    this.occurrences.classList.toggle("many", many);
    this.occurrences.textContent = many ? `${countLabel(m)} occurrences` : "only here";
    this.occurrences.title = many
      ? `The selected text appears ${countLabel(m)} times in this note (marked by the scrollbar).\n` +
        titleWithKey("Click: the next one · Shift+click: the previous one", "edit.nextOccurrence")
      : "The selected text appears nowhere else in this note";
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
    if (text.length > 2_000_000 || isCodeLang(doc.lang)) return;
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
    const side = sideKindFor(doc);
    this.previewBtn.hidden = !side;
    if (side) {
      const { icon: ic, title } = SIDE_LABELS[side];
      if (this.previewBtn.dataset.kind !== side) {
        this.previewBtn.dataset.kind = side;
        this.previewBtn.replaceChildren(icon(ic));
      }
      this.previewBtn.title = titleWithKey(title, "view.preview");
    }
    this.previewBtn.classList.toggle("active", !!this.app.preview?.visible);
    if (!doc) return;
    this.encoding.textContent = doc.encoding;
    this.eol.textContent = doc.eol === "\r\n" ? "CRLF" : "LF";
    this.lang.textContent = languageLabel(doc.lang);
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

  private encodingMenu(e: MouseEvent) {
    const doc = this.app.active;
    if (!doc) return;
    const set = (encoding: string) => {
      if (doc.encoding === encoding) return;
      doc.encoding = encoding;
      if (doc.path) void this.app.save(doc);
      this.updateMeta();
    };
    showMenu(
      [
        { header: "Save with encoding" },
        ...ENCODINGS.map(([id, label]) => ({ label, checked: doc.encoding === id, action: () => set(id) })),
      ],
      e.clientX,
      (e.currentTarget as HTMLElement).getBoundingClientRect().top - 4,
    );
  }
}
