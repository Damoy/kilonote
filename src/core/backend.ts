// Accès au système : implémentation Tauri (application) et implémentation
// « démo » en mémoire (navigateur), utile pour tester l'interface sans Rust.

import { basename, dirname, isInside, join } from "./path";

export interface FileText {
  text: string;
  encoding: string;
  mtime: number;
}
export interface Meta {
  mtime: number;
  size: number;
  isDir: boolean;
}
export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}
export type Platform = "windows" | "macos" | "linux";

export interface Backend {
  readonly kind: "tauri" | "web";
  readonly platform: Platform;
  readText(path: string): Promise<FileText>;
  writeText(path: string, text: string, bom?: boolean): Promise<Meta>;
  appendLines(path: string, lines: string[]): Promise<Meta>;
  stat(path: string): Promise<Meta | null>;
  listDir(path: string, showHidden: boolean): Promise<Entry[]>;
  walk(root: string, showHidden: boolean, max: number): Promise<string[]>;
  readMany(paths: string[], maxSize: number): Promise<(string | null)[]>;
  createDir(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  configDir(): Promise<string>;
  startupPaths(): Promise<string[]>;
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  pickSavePath(defaultPath?: string): Promise<string | null>;
  openUrl(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
  setTitle(title: string): void;
  setDark(dark: boolean): void;
  show(): Promise<void>;
  toggleFullscreen(): Promise<void>;
  /** Le gestionnaire renvoie false pour annuler la fermeture. */
  onCloseRequested(handler: () => Promise<boolean>): void;
  onFileDrop(handler: (paths: string[]) => void): void;
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "macos";
  return "linux";
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---------------------------------------------------------------------------
// Tauri

export async function createTauriBackend(): Promise<Backend> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const dialog = await import("@tauri-apps/plugin-dialog");
  const opener = await import("@tauri-apps/plugin-opener");
  const win = getCurrentWindow();
  let cfgDir: string | null = null;

  return {
    kind: "tauri",
    platform: detectPlatform(),
    readText: (path) => invoke<FileText>("read_text", { path }),
    writeText: (path, text, bom) => invoke<Meta>("write_text", { path, text, bom: !!bom }),
    appendLines: (path, lines) => invoke<Meta>("append_lines", { path, lines }),
    stat: (path) => invoke<Meta | null>("stat", { path }),
    listDir: (path, showHidden) => invoke<Entry[]>("list_dir", { path, showHidden }),
    walk: (root, showHidden, max) => invoke<string[]>("walk", { root, showHidden, max }),
    readMany: (paths, maxSize) => invoke<(string | null)[]>("read_many", { paths, maxSize }),
    createDir: (path) => invoke("create_dir", { path }),
    createFile: (path) => invoke("create_file", { path }),
    rename: (from, to) => invoke("rename_path", { from, to }),
    trash: (path) => invoke("trash_path", { path }),
    async configDir() {
      cfgDir ??= await invoke<string>("config_dir");
      return cfgDir;
    },
    startupPaths: () => invoke<string[]>("startup_paths"),
    async pickFolder() {
      const r = await dialog.open({ directory: true, multiple: false, title: "Ouvrir un dossier" });
      return typeof r === "string" ? r : null;
    },
    async pickFiles() {
      const r = await dialog.open({ multiple: true, title: "Ouvrir des fichiers" });
      return Array.isArray(r) ? r : r ? [r] : [];
    },
    async pickSavePath(defaultPath) {
      return (await dialog.save({ defaultPath, title: "Enregistrer sous" })) ?? null;
    },
    openUrl: (url) => opener.openUrl(url),
    openPath: (path) => opener.openPath(path),
    reveal: (path) => opener.revealItemInDir(path),
    setTitle: (title) => void win.setTitle(title).catch(() => {}),
    setDark: (dark) => void win.setTheme(dark ? "dark" : "light").catch(() => {}),
    show: async () => {
      await win.show();
      await win.setFocus();
    },
    async toggleFullscreen() {
      await win.setFullscreen(!(await win.isFullscreen()));
    },
    onCloseRequested(handler) {
      void win.onCloseRequested(async (event) => {
        try {
          if (!(await handler())) event.preventDefault();
        } catch (e) {
          console.error(e);
        }
      });
    },
    onFileDrop(handler) {
      void getCurrentWebview().onDragDropEvent((ev) => {
        if (ev.payload.type === "drop" && ev.payload.paths.length) handler(ev.payload.paths);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Démo navigateur : un petit système de fichiers persistant dans localStorage.

const DEMO_KEY = "kilonote-demo-fs-v1";
const DEMO_ROOT = "/Notes";

function demoSeed(): Record<string, string> {
  return {
    "/Notes/mc.txt": [
      "# Projet MC",
      "",
      "- appeler collègue X pour le planning - ongoing",
      "- relire la spec de l'API v2 - todo",
      "- préparer la démo client du 14/11 - todo",
      "- corriger le bug d'export CSV #bug - blocked",
      "",
      "Notes de réunion 2026-10-28 avec @julie :",
      "- valider le budget avant fin novembre",
      "- voir https://wiki.example.com/mc pour la doc",
    ].join("\n"),
    "/Notes/mc_done.txt": [
      "- mettre en place la CI - done [2026-01-15]",
      "- migrer la base vers Postgres 17 - done [2026-03-02]",
      "- former l'équipe support - ok [2026-06-20]",
      "- revue de code du module paiement - done [2026-10-30]",
    ].join("\n"),
    "/Notes/perso.md": [
      "# Perso",
      "",
      "## Idées",
      "- apprendre le **Rust** - ongoing",
      "- lire *Le Petit Prince* en anglais - todo",
      "",
      "> Les notes les plus légères sont les plus utiles.",
    ].join("\n"),
    "/Notes/archives/2025.txt": "- vieux projet terminé - done [2025-12-01]\n",
  };
}

interface DemoFile {
  text: string;
  mtime: number;
}

export function createWebBackend(): Backend {
  const files = new Map<string, DemoFile>();
  const dirs = new Set<string>([DEMO_ROOT, "/.config"]);
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    const data: Record<string, string> = raw ? JSON.parse(raw) : demoSeed();
    for (const [p, text] of Object.entries(data)) files.set(p, { text, mtime: Date.now() });
  } catch {
    for (const [p, text] of Object.entries(demoSeed())) files.set(p, { text, mtime: Date.now() });
  }
  const ensureDirs = (p: string) => {
    for (let d = dirname(p); d && d !== "/"; d = dirname(d)) dirs.add(d);
  };
  for (const p of files.keys()) ensureDirs(p);
  const persist = () => {
    const out: Record<string, string> = {};
    for (const [p, f] of files) out[p] = f.text;
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(out));
    } catch {
      /* quota : tant pis pour la démo */
    }
  };
  const meta = (p: string): Meta | null => {
    const f = files.get(p);
    if (f) return { mtime: f.mtime, size: f.text.length, isDir: false };
    return dirs.has(p) ? { mtime: 0, size: 0, isDir: true } : null;
  };
  const write = (p: string, text: string): Meta => {
    ensureDirs(p);
    files.set(p, { text, mtime: Date.now() });
    persist();
    return meta(p)!;
  };

  return {
    kind: "web",
    platform: detectPlatform(),
    async readText(path) {
      const f = files.get(path);
      if (!f) throw new Error(`Fichier introuvable : ${path}`);
      return { text: f.text, encoding: "UTF-8", mtime: f.mtime };
    },
    async writeText(path, text) {
      return write(path, text);
    },
    async appendLines(path, lines) {
      const prev = files.get(path)?.text ?? "";
      const sep = prev && !prev.endsWith("\n") ? "\n" : "";
      return write(path, prev + sep + lines.map((l) => l + "\n").join(""));
    },
    stat: async (path) => meta(path),
    async listDir(path, showHidden) {
      const out: Entry[] = [];
      for (const d of dirs) if (dirname(d) === path && d !== path) out.push({ name: basename(d), path: d, isDir: true });
      for (const p of files.keys()) if (dirname(p) === path) out.push({ name: basename(p), path: p, isDir: false });
      return out
        .filter((e) => showHidden || !e.name.startsWith("."))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    },
    async walk(root, showHidden, max) {
      return [...files.keys()]
        .filter((p) => isInside(p, root) && (showHidden || !p.slice(root.length).includes("/.")))
        .slice(0, max);
    },
    async readMany(paths) {
      return paths.map((p) => files.get(p)?.text ?? null);
    },
    async createDir(path) {
      dirs.add(path);
      ensureDirs(path);
    },
    async createFile(path) {
      if (files.has(path)) throw new Error("Le fichier existe déjà");
      write(path, "");
    },
    async rename(from, to) {
      if (files.has(to) || dirs.has(to)) throw new Error(`« ${basename(to)} » existe déjà`);
      if (files.has(from)) {
        write(to, files.get(from)!.text);
        files.delete(from);
      } else {
        for (const [p, f] of [...files]) {
          if (isInside(p, from)) {
            files.delete(p);
            write(to + p.slice(from.length), f.text);
          }
        }
        for (const d of [...dirs]) if (d === from || isInside(d, from)) {
          dirs.delete(d);
          dirs.add(to + d.slice(from.length));
        }
      }
      persist();
    },
    async trash(path) {
      files.delete(path);
      for (const p of [...files.keys()]) if (isInside(p, path)) files.delete(p);
      for (const d of [...dirs]) if (d === path || isInside(d, path)) dirs.delete(d);
      persist();
    },
    configDir: async () => "/.config",
    startupPaths: async () => [DEMO_ROOT],
    async pickFolder() {
      return DEMO_ROOT;
    },
    async pickFiles() {
      return [];
    },
    async pickSavePath(defaultPath) {
      const name = window.prompt("Enregistrer sous (chemin dans la démo)", defaultPath ?? join(DEMO_ROOT, "note.txt"));
      return name || null;
    },
    openUrl: async (url) => void window.open(url, "_blank", "noopener"),
    openPath: async () => {},
    reveal: async () => {},
    setTitle: (t) => void (document.title = t),
    setDark: () => {},
    show: async () => {},
    toggleFullscreen: async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    },
    onCloseRequested(handler) {
      window.addEventListener("beforeunload", () => void handler());
    },
    onFileDrop() {},
  };
}
