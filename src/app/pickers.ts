// The pickers: command palette, Go to file / line / heading, themes, accent
// color, Kilo's color and document type.

import { runCommand, shortcutFor, type Command } from "../core/commands";
import { basename, dirname, isDoneFile, relative } from "../core/path";
import { applyMascot, findTheme, MASCOT_VARIANTS, PALETTE_LABELS, THEMES } from "../core/themes";
import { fuzzyFilter } from "../core/fuzzy";
import { type LangId } from "../editor/setup";
import { LANGUAGES } from "../editor/languages";
import { parseTask } from "../text/tasks";
import { openPicker, type PickItem } from "../ui/palette";
import type { App, Doc } from "./app";

/** Picker of the document types (status bar, palette). */
export function selectLanguage(app: App, doc = app.active) {
  if (!doc) return;
  const items = LANGUAGES.map((l) => ({ id: l.id, label: l.label, detail: l.exts.slice(0, 5).map((e) => `.${e}`).join("  ") }));
  openPicker({
    placeholder: "Document type",
    initial: Math.max(0, items.findIndex((l) => l.id === doc.lang)),
    provide: (q) => ({
      items: fuzzyFilter(q, items, (l) => `${l.label} ${l.detail}`).map(({ item, result }) => ({
        label: item.label,
        detail: item.detail,
        icon: item.id === "text" ? "file" : item.id === "markdown" ? "fileMd" : item.id === "jsonc" ? "fileJson" : "fileCode",
        positions: result.positions.filter((i) => i < item.label.length),
        value: item.id,
        hint: item.id === doc.lang ? "current" : undefined,
      })),
      empty: "No such document type",
    }),
    pick: (it) => app.setLang(doc, it.value as LangId),
  });
}

export function openCommandPalette(app: App, query = "") {
  openPicker({
    placeholder: "Command…",
    query,
    provide: (q) => {
      const cmds = paletteCommands(app);
      return {
        items: fuzzyFilter(q, cmds, (c) => c.title).map(({ item, result }) => ({
          label: item.title, hint: shortcutFor(item.id), icon: "command", positions: result.positions, value: item.id,
        })),
        empty: "No matching command",
      };
    },
    pick: (it) => runCommand(it.value as string),
  });
}

export function paletteCommands(app: App): Command[] {
  return [...app.commandList].filter((c) => !c.hidden);
}

export function listCommands(app: App): Command[] {
  return paletteCommands(app);
}

export function openQuickOpen(app: App, prefix = "") {
  openPicker({
    placeholder: "File…   ( > commands   : line   @ headings and tasks )",
    query: prefix,
    provide: (q) => {
      if (q.startsWith(">")) return provideCommands(app, q.slice(1));
      if (q.startsWith(":")) {
        const n = parseInt(q.slice(1), 10);
        const total = app.active ? app.view.state.doc.lines : 0;
        return { items: [], empty: app.active ? (n ? `Press Enter to go to line ${Math.min(n, total)} / ${total}` : `Line number (1 – ${total})`) : "No open file" };
      }
      if (q.startsWith("@")) return provideSymbols(app, q.slice(1));
      return provideFiles(app, q);
    },
    pick: (it, q) => {
      if (q.startsWith(">")) return runCommand(it.value as string);
      if (q.startsWith("@")) return app.active && app.reveal(app.active, it.value as number);
      const v = it.value as { doc?: Doc; path?: string };
      if (v.doc) app.activate(v.doc);
      else if (v.path) return app.openFile(v.path);
    },
    submit: (q) => {
      const n = parseInt(q.slice(1), 10);
      if (q.startsWith(":") && n && app.active) {
        app.reveal(app.active, n);
        return true;
      }
      return false;
    },
  });
}

export function provideCommands(app: App, q: string) {
  return {
    items: fuzzyFilter(q, paletteCommands(app), (c) => c.title).map(({ item, result }) => ({
      label: item.title, hint: shortcutFor(item.id), icon: "command", positions: result.positions, value: item.id,
    })),
    empty: "No matching command",
  };
}

export function provideSymbols(app: App, q: string) {
  if (!app.active) return { items: [], empty: "No open file" };
  const doc = app.view.state.doc;
  const symbols: { label: string; line: number; icon: string; color?: string }[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    const h = /^(#{1,6})\s+(.*)$/.exec(text);
    if (h) symbols.push({ label: `${"  ".repeat(h[1].length - 1)}${h[2]}`, line: i, icon: "chevron" });
    else {
      const t = text.length > 4 ? parseTask(text, app.taskCfg) : null;
      if (t) symbols.push({ label: `${t.text}  · ${t.status}`, line: i, icon: "tasks", color: app.taskCfg.statuses[t.key] });
    }
  }
  return {
    items: fuzzyFilter(q, symbols, (s) => s.label).map(({ item, result }) => ({
      label: item.label, icon: item.icon, color: item.color, hint: `L${item.line}`, positions: result.positions, value: item.line,
    })),
    empty: "No heading or task in app note",
  };
}

export function provideFiles(app: App, q: string) {
  const items: { label: string; detail: string; doc?: Doc; path?: string; open: boolean }[] = [];
  const seen = new Set<string>();
  for (const d of app.docs) {
    items.push({ label: app.docName(d), detail: d.path ? relative(app.workspace, dirname(d.path)) || "·" : "unsaved", doc: d, open: true });
    if (d.path) seen.add(d.path);
  }
  for (const p of app.workspaceFiles) {
    if (seen.has(p) || !app.isNoteFile(p)) continue;
    items.push({ label: basename(p), detail: relative(app.workspace, dirname(p)) || "·", path: p, open: false });
  }
  const results = fuzzyFilter(q, items, (it) => (it.detail === "·" ? it.label : `${it.detail}/${it.label}`));
  return {
    items: results.map(({ item, result }) => {
      const offset = item.detail === "·" ? 0 : item.detail.length + 1;
      return {
        label: item.label,
        detail: item.detail === "·" ? undefined : item.detail,
        positions: result.positions.filter((p) => p >= offset).map((p) => p - offset),
        detailPositions: result.positions.filter((p) => p < offset),
        icon: isDoneFile(item.label, app.settings.archive_suffix) ? "fileDone" : "file",
        hint: item.open ? "open" : undefined,
        value: { doc: item.doc, path: item.path },
      } satisfies PickItem;
    }),
    empty: app.workspace ? "No matching file" : `Open a folder to search your notes (${shortcutFor("folder.open")})`,
  };
}

export function selectTheme(app: App) {
  const original = app.settings.theme;
  const items = [{ id: "auto", label: "Automatic — follows the system" }, ...THEMES.map((t) => ({ id: t.id, label: t.label }))];
  openPicker({
    placeholder: "Theme",
    initial: Math.max(0, items.findIndex((t) => t.id === original)),
    provide: (q) => ({
      items: fuzzyFilter(q, items, (t) => t.label).map(({ item, result }) => ({
        label: item.label, icon: "palette", positions: result.positions, value: item.id, hint: item.id === original ? "current" : undefined,
      })),
    }),
    highlight: (it) => {
      if (!it) return;
      app.settings.theme = it.value as string;
      app.applySettings();
    },
    cancel: () => {
      app.settings.theme = original;
      app.applySettings();
    },
    pick: (it) => app.updateSetting("theme", it.value),
  });
}

export function selectAccent(app: App) {
  const names = Object.keys(PALETTE_LABELS);
  const opts = [{ id: null as string | null, label: "Theme color" }, ...names.map((n) => ({ id: n as string | null, label: PALETTE_LABELS[n] }))];
  const original = app.settings.accent;
  const theme = findTheme(app.settings.theme, app.systemDark.matches);
  const resolve = (id: string | null) => (id ? (theme.colors as Record<string, string>)[id] ?? null : null);
  openPicker({
    placeholder: "Accent color",
    initial: Math.max(0, opts.findIndex((o) => resolve(o.id) === original)),
    provide: (q) => ({
      items: fuzzyFilter(q, opts, (o) => o.label).map(({ item, result }) => ({
        label: item.label, color: item.id ?? "accent", positions: result.positions, value: item.id,
      })),
    }),
    highlight: (it) => {
      if (!it) return;
      app.settings.accent = resolve(it.value as string | null);
      app.applySettings();
    },
    cancel: () => {
      app.settings.accent = original;
      app.applySettings();
    },
    pick: (it) => {
      app.settings.accent = original;
      app.applySettings();
      const value = resolve(it.value as string | null);
      return app.updateSetting("accent", value);
    },
  });
}

export function selectMascot(app: App) {
  const original = app.settings.mascot;
  const items = [{ id: "theme", label: "Theme accent", color: "accent" }, ...Object.entries(MASCOT_VARIANTS).map(([id, [body]]) => ({ id, label: id[0].toUpperCase() + id.slice(1), color: body }))];
  openPicker({
    placeholder: "Kilo's color (welcome screen)",
    initial: Math.max(0, items.findIndex((i) => i.id === original)),
    provide: (q) => ({
      items: fuzzyFilter(q, items, (i) => i.label).map(({ item, result }) => ({
        label: item.label, color: item.color, positions: result.positions, value: item.id, hint: item.id === original ? "current" : undefined,
      })),
    }),
    highlight: (it) => it && applyMascot(it.value as string),
    cancel: () => applyMascot(original),
    pick: (it) => app.updateSetting("mascot", it.value),
  });
}
