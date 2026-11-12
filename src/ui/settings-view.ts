// Settings screen: every option of settings.json with a control. Each change is
// written to settings.json right away (comments kept) and applies immediately.

import type { App } from "../app/app";
import { shortcutFor } from "../core/commands";
import type { Settings } from "../core/settings";
import { findTheme, MASCOT_VARIANTS, PALETTE_LABELS, PALETTE_NAMES, resolveColor, THEMES } from "../core/themes";
import { h, icon } from "./dom";
import { ICON_PACKS } from "./icons";
import { confirm, showMenu } from "./overlay";
import { openCheatSheet } from "./lazy";
import { listCommands, selectTheme } from "../app/pickers";

export type SettingsSection = "appearance" | "editor" | "files" | "tasks" | "shortcuts";
const SECTIONS: [SettingsSection, string, string][] = [
  ["appearance", "Appearance", "palette"],
  ["editor", "Editor", "file"],
  ["files", "Files", "folder"],
  ["tasks", "Tasks", "tasks"],
  ["shortcuts", "Shortcuts", "keyboard"],
];

let open: SettingsView | null = null;

export function showSettingsView(app: App, section: SettingsSection = "appearance") {
  if (open) open.show(section);
  else open = new SettingsView(app, section);
}

class SettingsView {
  private backdrop: HTMLElement;
  private content = h("div", { class: "kn-settings-content" });
  private nav = h("nav", { class: "kn-settings-nav" });
  private section: SettingsSection;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector(".kn-menu")) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  constructor(private app: App, section: SettingsSection) {
    this.section = section;
    for (const [id, label, ic] of SECTIONS) {
      this.nav.append(h("button", { class: "kn-settings-tab", "data-section": id, onclick: () => this.show(id) }, icon(ic), h("span", {}, label)));
    }
    const panel = h(
      "div",
      { class: "kn-settings", role: "dialog", "aria-label": "Settings" },
      h("div", { class: "kn-settings-head" },
        h("div", { class: "kn-modal-title" }, "Settings"),
        h("span", { class: "kn-spacer" }),
        h("button", { class: "kn-icon-btn", title: "Close (Esc)", onclick: () => this.close() }, icon("x"))),
      h("div", { class: "kn-settings-body" }, this.nav, this.content),
      h("div", { class: "kn-settings-foot" },
        h("button", { class: "kn-btn subtle", onclick: () => { this.close(); void app.openSettings(true); } }, "Open settings.json"),
        h("button", { class: "kn-btn subtle", onclick: () => this.reset() }, "Reset to defaults"),
        h("span", { class: "kn-spacer" }),
        h("button", { class: "kn-btn primary", onclick: () => this.close() }, "Done")),
    );
    // "kn-modal-backdrop": global shortcuts stay off while the screen is open.
    this.backdrop = h("div", { class: "kn-modal-backdrop kn-settings-backdrop" }, panel);
    this.backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.backdrop) this.close();
    });
    document.getElementById("overlay-root")!.append(this.backdrop);
    document.addEventListener("keydown", this.onKey, true);
    this.show(section);
  }

  show(section: SettingsSection) {
    this.section = section;
    this.nav.querySelectorAll<HTMLElement>(".kn-settings-tab").forEach((b) => b.classList.toggle("active", b.dataset.section === section));
    this.render();
  }

  private close() {
    this.backdrop.remove();
    document.removeEventListener("keydown", this.onKey, true);
    open = null;
    this.app.focusEditor();
  }

  private async reset() {
    const r = await confirm({
      title: "Reset every setting?",
      message: "settings.json goes back to the default values (your current file is kept in the local history).",
      okLabel: "Reset",
      danger: true,
    });
    if (r !== "ok") return;
    await this.app.resetSettings();
    this.render();
  }

  private get s(): Settings {
    return this.app.settings;
  }

  private async set<K extends keyof Settings>(key: K, value: Settings[K]) {
    await this.app.updateSetting(key, value);
    // The accent swatches show the colors of the theme.
    if (key === "theme") this.render();
  }

  // -------------------------------------------------------------------------
  // Controls

  private row(label: string, control: HTMLElement, hint?: string) {
    // A <label> forwards clicks to its first control: not for a row of buttons (swatches).
    const tag = control.matches("button") || control.querySelector("button") ? "div" : "label";
    return h(tag, { class: "kn-set-row" }, h("span", { class: "kn-set-label" }, label, hint ? h("small", {}, hint) : null), control);
  }

  private toggle<K extends keyof Settings>(key: K, label: string, hint?: string) {
    const input = h("input", { type: "checkbox", class: "kn-switch" }) as HTMLInputElement;
    input.checked = !!this.s[key];
    input.addEventListener("change", () => void this.set(key, input.checked as Settings[K]));
    return this.row(label, input, hint);
  }

  private select<K extends keyof Settings>(key: K, label: string, options: [string, string][], hint?: string) {
    const sel = h("select", { class: "kn-input kn-select" }, ...options.map(([v, t]) => h("option", { value: v }, t))) as HTMLSelectElement;
    sel.value = String(this.s[key]);
    sel.addEventListener("change", () => void this.set(key, sel.value as Settings[K]));
    return this.row(label, sel, hint);
  }

  private number<K extends keyof Settings>(key: K, label: string, opts: { min: number; max: number; step?: number; unit?: string }) {
    const input = h("input", { type: "number", class: "kn-input kn-number", min: opts.min, max: opts.max, step: opts.step ?? 1 }) as HTMLInputElement;
    input.value = String(this.s[key]);
    input.addEventListener("change", async () => {
      const n = Number(input.value);
      if (!Number.isFinite(n)) return;
      await this.set(key, n as Settings[K]);
      input.value = String(this.s[key]); // shows the value once clamped
    });
    return this.row(label, h("span", { class: "kn-set-inline" }, input, opts.unit ? h("small", {}, opts.unit) : null));
  }

  private text<K extends keyof Settings>(key: K, label: string, hint?: string) {
    const input = h("input", { type: "text", class: "kn-input", spellcheck: "false" }) as HTMLInputElement;
    input.value = String(this.s[key] ?? "");
    input.addEventListener("change", async () => {
      await this.set(key, input.value as Settings[K]);
      input.value = String(this.s[key] ?? "");
    });
    return this.row(label, input, hint);
  }

  /** A list edited as "a, b, c". */
  private list<K extends keyof Settings>(key: K, label: string, hint?: string) {
    const input = h("input", { type: "text", class: "kn-input", spellcheck: "false" }) as HTMLInputElement;
    const show = () => (input.value = (this.s[key] as string[]).join(", "));
    show();
    input.addEventListener("change", async () => {
      const items = input.value.split(",").map((x) => x.trim()).filter(Boolean);
      await this.set(key, items as Settings[K]);
      show();
    });
    return this.row(label, input, hint ?? "Separated by commas");
  }

  private heading(title: string) {
    return h("h3", { class: "kn-set-heading" }, title);
  }

  // -------------------------------------------------------------------------
  // Sections

  private render() {
    const body = this.sectionBody();
    this.content.replaceChildren(...body);
    this.content.scrollTop = 0;
  }

  private sectionBody(): HTMLElement[] {
    switch (this.section) {
      case "appearance":
        return this.appearance();
      case "editor":
        return [
          this.heading("Display"),
          this.toggle("line_numbers", "Line numbers"),
          this.toggle("word_wrap", "Word wrap", "Long lines wrap instead of scrolling (Alt+Z)"),
          this.toggle("highlight_active_line", "Highlight the current line"),
          this.toggle("scrollbar_marks", "Marks along the scrollbar", "Headings, open tasks, other occurrences of the selection, search matches"),
          this.heading("Typing"),
          this.toggle("slash_commands", "Quick inserts with /", "In a note, \"/\" at the start of a line or after a space: /today, /todo, /h1, /link, /secret, templates…"),
          this.heading("Images"),
          this.toggle("show_images", "Show images in notes", "Under their line: ![image](images/shot.png)"),
          this.text("images_folder", "Folder of pasted images", "Next to the note (Ctrl+V a screenshot in a note)"),
          this.heading("Indentation"),
          this.number("tab_size", "Tab size", { min: 1, max: 12 }),
          this.toggle("indent_with_tabs", "Indent with tabs", "Otherwise with spaces"),
        ];
      case "files":
        return [
          this.heading("Saving"),
          this.toggle("autosave", "Save automatically", "After a short pause in typing"),
          this.number("autosave_delay", "Autosave delay", { min: 100, max: 60000, step: 100, unit: "ms" }),
          this.toggle("hot_exit", "Keep unsaved tabs between sessions"),
          this.select("default_line_ending", "Line ending of new files", [["system", "System default"], ["lf", "LF (Linux, macOS)"], ["crlf", "CRLF (Windows)"]]),
          this.heading("Folder"),
          this.toggle("show_hidden_files", "Show hidden files"),
          this.list("note_extensions", "Note extensions", "Used by quick open, the tasks panel and the report"),
          this.text("daily_notes_folder", "Folder of daily notes", "In the open folder (File: Today's note, Ctrl+Alt+D)"),
        ];
      case "tasks":
        return this.tasks();
      case "shortcuts":
        return this.shortcuts();
    }
  }

  private appearance(): HTMLElement[] {
    const app = this.app;
    const themeOptions: [string, string][] = [["auto", "Automatic (follows the system)"], ...THEMES.map((t) => [t.id, t.label] as [string, string])];
    // Accent: the theme's own colors, or any color.
    const theme = findTheme(this.s.theme, matchMedia("(prefers-color-scheme: dark)").matches);
    const swatches = h("div", { class: "kn-set-swatches" });
    const custom = h("input", { type: "color", class: "kn-color", title: "Any color" }) as HTMLInputElement;
    const renderSwatches = () => {
      const current = this.s.accent;
      swatches.replaceChildren(
        h("button", { class: `kn-swatch none${current ? "" : " selected"}`, title: "Theme color", onclick: () => pick(null) }),
        ...PALETTE_NAMES.map((n) => {
          const hex = (theme.colors as Record<string, string>)[n];
          return h("button", { class: `kn-swatch${current === hex ? " selected" : ""}`, title: PALETTE_LABELS[n], style: { "--c": resolveColor(n) }, onclick: () => pick(hex) });
        }),
        custom,
      );
      custom.value = /^#[0-9a-f]{6}$/i.test(current ?? "") ? current! : "#9284f7";
    };
    const pick = async (hex: string | null) => {
      await this.set("accent", hex);
      renderSwatches();
    };
    custom.addEventListener("change", () => void pick(custom.value));
    renderSwatches();
    const mascotOptions: [string, string][] = [["theme", "Accent color"], ...Object.keys(MASCOT_VARIANTS).map((v) => [v, v[0].toUpperCase() + v.slice(1)] as [string, string])];
    return [
      this.heading("Colors"),
      this.select("theme", "Theme", themeOptions),
      this.row("Accent color", swatches),
      this.select("mascot", "Kilo's color", mascotOptions, "The mascot of the welcome screen and the assistant"),
      this.toggle("assistant", "Kilo, the assistant", "In a corner of the editor: hints about what you write and tips, once the typing pauses"),
      this.heading("Icons"),
      this.iconPacks(),
      this.heading("Text"),
      this.text("font_family", "Editor font", "A list of fonts, the first one installed is used"),
      this.number("font_size", "Editor text size", { min: 8, max: 40, unit: "px" }),
      this.number("line_height", "Line height", { min: 1, max: 3, step: 0.05 }),
      this.number("ui_font_size", "Interface text size", { min: 9, max: 22, unit: "px" }),
      this.number("ui_zoom", "Zoom of the whole interface", { min: 50, max: 300, step: 10, unit: "%" }),
      h("p", { class: "kn-set-note" }, "Tip: Ctrl+= / Ctrl+- / Ctrl+0 zoom the whole interface, Ctrl+wheel changes the editor text size only. Every theme color can be overridden in settings.json (\"colors\")."),
      h("button", { class: "kn-btn subtle kn-set-link", onclick: () => selectTheme(app) }, icon("palette"), "Preview the themes one by one…"),
    ];
  }

  /** The icon packs, each previewed with a few of its icons. */
  private iconPacks(): HTMLElement {
    const wrap = h("div", { class: "kn-set-packs", role: "radiogroup", "aria-label": "Icon pack" });
    const sample: [string, string][] = [["folder", "ft-dir"], ["fileMd", "ft-markdown"], ["fileJson", "ft-json"], ["fileCode", "ft-code"], ["search", ""], ["gear", ""]];
    const render = () => {
      wrap.replaceChildren(
        ...ICON_PACKS.map((p) =>
          h("button", {
            class: `kn-set-pack${this.s.icon_pack === p.id ? " selected" : ""}`,
            role: "radio",
            "aria-checked": String(this.s.icon_pack === p.id),
            "data-pack": p.id,
            onclick: async () => {
              await this.set("icon_pack", p.id);
              render();
            },
          },
          h("span", { class: "kn-set-pack-icons" }, ...sample.map(([n, cls]) => icon(n, cls, p.id))),
          h("span", { class: "kn-set-pack-name" }, p.label),
          h("small", {}, p.hint)),
        ),
      );
    };
    render();
    return wrap;
  }

  private tasks(): HTMLElement[] {
    const rows = h("div", { class: "kn-set-statuses" });
    const save = (entries: [string, string][]) => this.set("task_statuses", Object.fromEntries(entries.filter(([n]) => n.trim()).map(([n, c]) => [n.trim().toLowerCase(), c])));
    const render = () => {
      const entries = Object.entries(this.s.task_statuses);
      rows.replaceChildren(
        ...entries.map(([name, color], i) => {
          const input = h("input", { type: "text", class: "kn-input", value: name, spellcheck: "false" }) as HTMLInputElement;
          input.addEventListener("change", async () => {
            entries[i] = [input.value, color];
            await save(entries);
            render();
          });
          const swatch = h("button", { class: "kn-swatch", title: "Color", style: { "--c": resolveColor(color) } });
          swatch.addEventListener("click", (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu([{ header: `Color of "${name}"` }, {
              colors: [...PALETTE_NAMES], selected: color, onPick: async (c) => {
                entries[i] = [name, c ?? "grey"];
                await save(entries);
                render();
              },
            }], r.left, r.bottom + 4);
          });
          const del = h("button", { class: "kn-icon-btn", title: `Remove "${name}"` }, icon("x"));
          del.addEventListener("click", async () => {
            entries.splice(i, 1);
            await save(entries);
            render();
          });
          return h("div", { class: "kn-set-status" }, swatch, input, del);
        }),
        h("button", { class: "kn-btn subtle kn-set-add", onclick: async () => {
          let n = 1;
          while (`status${n}` in this.s.task_statuses) n++;
          await save([...entries, [`status${n}`, "grey"]]);
          render();
          (rows.querySelector(".kn-set-status:last-of-type input") as HTMLInputElement | null)?.select();
        } }, icon("plus"), "Add a status"),
      );
    };
    render();
    return [
      this.heading("Statuses"),
      h("p", { class: "kn-set-note" }, 'A task is a line that ends with " - <status>", e.g. "- call colleague X - todo".'),
      rows,
      this.list("task_cycle", "Ctrl+Enter cycles through", "Statuses, in order"),
      this.list("task_done_statuses", "Completed statuses"),
      this.list("task_ongoing_statuses", "In-progress statuses"),
      this.list("task_blocked_statuses", "Blocked statuses"),
      this.heading("Archive"),
      this.text("archive_suffix", "Archive file suffix", "work.txt → work_done.txt"),
      this.text("archive_status", "Status written to the archive", "Unless the task is already completed"),
      this.toggle("archive_date", "Add the archive date", '"- call X - done [2026-11-02]"'),
      this.toggle("auto_archive", "Archive completed tasks automatically", "As soon as a task gets a completed status"),
    ];
  }

  private shortcuts(): HTMLElement[] {
    const rows = listCommands(this.app)
      .map((c) => ({ title: c.title, key: shortcutFor(c.id), id: c.id }))
      .sort((a, b) => a.title.localeCompare(b.title));
    return [
      this.toggle("show_shortcuts_at_startup", "Show the cheat sheet at startup", "The main shortcuts, on one screen"),
      h("button", { class: "kn-btn subtle kn-set-link", onclick: () => { this.close(); void openCheatSheet(this.app); } }, icon("keyboard"), "Open the cheat sheet"),
      this.heading("All commands"),
      h("p", { class: "kn-set-note" }, 'To change a shortcut, add it to "keybindings" in settings.json, e.g. { "Ctrl+Alt+T": "task.cycle" }; an empty command id disables a shortcut.'),
      h("div", { class: "kn-set-keys" },
        ...rows.map((r) => h("div", { class: "kn-set-key", title: r.id }, h("span", {}, r.title), r.key ? h("kbd", {}, r.key) : h("small", {}, "—")))),
      h("button", { class: "kn-btn subtle kn-set-link", onclick: () => { this.close(); void this.app.openSettings(true); } }, icon("gear"), "Edit the shortcuts in settings.json"),
    ];
  }
}

