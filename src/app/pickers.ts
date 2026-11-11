// The pickers: command palette, Go to file / line / heading, themes, accent
// color, Kilo's color and document type.

import { runCommand, shortcutFor, type Command } from "../core/commands";
import { basename, dirname, isDoneFile, isWindowsPath, relative } from "../core/path";
import { applyMascot, findTheme, MASCOT_VARIANTS, PALETTE_LABELS, THEMES } from "../core/themes";
import { fuzzyFilter } from "../core/fuzzy";
import { type LangId } from "../editor/setup";
import { LANGUAGES } from "../editor/languages";
import { parseTask } from "../text/tasks";
import { openPicker, type PickItem } from "../ui/palette";
import type { App, Doc } from "./app";
import { forgetRecent, pinnedNotes, recentNotes } from "./pins";

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

// The commands run lately from the palette come first (kept by the window's web view).
const RECENT_KEY = "kilonote-recent-commands";
const RECENT_MAX = 6;

function recentCommands(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function runFromPalette(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentCommands().filter((x) => x !== id)].slice(0, RECENT_MAX)));
  } catch {
    /* storage unavailable: no recent commands */
  }
  runCommand(id);
}

export function openCommandPalette(app: App, query = "") {
  openPicker({
    placeholder: "Command…",
    query,
    provide: (q) => provideCommands(app, q),
    pick: (it) => runFromPalette(it.value as string),
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
      if (q.startsWith(">")) return runFromPalette(it.value as string);
      if (q.startsWith("@")) return app.active && app.reveal(app.active, it.value as number);
      const v = it.value as { doc?: Doc; path?: string };
      if (v.doc) app.activate(v.doc);
      // A recent note that is gone (deleted, moved by another program) is forgotten.
      else if (v.path) return app.openFile(v.path).then((d) => d || forgetRecent(v.path!));
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

/** The commands matching `q`: with nothing typed, the ones run lately first. */
export function provideCommands(app: App, q: string) {
  let cmds = paletteCommands(app);
  const recent = q.trim() ? [] : recentCommands();
  if (recent.length) {
    const rank = (c: Command) => (recent.includes(c.id) ? recent.indexOf(c.id) : RECENT_MAX);
    cmds = [...cmds].sort((a, b) => rank(a) - rank(b));
  }
  return {
    items: fuzzyFilter(q, cmds, (c) => c.title).map(({ item, result }) => ({
      label: item.title, hint: shortcutFor(item.id) || (recent.includes(item.id) ? "recent" : undefined), icon: "command", positions: result.positions, value: item.id,
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

/**
 * The notes for "Go to file": the pinned ones first, then the ones opened
 * lately, the other open tabs, and the notes of the folder. A pinned or recent
 * note also wins over an equally good match.
 */
export function provideFiles(app: App, q: string) {
  type FileItem = { label: string; detail: string; doc?: Doc; path?: string; open: boolean; pinned: boolean; recent: number };
  const items: FileItem[] = [];
  const seen = new Set<string>();
  const where = (p: string) => relative(app.workspace, dirname(p)) || "·";
  // (Cheap keys: this runs on every key typed, over every note of the folder.)
  const keyOf = (p: string) => (isWindowsPath(p) ? p.replace(/\\/g, "/").toLowerCase() : p);
  const openDocs = new Map(app.docs.flatMap((d) => (d.path ? [[keyOf(d.path), d] as const] : [])));
  const add = (path: string, extra: { pinned?: boolean; recent?: number }) => {
    const key = keyOf(path);
    if (seen.has(key)) return;
    seen.add(key);
    const doc = openDocs.get(key);
    items.push({ label: basename(path), detail: where(path), doc, path, open: !!doc, pinned: !!extra.pinned, recent: extra.recent ?? -1 });
  };
  for (const p of pinnedNotes()) add(p, { pinned: true });
  recentNotes().forEach((p, i) => (app.isNoteFile(p) || openDocs.has(keyOf(p))) && add(p, { recent: i }));
  for (const d of app.docs) {
    if (d.path) add(d.path, {});
    else items.push({ label: app.docName(d), detail: "unsaved", doc: d, open: true, pinned: false, recent: -1 });
  }
  for (const p of app.workspaceFiles) if (app.isNoteFile(p)) add(p, {});
  const bonus = (it: FileItem) => (it.pinned ? 60 : 0) + (it.recent >= 0 ? 40 - it.recent : 0) + (it.open ? 10 : 0);
  const results = fuzzyFilter(q, items, (it) => (it.detail === "·" ? it.label : `${it.detail}/${it.label}`), 10_000);
  if (q) results.sort((a, b) => b.result.score + bonus(b.item) - (a.result.score + bonus(a.item)));
  return {
    items: results.slice(0, 200).map(({ item, result }) => {
      const offset = item.detail === "·" ? 0 : item.detail.length + 1;
      return {
        label: item.label,
        detail: item.detail === "·" ? undefined : item.detail,
        positions: result.positions.filter((p) => p >= offset).map((p) => p - offset),
        detailPositions: result.positions.filter((p) => p < offset),
        icon: item.pinned ? "pin" : isDoneFile(item.label, app.settings.archive_suffix) ? "fileDone" : "file",
        hint: item.pinned ? "pinned" : item.open ? "open" : item.recent >= 0 ? "recent" : undefined,
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
