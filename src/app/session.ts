// The session of a window (open tabs, drafts, folder, layout), saved as you
// work and restored at the next launch, and what happens when a window closes.

import { join } from "../core/path";
import { type LangId } from "../editor/setup";
import { isLangId } from "../editor/languages";
import { confirm } from "../ui/overlay";
import { SIDE_KINDS, type SideKind } from "../ui/views/preview";
import type { App, Doc, TabGroup } from "./app";

export interface SessionTab {
  path: string | null;
  title: string;
  color: string | null;
  group: string | null;
  content?: string;
  eol: "\n" | "\r\n";
  cursor: number;
  scrollTop: number;
  lang?: LangId;
  /** With `content`: modification time of the file the draft was based on. */
  mtime?: number;
  /** The file had changed on disk while the tab had unsaved edits. */
  conflict?: boolean;
}

export interface Session {
  version: 1;
  workspace: string | null;
  recent: string[];
  tabs: SessionTab[];
  active: number;
  groups: TabGroup[];
  /** No longer written (the number of a new draft comes from the open ones). */
  untitled?: number;
  sidebar: { visible: boolean; width: number; panel: string; expanded: string[] };
  zen?: boolean;
  /** The side views turned on (older sessions: true for the Markdown preview). */
  preview?: SideKind[] | boolean;
  /** Width share of the preview pane, and whether it hides the editor. */
  previewSize?: number;
  previewOnly?: boolean;
}

/** Each window keeps its own session: session.json for the main one, session-<label>.json otherwise. */
export const sessionFileName = (label: string) => (label === "main" ? "session.json" : `session-${label}.json`);

const SESSION_FILE_RE = /^session-(kn-[a-zA-Z0-9-]+)\.json$/;

export function sessionTab(app: App, d: Doc): SessionTab {
  const keepContent = app.settings.hot_exit && (d.dirty || !d.path);
  return {
    path: d.path,
    title: d.title,
    color: d.color,
    group: d.groupId,
    content: keepContent ? app.docText(d) : undefined,
    eol: d.eol,
    cursor: app.docCursor(d),
    scrollTop: d === app.active ? app.view.scrollDOM.scrollTop : 0,
    lang: d.path ? undefined : d.lang,
    mtime: keepContent && d.path ? d.mtime : undefined,
    conflict: d.conflict || undefined,
  };
}

export function sessionData(app: App): Session {
  const tabs = app.docs.filter((d) => d.path || (app.settings.hot_exit && app.docText(d).length > 0));
  return {
    version: 1,
    workspace: app.workspace,
    recent: app.recent,
    tabs: tabs.map((d) => sessionTab(app, d)),
    active: app.active ? tabs.indexOf(app.active) : -1,
    groups: app.groups,
    sidebar: app.sidebar.sessionState(),
    zen: app.zen,
    preview: [...app.preview.open],
    previewSize: app.preview.size,
    previewOnly: app.preview.only,
  };
}

export function saveSessionNow(app: App) {
  if (!app.sessionReady) return;
  app.saveSessionSoon.cancel();
  void app.backend.writeText(app.sessionPath, JSON.stringify(sessionData(app))).catch(() => {});
}

export async function readSession(app: App, path: string): Promise<Session | null> {
  try {
    return JSON.parse((await app.backend.readText(path)).text) as Session;
  } catch {
    return null;
  }
}

/** Labels of the other windows that have a saved session. */
export async function otherSessionLabels(app: App): Promise<string[]> {
  const entries = await app.backend.listDir(app.configDir, true).catch(() => []);
  return entries.map((e) => SESSION_FILE_RE.exec(e.name)?.[1]).filter((l): l is string => !!l);
}

/** Reopens the other windows of the last session (desktop app only). */
export async function restoreOtherWindows(app: App) {
  if (app.backend.kind !== "tauri") return;
  for (const label of await otherSessionLabels(app)) await app.backend.openWindow([], label).catch(() => {});
}

export async function restoreSession(app: App) {
  let s = await readSession(app, app.sessionPath);
  // The main window was closed while others stayed open: take over one of their sessions.
  if (!s && app.backend.windowLabel === "main") {
    const other = (await otherSessionLabels(app))[0];
    if (other) {
      s = await readSession(app, join(app.configDir, sessionFileName(other)));
      if (s) await app.backend.deleteSession(other).catch(() => {});
    }
  }
  if (s && s.version === 1) {
    app.recent = s.recent ?? [];
    app.groups = (s.groups ?? []).map((g) => ({ ...g }));
    app.sidebar.restore(s.sidebar);
    if (s.workspace && (await app.backend.stat(s.workspace))?.isDir) {
      app.workspace = s.workspace;
      void app.refreshWorkspaceFiles();
    }
    const conflicts: Doc[] = [];
    const docs = await Promise.all(
      (s.tabs ?? []).map(async (t) => {
        if (!t.path) {
          return app.createDoc({ path: null, text: t.content ?? "", savedText: "", title: t.title, lang: isLangId(t.lang) ? t.lang : undefined, color: t.color, groupId: t.group, cursor: t.cursor, scrollTop: t.scrollTop, eol: t.eol });
        }
        try {
          const ft = await app.backend.readText(t.path);
          const d = app.createDoc({
            path: t.path, text: t.content ?? ft.text, savedText: ft.text, eol: t.eol,
            encoding: ft.encoding, mtime: ft.mtime, color: t.color, groupId: t.group, cursor: t.cursor, scrollTop: t.scrollTop,
          });
          // A draft restored on top of a file that changed since (or was already in
          // conflict): never overwrite the file without asking.
          const changedOnDisk = t.mtime != null && Math.abs(ft.mtime - t.mtime) > 1;
          if (d.dirty && (t.conflict || changedOnDisk)) conflicts.push(d);
          return d;
        } catch {
          if (t.content == null) return null;
          const d = app.createDoc({ path: t.path, text: t.content, savedText: "", eol: t.eol, color: t.color, groupId: t.group });
          d.missing = true;
          return d;
        }
      }),
    );
    app.docs = docs.filter((d): d is Doc => !!d);
    app.groups = app.groups.filter((g) => app.docs.some((d) => d.groupId === g.id));
    for (const d of app.docs) if (d.groupId && !app.groups.some((g) => g.id === d.groupId)) d.groupId = null;
    app.normalizeOrder();
    const activeTab = s.tabs?.[s.active];
    const target = activeTab ? app.docs.find((d) => (activeTab.path ? d.path === activeTab.path : d.title === activeTab.title)) : app.docs[0];
    if (s.zen) app.setZen(true);
    const views: unknown[] = Array.isArray(s.preview) ? s.preview : s.preview ? ["markdown"] : [];
    app.preview.open = new Set(views.filter((v): v is SideKind => SIDE_KINDS.includes(v as SideKind)));
    if (typeof s.previewSize === "number") app.preview.size = Math.min(0.85, Math.max(0.15, s.previewSize));
    app.preview.only = s.previewOnly === true;
    app.activate(target ?? app.docs[0] ?? null);
    for (const d of conflicts) app.flagConflict(d);
  }
  app.sessionReady = true;
}

export async function beforeClose(app: App): Promise<boolean> {
  app.sessionReady = true;
  // Other windows stay open: app window's session is dropped, so unsaved
  // drafts would be lost (the last window keeps them when hot_exit is on).
  const others = (await app.backend.windowCount().catch(() => 1)) > 1;
  if (others || !app.settings.hot_exit) {
    const unsaved = app.docs.filter((d) => d.dirty && (!d.path || !app.settings.autosave || d.missing || d.conflict));
    if (unsaved.length) {
      const r = await confirm({
        title: others ? "Close app window?" : "Quit without saving?",
        message: `Unsaved changes will be lost: ${unsaved.map((d) => app.docName(d)).join(", ")}.`,
        okLabel: others ? "Close window" : "Quit",
        danger: true,
      });
      if (r !== "ok") return false;
    }
  }
  const pending: Promise<boolean>[] = [];
  for (const d of app.docs) {
    clearTimeout(d.timer);
    if (d.dirty && d.path && !d.missing && !d.conflict && app.settings.autosave) pending.push(app.save(d, { auto: true }));
  }
  await Promise.all(pending);
  if (others) {
    app.sessionReady = false;
    app.saveSessionSoon.cancel();
    await app.backend.deleteSession(app.backend.windowLabel).catch(() => {});
    return true;
  }
  await app.backend.writeText(app.sessionPath, JSON.stringify(sessionData(app))).catch(() => {});
  return true;
}
