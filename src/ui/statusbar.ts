// Barre d'état : position, tâches de la note, encodage, fins de ligne, langage.

import type { App } from "../app";
import { shortcutFor } from "../core/commands";
import { resolveColor } from "../core/themes";
import { LANG_LABELS, type LangId, reconfigureLanguage, settingsCompartment, settingsExtensions } from "../editor/setup";
import { findTasks } from "../editor/tasks";
import { debounce, h, icon } from "./dom";
import { showMenu } from "./overlay";

export class StatusBar {
  private left = h("div", { class: "st-left" });
  private right = h("div", { class: "st-right" });
  private pos = h("button", { class: "st-item", title: "Aller à la ligne (Ctrl+G)" });
  private words = h("span", { class: "st-item st-dim" });
  private tasks = h("button", { class: "st-item st-tasks", title: "Titres et tâches de la note (Ctrl+R)" });
  private encoding = h("span", { class: "st-item st-dim" });
  private eol = h("button", { class: "st-item", title: "Fins de ligne" });
  private lang = h("button", { class: "st-item", title: "Type de document" });
  private save = h("span", { class: "st-item st-save" });

  constructor(private app: App, el: HTMLElement) {
    const sidebarBtn = h("button", { class: "st-item st-icon", title: `Barre latérale (${shortcutFor("view.sidebar")})`, onclick: () => app.sidebar.toggle() }, icon("sidebar"));
    const themeBtn = h("button", { class: "st-item st-icon", title: "Thème", onclick: () => app.selectTheme() }, icon("palette"));
    const settingsBtn = h("button", { class: "st-item st-icon", title: `Paramètres (${shortcutFor("settings.open")})`, onclick: () => app.openSettings() }, icon("gear"));
    this.left.append(sidebarBtn, this.tasks);
    this.right.append(this.pos, this.words, this.encoding, this.eol, this.lang, this.save, themeBtn, settingsBtn);
    el.append(this.left, this.right);

    this.pos.addEventListener("click", () => app.openQuickOpen(":"));
    this.tasks.addEventListener("click", () => app.openQuickOpen("@"));
    this.eol.addEventListener("click", (e) => this.eolMenu(e));
    this.lang.addEventListener("click", (e) => this.langMenu(e));

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
    this.updateCounts();
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
    if (sel.ranges.length > 1) text += ` · ${sel.ranges.length} curseurs`;
    else if (!sel.main.empty) text += ` · ${Math.abs(sel.main.to - sel.main.from)} car.`;
    this.pos.textContent = text;
  }

  private updateCounts() {
    const doc = this.app.active;
    this.tasks.replaceChildren();
    if (!doc) {
      this.words.textContent = "";
      return;
    }
    const text = this.app.view.state.doc.toString();
    const words = text.length > 2_000_000 ? null : (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0);
    this.words.textContent = words == null ? "" : `${words} mot${words > 1 ? "s" : ""}`;
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
    this.encoding.title = converted ? "Sera enregistré en UTF-8" : "Encodage";
    this.eol.textContent = doc.eol === "\r\n" ? "CRLF" : "LF";
    this.lang.textContent = LANG_LABELS[doc.lang];
    this.save.replaceChildren();
    if (doc.missing) {
      this.save.textContent = "supprimé du disque";
      this.save.className = "st-item st-save warn";
    } else if (doc.dirty) {
      this.save.append(h("i", { class: "st-dot" }), this.app.settings.autosave && doc.path ? "enregistrement…" : "non enregistré");
      this.save.className = "st-item st-save dirty";
    } else if (doc.path) {
      this.save.append(icon("check"), this.app.settings.autosave ? "auto" : "enregistré");
      this.save.className = "st-item st-save ok";
    } else {
      this.save.textContent = "brouillon";
      this.save.className = "st-item st-save";
    }
  }

  private eolMenu(e: MouseEvent) {
    const doc = this.app.active;
    if (!doc) return;
    const set = (eol: "\n" | "\r\n") => {
      if (doc.eol === eol) return;
      doc.eol = eol;
      if (doc.path) {
        doc.mtime = doc.mtime || 0;
        void this.app.save(doc);
      }
      this.updateMeta();
    };
    showMenu(
      [
        { header: "Fins de ligne" },
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
      [{ header: "Type de document" }, ...(Object.keys(LANG_LABELS) as LangId[]).map((l) => ({ label: LANG_LABELS[l], checked: doc.lang === l, action: () => set(l) }))],
      e.clientX,
      (e.currentTarget as HTMLElement).getBoundingClientRect().top - 4,
    );
  }
}
