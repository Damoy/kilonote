// Settings: a commented JSON file.
// The template below is both the default values and the documentation:
// it is copied as is the first time the settings are opened.

import { parseJsonc } from "./jsonc";

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
  archive_suffix: string;
  archive_status: string;
  archive_date: boolean;
  auto_archive: boolean;
  tab_colors: string[];
  mascot: string;
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
  // Statuses that mean "completed"
  "task_done_statuses": ["done", "ok"],
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
  return out;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));

/**
 * Changes a single value in the settings file text while keeping its comments
 * (used by the theme picker, zoom…).
 */
export function setSettingInText(text: string, key: string, value: unknown): string {
  const json = JSON.stringify(value);
  const re = new RegExp(`("${key}"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?|true|false|null)`);
  if (re.test(text)) return text.replace(re, (_m, p1: string) => p1 + json);
  // Missing key: add it right after the opening brace.
  const i = text.indexOf("{");
  if (i < 0) return `{\n  "${key}": ${json}\n}\n`;
  const rest = text.slice(i + 1);
  const needsComma = /^\s*"/.test(rest);
  return `${text.slice(0, i + 1)}\n  "${key}": ${json}${needsComma ? "," : ""}${rest}`;
}
