// Settings: a commented JSON file.
// The template below is both the default values and the documentation:
// it is copied as is the first time the settings are opened.

import { parseJsonc } from "./jsonc";
import { ICON_PACKS } from "../ui/icons";

export interface Settings {
  theme: string;
  accent: string | null;
  colors: Record<string, string>;
  font_family: string;
  font_size: number;
  line_height: number;
  ui_font_size: number;
  line_numbers: boolean;
  word_wrap: boolean;
  highlight_active_line: boolean;
  scrollbar_marks: boolean;
  show_images: boolean;
  images_folder: string;
  daily_notes_folder: string;
  tab_size: number;
  indent_with_tabs: boolean;
  autosave: boolean;
  autosave_delay: number;
  hot_exit: boolean;
  default_line_ending: "system" | "lf" | "crlf";
  show_hidden_files: boolean;
  note_extensions: string[];
  task_statuses: Record<string, string>;
  task_cycle: string[];
  task_done_statuses: string[];
  task_ongoing_statuses: string[];
  task_blocked_statuses: string[];
  archive_suffix: string;
  archive_status: string;
  archive_date: boolean;
  auto_archive: boolean;
  tab_colors: string[];
  mascot: string;
  icon_pack: string;
  show_shortcuts_at_startup: boolean;
  keybindings: Record<string, string>;
}

export const SETTINGS_TEMPLATE = `// KiloNote settings
// -----------------
// Change a value and save (Ctrl+S): everything applies immediately.
// Comments and trailing commas are allowed.
{
  // Theme: "auto" (follows the system), or one of
  //   dark:  "midnight", "forest", "ocean", "retro", "dusk", "slate", "abyss", "neon", "ember"
  //   light: "paper", "sand", "mint", "sakura", "latte", "frost"
  "theme": "midnight",
  // Kilo's color on the welcome screen: "theme" (follows the accent color) or one of
  // "classic", "mint", "ocean", "ember", "sakura", "retro", "slate", "ink"
  "mascot": "theme",
  // Icons: "line" (thin outlines), "bold", "duotone" (soft fills, file types
  // in color) or "pixel" (pixel art, like Kilo)
  "icon_pack": "line",
  // Show the keyboard shortcuts cheat sheet when KiloNote starts
  "show_shortcuts_at_startup": true,
  // Custom accent color (e.g. "#ff8a65"), or null to use the theme's
  "accent": null,
  // Override any theme color. Available keys:
  // bg, bg_alt, bg_hover, border, fg, fg_muted, fg_faint, accent, selection,
  // cursor, line, red, orange, yellow, green, cyan, blue, purple, pink, grey
  "colors": {},

  // --- Editor ---
  "font_family": "JetBrains Mono Variable, Cascadia Code, Consolas, Menlo, monospace",
  "font_size": 14,
  "line_height": 1.65,
  "ui_font_size": 13,
  "line_numbers": true,
  "word_wrap": true,
  "highlight_active_line": true,
  // Marks along the scrollbar: headings and open tasks, the other occurrences of
  // the selected text, the search matches
  "scrollbar_marks": true,
  // Show the images of a note under their line: ![image](images/shot.png)
  "show_images": true,
  // Where a pasted image is saved, next to the note (Ctrl+V a screenshot in a note)
  "images_folder": "images",
  "tab_size": 4,
  "indent_with_tabs": false,

  // --- Files ---
  // Save automatically after a short pause in typing
  "autosave": true,
  "autosave_delay": 700,
  // Keep the content of unsaved tabs between sessions
  "hot_exit": true,
  // Line ending of new files: "system", "lf" or "crlf"
  "default_line_ending": "system",
  "show_hidden_files": false,
  // Where "File: Today's note" (Ctrl+Alt+D) keeps the daily notes, in the open folder
  "daily_notes_folder": "daily",
  // Extensions treated as notes (quick open, tasks, activity report)
  "note_extensions": ["txt", "md", "markdown", "note", "todo", "log", "org", "rst", "text"],

  // --- Tasks ---
  // A task is a line that ends with " - <status>", for example:
  //   - call colleague X - todo
  // Known statuses and their color (a theme color name or a hex code)
  "task_statuses": {
    "todo": "blue",
    "ongoing": "orange",
    "blocked": "red",
    "wait": "purple",
    "done": "green",
    "ok": "green"
  },
  // Status order when pressing Ctrl+Enter
  "task_cycle": ["todo", "ongoing", "done"],
  // Statuses that mean "completed", "in progress" and "blocked" (tasks panel, report)
  "task_done_statuses": ["done", "ok"],
  "task_ongoing_statuses": ["ongoing"],
  "task_blocked_statuses": ["blocked"],
  // Due dates: write "@2026-11-14" in a task (or use "Task: Set due date…");
  // overdue tasks turn red.
  // Archiving (Ctrl+Shift+Enter): work.txt → work_done.txt
  "archive_suffix": "_done",
  // Status written to the archive file (unless the task is already completed)
  "archive_status": "done",
  // Append the archive date, e.g. "- call colleague X - done [2026-11-02]"
  "archive_date": true,
  // Archive a task automatically as soon as it reaches a completed status
  "auto_archive": false,

  // Colors offered for tabs and tab groups
  "tab_colors": ["grey", "blue", "cyan", "green", "yellow", "orange", "red", "pink", "purple"],

  // Custom shortcuts: { "Ctrl+Alt+T": "task.cycle", "Ctrl+W": "" (disables it) }
  // Command ids are listed in the command palette (Ctrl+Shift+P).
  "keybindings": {}
}
`;

export const DEFAULT_SETTINGS: Settings = parseJsonc<Settings>(SETTINGS_TEMPLATE);

/** Merges user settings into the defaults (checking value types). */
export function mergeSettings(user: Partial<Settings> | null | undefined): Settings {
  const out: Settings = structuredClone(DEFAULT_SETTINGS);
  if (!user || typeof user !== "object") return out;
  const target = out as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(user)) {
    if (!(k in target)) continue;
    const def = target[k];
    if (def === null || v === null) {
      target[k] = v;
    } else if (Array.isArray(def)) {
      if (Array.isArray(v)) target[k] = v;
    } else if (typeof def === "object") {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        // Statuses replace the defaults entirely when the user defines them;
        // colors and shortcuts are merged into the defaults.
        target[k] = k === "keybindings" || k === "colors" ? { ...(def as object), ...v } : v;
      }
    } else if (typeof v === typeof def) {
      target[k] = v;
    }
  }
  out.font_size = clamp(out.font_size, 8, 40);
  out.ui_font_size = clamp(out.ui_font_size, 9, 22);
  out.line_height = clamp(out.line_height, 1, 3);
  out.tab_size = clamp(Math.round(out.tab_size), 1, 12);
  out.autosave_delay = clamp(out.autosave_delay, 100, 60_000);
  // ".md" or "MD" mean "md".
  out.note_extensions = out.note_extensions
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim().replace(/^\.+/, "").toLowerCase())
    .filter(Boolean);
  if (!ICON_PACKS.some((p) => p.id === out.icon_pack)) out.icon_pack = DEFAULT_SETTINGS.icon_pack;
  // Without a suffix, a note would be its own archive.
  if (typeof out.archive_suffix !== "string" || !out.archive_suffix.trim()) out.archive_suffix = DEFAULT_SETTINGS.archive_suffix;
  // Images stay next to the note, daily notes in the open folder: folder names, not paths elsewhere.
  out.images_folder = innerFolder(out.images_folder, DEFAULT_SETTINGS.images_folder);
  out.daily_notes_folder = innerFolder(out.daily_notes_folder, DEFAULT_SETTINGS.daily_notes_folder);
  return out;
}

/** A folder inside another one (`images`, `notes/daily`), or the default: never absolute, never `..`. */
function innerFolder(value: unknown, fallback: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  return !v || /^([a-z]:|[\\/])|(^|[\\/])\.\.([\\/]|$)/i.test(v) ? fallback : v;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));

/**
 * Changes a single top-level value in the settings file text while keeping its
 * comments and layout (used by the settings screen, the theme picker, zoom…).
 * Keys inside comments or nested objects are never touched.
 */
export function setSettingInText(text: string, key: string, value: unknown): string {
  const span = findValueSpan(text, key);
  const json = formatValue(value, span ? lineIndent(text, span.from) : "  ");
  if (span) return text.slice(0, span.from) + json + text.slice(span.to);
  // Missing key: add it right after the opening brace.
  const i = topLevelBrace(text);
  if (i < 0) return `{\n  "${key}": ${formatValue(value, "  ")}\n}\n`;
  const rest = text.slice(i + 1);
  const needsComma = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*"/.test(rest);
  return `${text.slice(0, i + 1)}\n  "${key}": ${formatValue(value, "  ")}${needsComma ? "," : ""}${rest}`;
}

/** Indentation of the line that contains `pos`. */
function lineIndent(text: string, pos: number): string {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))![0];
}

/** Short arrays and objects stay on one line; longer ones get one entry per line. */
function formatValue(value: unknown, indent: string): string {
  const flat = flatJson(value);
  if (value === null || typeof value !== "object" || flat.length <= 72) return flat;
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

/** `["a", "b"]`, `{ "a": 1 }`: JSON on one line, spaced like the template. */
function flatJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(flatJson).join(", ")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v);
    return entries.length ? `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${flatJson(x)}`).join(", ")} }` : "{}";
  }
  return JSON.stringify(v);
}

/** Skips spaces and comments from `i`. */
function skipBlank(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else return i;
  }
}

/** End of the string that starts at `i` (a quote). */
function stringEnd(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === '"') return j + 1;
  }
  return text.length;
}

/** End of the JSON value that starts at `i`. */
function valueEnd(text: string, i: number): number {
  if (text[i] === '"') return stringEnd(text, i);
  if (text[i] === "{" || text[i] === "[") {
    let depth = 0;
    for (let j = i; j < text.length; ) {
      j = skipBlank(text, j);
      const c = text[j];
      if (c === '"') {
        j = stringEnd(text, j);
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return text.length;
  }
  const m = /^[^,}\]\s/]*/.exec(text.slice(i))!;
  return i + m[0].length;
}

function topLevelBrace(text: string): number {
  const i = skipBlank(text, 0);
  return text[i] === "{" ? i : -1;
}

/** Where the value of a top-level key is, or null. */
function findValueSpan(text: string, key: string): { from: number; to: number } | null {
  const open = topLevelBrace(text);
  if (open < 0) return null;
  let i = open + 1;
  for (;;) {
    i = skipBlank(text, i);
    if (text[i] !== '"') return null;
    const keyEnd = stringEnd(text, i);
    const name = text.slice(i + 1, keyEnd - 1);
    i = skipBlank(text, keyEnd);
    if (text[i] !== ":") return null;
    const from = skipBlank(text, i + 1);
    const to = valueEnd(text, from);
    if (name === key) return { from, to };
    i = skipBlank(text, to);
    if (text[i] !== ",") return null;
    i++;
  }
}
