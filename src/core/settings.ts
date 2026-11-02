// Paramètres : un fichier JSON commenté, à la Sublime Text.
// Le modèle ci-dessous sert à la fois de valeurs par défaut et de
// documentation : il est copié tel quel lors de la première ouverture.

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
  keybindings: Record<string, string>;
}

export const SETTINGS_TEMPLATE = `// Paramètres KiloNote
// ------------------
// Modifiez une valeur puis enregistrez (Ctrl+S) : tout s'applique immédiatement.
// Les commentaires et les virgules finales sont autorisés.
{
  // Thème : "auto" (suit le système), "minuit", "papier", "foret", "ocean", "sable", "retro"
  "theme": "minuit",
  // Couleur d'accent personnalisée (ex. "#ff8a65"), ou null pour celle du thème
  "accent": null,
  // Surcharge de n'importe quelle couleur du thème. Clés disponibles :
  // bg, bg_alt, bg_hover, border, fg, fg_muted, fg_faint, accent, selection,
  // cursor, line, red, orange, yellow, green, cyan, blue, purple, pink, grey
  "colors": {},

  // --- Éditeur ---
  "font_family": "JetBrains Mono Variable, Cascadia Code, Consolas, Menlo, monospace",
  "font_size": 14,
  "line_height": 1.65,
  "ui_font_size": 13,
  "line_numbers": true,
  "word_wrap": true,
  "highlight_active_line": true,
  "tab_size": 4,
  "indent_with_tabs": false,

  // --- Fichiers ---
  // Enregistrement automatique après une courte pause de frappe
  "autosave": true,
  "autosave_delay": 700,
  // Garde le contenu des onglets non enregistrés entre deux sessions
  "hot_exit": true,
  // Fin de ligne des nouveaux fichiers : "system", "lf" ou "crlf"
  "default_line_ending": "system",
  "show_hidden_files": false,
  // Extensions considérées comme des notes (recherche rapide, tâches, bilan)
  "note_extensions": ["txt", "md", "markdown", "note", "todo", "log", "org", "rst", "text"],

  // --- Tâches ---
  // Une tâche est une ligne qui se termine par " - <statut>", par exemple :
  //   - appeler collègue X - todo
  // Statuts reconnus et leur couleur (nom de couleur du thème ou code hexadécimal)
  "task_statuses": {
    "todo": "blue",
    "ongoing": "orange",
    "blocked": "red",
    "wait": "purple",
    "done": "green",
    "ok": "green"
  },
  // Ordre des statuts quand on appuie sur Ctrl+Entrée
  "task_cycle": ["todo", "ongoing", "done"],
  // Statuts considérés comme terminés
  "task_done_statuses": ["done", "ok"],
  // Archivage (Ctrl+Maj+Entrée) : mc.txt → mc_done.txt
  "archive_suffix": "_done",
  // Statut écrit dans le fichier d'archive (si la tâche n'est pas déjà terminée)
  "archive_status": "done",
  // Ajoute la date d'archivage, ex. "- appeler collègue X - done [2026-11-02]"
  "archive_date": true,
  // Archive automatiquement une tâche dès qu'elle passe à un statut terminé
  "auto_archive": false,

  // Couleurs proposées pour les onglets et les groupes d'onglets
  "tab_colors": ["grey", "blue", "cyan", "green", "yellow", "orange", "red", "pink", "purple"],

  // Raccourcis personnalisés : { "Ctrl+Alt+T": "task.cycle", "Ctrl+W": "" (désactive) }
  // Liste des commandes : palette (Ctrl+Maj+P).
  "keybindings": {}
}
`;

export const DEFAULT_SETTINGS: Settings = parseJsonc<Settings>(SETTINGS_TEMPLATE);

/** Fusionne les paramètres utilisateur avec les valeurs par défaut (en validant les types). */
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
        // Les statuts et les couleurs remplacent entièrement la valeur par défaut
        // quand l'utilisateur les définit ; les raccourcis s'ajoutent.
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
 * Modifie une seule valeur dans le texte du fichier de paramètres en conservant
 * les commentaires (utilisé par le sélecteur de thème, le zoom…).
 */
export function setSettingInText(text: string, key: string, value: unknown): string {
  const json = JSON.stringify(value);
  const re = new RegExp(`("${key}"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?|true|false|null)`);
  if (re.test(text)) return text.replace(re, (_m, p1: string) => p1 + json);
  // Clé absente : on l'ajoute juste après l'accolade ouvrante.
  const i = text.indexOf("{");
  if (i < 0) return `{\n  "${key}": ${json}\n}\n`;
  const rest = text.slice(i + 1);
  const needsComma = /^\s*"/.test(rest);
  return `${text.slice(0, i + 1)}\n  "${key}": ${json}${needsComma ? "," : ""}${rest}`;
}
