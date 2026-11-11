// System access: the Tauri implementation (desktop app) and an in-memory
// "demo" implementation (browser), handy to work on the interface without Rust.

import { basename, dirname, isInside, join } from "./path";

export interface FileText {
  text: string;
  encoding: string;
  mtime: number;
}
/** Result of a write: the encoding actually used (Windows-1252 may fall back to UTF-8). */
export interface Written {
  mtime: number;
  encoding: string;
}
export interface Meta {
  mtime: number;
  size: number;
  isDir: boolean;
}
/** A file of a batch read: its stamp, and its text (null: unchanged since read, too large, or not text). */
export interface FreshText {
  mtime: number;
  size: number;
  text: string | null;
  /** Unchanged: same modification time and size as the stamp given. */
  same: boolean;
}
export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}
export type Platform = "windows" | "macos" | "linux";

/** Links KiloNote hands to the system: web pages and e-mail addresses only. */
export function isSafeUrl(url: string): boolean {
  return /^(?:https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(url);
}

export interface Backend {
  readonly kind: "tauri" | "web";
  readonly platform: Platform;
  /** "main" for the first window, "kn-…" for the others. */
  readonly windowLabel: string;
  readText(path: string): Promise<FileText>;
  /** Writes in the given encoding ("UTF-8", "UTF-8 BOM", "UTF-16 LE", "UTF-16 BE", "Windows-1252"). */
  writeText(path: string, text: string, encoding?: string): Promise<Written>;
  appendLines(path: string, lines: string[]): Promise<Meta>;
  stat(path: string): Promise<Meta | null>;
  listDir(path: string, showHidden: boolean): Promise<Entry[]>;
  walk(root: string, showHidden: boolean, max: number): Promise<string[]>;
  /** Reads text files in one go; those whose stamp (mtime, size) is given and unchanged are not read again. */
  readChanged(paths: string[], known: ([number, number] | null)[], maxSize: number): Promise<(FreshText | null)[]>;
  createDir(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  /** The bytes of an image file (png, jpg, gif, webp, bmp, svg) shown in a note. */
  readImage(path: string): Promise<Uint8Array>;
  /** Saves a pasted image to a new file; fails with "exists" when the file is already there. */
  writeImage(path: string, bytes: Uint8Array): Promise<void>;
  configDir(): Promise<string>;
  /** Paths this window must open (command line for the main window). */
  windowPaths(): Promise<string[]>;
  /** Opens another window, optionally restoring a saved one by its label. */
  openWindow(paths: string[], label?: string, position?: { x: number; y: number }): Promise<void>;
  windowCount(): Promise<number>;
  /** Label of the other window under a screen point (CSS pixels), or null. */
  windowAt(screenX: number, screenY: number): Promise<string | null>;
  /** Opens files in another window and brings it to the front. */
  sendPaths(label: string, paths: string[]): Promise<void>;
  /** Keeps only the `keep` newest files of the local history (config folder only). */
  pruneHistory(keep: number): Promise<void>;
  /** Removes the saved session of a window (config folder only). */
  deleteSession(label: string): Promise<void>;
  /** Tells the other windows that the settings file changed. */
  broadcastSettingsChanged(): void;
  onSettingsChanged(handler: () => void): void;
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  pickSavePath(defaultPath?: string): Promise<string | null>;
  openUrl(url: string): Promise<void>;
  reveal(path: string): Promise<void>;
  setTitle(title: string): void;
  setDark(dark: boolean): void;
  show(): Promise<void>;
  toggleFullscreen(): Promise<void>;
  /** The handler returns false to cancel closing. */
  onCloseRequested(handler: () => Promise<boolean>): void;
  onFileDrop(handler: (paths: string[], at?: { x: number; y: number }) => void): void;
  /** Files requested by a second instance of the application. */
  onOpenRequest(handler: (paths: string[]) => void): void;
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
  const { emit, listen } = await import("@tauri-apps/api/event");
  const dialog = await import("@tauri-apps/plugin-dialog");
  const opener = await import("@tauri-apps/plugin-opener");
  const win = getCurrentWindow();
  let cfgDir: string | null = null;

  return {
    kind: "tauri",
    platform: detectPlatform(),
    readText: (path) => invoke<FileText>("read_text", { path }),
    writeText: (path, text, encoding) => invoke<Written>("write_text", { path, text, encoding: encoding ?? null }),
    appendLines: (path, lines) => invoke<Meta>("append_lines", { path, lines }),
    stat: (path) => invoke<Meta | null>("stat", { path }),
    listDir: (path, showHidden) => invoke<Entry[]>("list_dir", { path, showHidden }),
    walk: (root, showHidden, max) => invoke<string[]>("walk", { root, showHidden, max }),
    readChanged: (paths, known, maxSize) => invoke<(FreshText | null)[]>("read_changed", { paths, known, maxSize }),
    createDir: (path) => invoke("create_dir", { path }),
    createFile: (path) => invoke("create_file", { path }),
    rename: (from, to) => invoke("rename_path", { from, to }),
    trash: (path) => invoke("trash_path", { path }),
    readImage: async (path) => new Uint8Array(await invoke<ArrayBuffer>("read_image", { path })),
    // The bytes go as they are (no JSON); the path, URI-encoded, in a header.
    writeImage: (path, bytes) => invoke("write_image", bytes, { headers: { "x-path": encodeURIComponent(path) } }),
    async configDir() {
      cfgDir ??= await invoke<string>("config_dir");
      return cfgDir;
    },
    windowLabel: win.label,
    windowPaths: () => invoke<string[]>("window_paths"),
    openWindow: async (paths, label, position) =>
      void (await invoke<string>("open_window", { paths, label: label ?? null, position: position ? [position.x, position.y] : null })),
    windowCount: () => invoke<number>("window_count"),
    windowAt: (x, y) => invoke<string | null>("window_at", { x: x * devicePixelRatio, y: y * devicePixelRatio }),
    sendPaths: (label, paths) => invoke("send_paths", { label, paths }),
    deleteSession: (label) => invoke("delete_session", { label }),
    pruneHistory: (keep) => invoke("prune_history", { keep }),
    broadcastSettingsChanged: () => void emit("kilonote://settings-changed", { from: win.label }),
    onSettingsChanged(handler) {
      void listen<{ from: string }>("kilonote://settings-changed", (ev) => {
        if (ev.payload.from !== win.label) handler();
      });
    },
    async pickFolder() {
      const r = await dialog.open({ directory: true, multiple: false, title: "Open folder" });
      return typeof r === "string" ? r : null;
    },
    async pickFiles() {
      const r = await dialog.open({ multiple: true, title: "Open files" });
      return Array.isArray(r) ? r : r ? [r] : [];
    },
    async pickSavePath(defaultPath) {
      return (await dialog.save({ defaultPath, title: "Save as" })) ?? null;
    },
    // Only web and mail links, in the default browser or mail app (the window
    // permission allows nothing else either).
    openUrl: async (url) => {
      if (!isSafeUrl(url)) throw new Error(`Refused to open "${url}": only http(s) and mailto links are opened.`);
      await opener.openUrl(url);
    },
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
        if (ev.payload.type !== "drop" || !ev.payload.paths.length) return;
        // Where the files were dropped, in CSS pixels of the page.
        const { x, y } = ev.payload.position;
        handler(ev.payload.paths, { x: x / devicePixelRatio, y: y / devicePixelRatio });
      });
    },
    onOpenRequest(handler) {
      void listen<string[]>("kilonote://open-paths", (ev) => handler(ev.payload));
    },
  };
}

// ---------------------------------------------------------------------------
// Browser demo: a small file system persisted in localStorage.

const DEMO_KEY = "kilonote-demo-fs-v2";
const DEMO_ROOT = "/Notes";

function demoSeed(): Record<string, string> {
  return {
    "/Notes/work.txt": [
      "# Work",
      "",
      "- call colleague X about the schedule - ongoing",
      "- review the API v2 spec - todo",
      "- prepare the client demo on 14/11 - todo",
      "- fix the CSV export bug #bug - blocked",
      "",
      "Meeting notes 2026-10-28 with @julie:",
      "- approve the budget before the end of November",
      "- see https://wiki.example.com/work for the docs",
    ].join("\n"),
    "/Notes/work_done.txt": [
      "- set up CI - done [2026-01-15]",
      "- migrate the database to Postgres 17 - done [2026-03-02]",
      "- train the support team - ok [2026-06-20]",
      "- code review of the payment module - done [2026-10-30]",
    ].join("\n"),
    "/Notes/personal.md": [
      "# Personal",
      "",
      "## Ideas",
      "- learn **Rust** - ongoing",
      "- read *The Little Prince* in French - todo",
      "",
      "> The lightest notes are the most useful.",
    ].join("\n"),
    "/Notes/archives/2025.txt": "- old project wrapped up - done [2025-12-01]\n",
  };
}

interface DemoFile {
  text: string;
  mtime: number;
}

export function createWebBackend(): Backend {
  // Each browser window of the demo plays a KiloNote window (?window=kn-…).
  const windowLabel = new URLSearchParams(location.search).get("window") ?? "main";
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("kilonote") : null;
  const files = new Map<string, DemoFile>();
  const dirs = new Set<string>([DEMO_ROOT, "/.config"]);
  /** Pasted images (kept in memory only). */
  const images = new Map<string, Uint8Array>();
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    const data: Record<string, string> = raw ? JSON.parse(raw) : demoSeed();
    for (const [p, text] of Object.entries(data)) files.set(p, { text, mtime: Date.now() });
  } catch {
    for (const [p, text] of Object.entries(demoSeed())) files.set(p, { text, mtime: Date.now() });
  }
  // Another demo window changed the files: reload them.
  const syncFromStorage = () => {
    const raw = localStorage.getItem(DEMO_KEY);
    if (!raw) return;
    files.clear();
    for (const [p, text] of Object.entries(JSON.parse(raw) as Record<string, string>)) files.set(p, { text, mtime: Date.now() });
  };
  window.addEventListener("storage", (e) => {
    if (e.key === DEMO_KEY) syncFromStorage();
  });
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
      /* quota exceeded: fine for a demo */
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
      if (!f) throw new Error(`File not found: ${path}`);
      return { text: f.text, encoding: "UTF-8", mtime: f.mtime };
    },
    async writeText(path, text) {
      return { mtime: write(path, text).mtime, encoding: "UTF-8" };
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
      for (const p of [...files.keys(), ...images.keys()]) if (dirname(p) === path) out.push({ name: basename(p), path: p, isDir: false });
      return out
        .filter((e) => showHidden || !e.name.startsWith("."))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    },
    async walk(root, showHidden, max) {
      return [...files.keys()]
        .filter((p) => isInside(p, root) && (showHidden || !p.slice(root.length).includes("/.")))
        .slice(0, max);
    },
    async readChanged(paths, known, maxSize) {
      return paths.map((p, i) => {
        const f = files.get(p);
        if (!f) return null;
        const size = f.text.length;
        if (known[i]?.[0] === f.mtime && known[i]?.[1] === size) return { mtime: f.mtime, size, text: null, same: true };
        return { mtime: f.mtime, size, text: size > maxSize ? null : f.text, same: false };
      });
    },
    async createDir(path) {
      dirs.add(path);
      ensureDirs(path);
    },
    async createFile(path) {
      if (files.has(path)) throw new Error("The file already exists");
      write(path, "");
    },
    async rename(from, to) {
      if (files.has(to) || dirs.has(to)) throw new Error(`"${basename(to)}" already exists`);
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
    async readImage(path) {
      const img = images.get(path);
      if (!img) throw new Error(`File not found: ${path}`);
      return img;
    },
    async writeImage(path, bytes) {
      if (images.has(path) || files.has(path)) throw new Error("exists");
      ensureDirs(path);
      images.set(path, bytes);
    },
    configDir: async () => "/.config",
    windowLabel,
    async windowPaths() {
      if (windowLabel === "main") return [DEMO_ROOT];
      const key = `kilonote-window-${windowLabel}`;
      const paths = JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
      localStorage.removeItem(key);
      return paths;
    },
    async openWindow(paths, label) {
      const next = label ?? `kn-${Date.now().toString(36)}`;
      localStorage.setItem(`kilonote-window-${next}`, JSON.stringify(paths));
      window.open(`${location.pathname}?window=${encodeURIComponent(next)}`, "_blank");
    },
    windowCount: async () => 1,
    windowAt: async () => null,
    async sendPaths(label, paths) {
      channel?.postMessage({ type: "open", to: label, paths });
    },
    async pruneHistory(keep) {
      const old = [...files.keys()].filter((p) => dirname(p) === "/.config/history").sort().slice(0, -keep || undefined);
      for (const p of old) files.delete(p);
      persist();
    },
    async deleteSession(label) {
      files.delete(label === "main" ? "/.config/session.json" : `/.config/session-${label}.json`);
      persist();
    },
    broadcastSettingsChanged: () => channel?.postMessage({ type: "settings", from: windowLabel }),
    onSettingsChanged(handler) {
      channel?.addEventListener("message", (e: MessageEvent) => {
        if (e.data?.type !== "settings" || e.data.from === windowLabel) return;
        syncFromStorage(); // the message can arrive before the storage event
        handler();
      });
    },
    async pickFolder() {
      return DEMO_ROOT;
    },
    async pickFiles() {
      return [];
    },
    async pickSavePath(defaultPath) {
      const name = window.prompt("Save as (path in the demo)", defaultPath ?? join(DEMO_ROOT, "note.txt"));
      return name || null;
    },
    openUrl: async (url) => {
      if (isSafeUrl(url)) window.open(url, "_blank", "noopener");
    },
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
    onOpenRequest(handler) {
      channel?.addEventListener("message", (e: MessageEvent) => {
        if (e.data?.type === "open" && e.data.to === windowLabel) handler(e.data.paths as string[]);
      });
    },
  };
}
