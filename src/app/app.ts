// The controller of a window: its state (documents, tabs, tab groups, folder,
// settings) and the core document actions (open, activate, save, reload,
// close). The features built on it are functions over the App, one module each:
//
//   commands.ts  every command and the default shortcuts
//   pickers.ts   command palette, Go to file / line / heading, theme pickers
//   tasks.ts     next status, archive, due dates, status menu, activity reports
//   history.ts   local history of replaced versions, Replace in files
//   editing.ts   Format document
//   files.ts     create, rename, trash, copy a path
//   session.ts   session of the window, closing
//   windows.ts   moving a tab to another window

import { ChangeSet, EditorState, Text, type TransactionSpec } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { Backend } from "../core/backend";
import { setKeybindings, setPlatform, type Command } from "../core/commands";
import { parseJsonc } from "../core/jsonc";
import { basename, dirname, extname, isInside, isProbablyBinary, join, samePath } from "../core/path";
import { mergeSettings, setSettingInText, SETTINGS_TEMPLATE, type Settings } from "../core/settings";
import { applyMascot, applyTheme, findTheme } from "../core/themes";
import { editorHooks } from "../editor/decorations";
import { closeSlashMenu } from "../editor/slash";
import { createEditorState, langForPath, languageReady, loadLanguage, reconfigureLanguage, settingsCompartment, settingsExtensions, type LangId } from "../editor/setup";
import { makeTaskConfig, type TaskConfig } from "../text/tasks";
import { debounce } from "../ui/dom";
import { confirm, prompt, setFocusRestorer, toast } from "../ui/overlay";
import { setPaletteFocusRestorer } from "../ui/palette";
import { TabBar } from "../ui/tabbar";
import { Sidebar } from "../ui/sidebar";
import { StatusBar } from "../ui/statusbar";
import { Welcome } from "../ui/welcome";
import { Preview } from "../ui/views/preview";
import { openCheatSheet, openSettingsView, syncAssistant } from "../ui/lazy";
import { noteOpened, onPinsChanged } from "./pins";
import { setIconPack, type IconPack } from "../ui/icons";
import { historyDir, historyName, keepVersion } from "./history";
import { beforeClose, restoreOtherWindows, restoreSession, saveSessionNow, sessionFileName, sessionTab, type SessionTab } from "./session";
import { defaultKeybindings, registerAllCommands, registerStatusCommands } from "./commands";
import { dropImageFiles, installImages } from "./images";
import { installEditorHooks } from "./hooks";
import { showStatusMenu } from "./tasks";

export interface Doc {
  id: number;
  path: string | null;
  title: string;
  state: EditorState;
  savedText: Text;
  dirty: boolean;
  eol: "\n" | "\r\n";
  /** Encoding of the file, kept when saving: UTF-8, UTF-8 BOM, UTF-16 LE/BE or Windows-1252. */
  encoding: string;
  mtime: number;
  lang: LangId;
  color: string | null;
  groupId: string | null;
  missing: boolean;
  /** Changed on disk while the tab has unsaved edits. */
  conflict: boolean;
  scroll: ReturnType<EditorView["scrollSnapshot"]> | null;
  pendingScrollTop: number;
  timer?: ReturnType<typeof setTimeout>;
  saving: Promise<boolean> | null;
}

export interface TabGroup {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
}

export type AppEvent = "docs" | "active" | "workspace" | "settings" | "saved" | "selection" | "pins";

/** Error of the native backend for a file whose content is binary. */
export const NOT_TEXT = "not a text file";

/** Files above this size ask for confirmation; above the maximum, they are not opened. */
export const LARGE_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_FILE_SIZE = 300 * 1024 * 1024;
export const formatSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(0)} MB` : `${Math.ceil(n / 1024)} KB`);

export class App {
  settings!: Settings;
  taskCfg!: TaskConfig;
  docs: Doc[] = [];
  active: Doc | null = null;
  groups: TabGroup[] = [];
  workspace: string | null = null;
  recent: string[] = [];
  workspaceFiles: string[] = [];
  view!: EditorView;
  tabbar!: TabBar;
  sidebar!: Sidebar;
  statusbar!: StatusBar;
  welcome!: Welcome;
  preview!: Preview;
  configDir = "";
  settingsPath = "";
  sessionPath = "";
  zen = false;
  private nextId = 1;
  private closed: SessionTab[] = [];
  private listeners = new Map<AppEvent, Set<() => void>>();
  systemDark = matchMedia("(prefers-color-scheme: dark)");

  constructor(public backend: Backend) {}

  // -------------------------------------------------------------------------
  // Events

  on(ev: AppEvent, fn: () => void) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
  }

  off(ev: AppEvent, fn: () => void) {
    this.listeners.get(ev)?.delete(fn);
  }

  emit(ev: AppEvent) {
    this.listeners.get(ev)?.forEach((fn) => fn());
    if (ev === "docs" || ev === "active" || ev === "workspace") this.saveSessionSoon();
    if (ev === "docs" || ev === "active") this.updateTitle();
  }

  // -------------------------------------------------------------------------
  // Startup

  async init() {
    setPlatform(this.backend.platform);
    document.documentElement.dataset.platform = this.backend.platform;
    this.configDir = await this.backend.configDir();
    this.settingsPath = join(this.configDir, "settings.json");
    this.sessionPath = join(this.configDir, sessionFileName(this.backend.windowLabel));
    this.settings = mergeSettings(await this.readSettingsFile());
    this.taskCfg = this.makeTaskCfg();
    // Shortcuts first: the widgets below show them in their tooltips.
    setKeybindings(defaultKeybindings(this), this.settings.keybindings);

    const host = document.getElementById("editor-host")!;
    this.view = new EditorView({ parent: host, state: this.blankState() });
    this.tabbar = new TabBar(this, document.getElementById("tabbar")!);
    this.sidebar = new Sidebar(this, document.getElementById("sidebar")!, document.getElementById("sb-resizer")!);
    this.statusbar = new StatusBar(this, document.getElementById("statusbar")!);
    this.welcome = new Welcome(this, document.getElementById("welcome")!);
    this.preview = new Preview(this);
    this.preview.attach();

    setFocusRestorer(() => this.focusEditor());
    setPaletteFocusRestorer(() => this.focusEditor());
    editorHooks.onStatusClick = (_v, line, x, y) => showStatusMenu(this, line, x, y);
    editorHooks.openUrl = (url) => void this.backend.openUrl(url);

    registerAllCommands(this);
    installImages(this);
    installEditorHooks(this);
    this.applySettings();
    this.systemDark.addEventListener("change", () => this.settings.theme === "auto" && this.applySettings());

    window.addEventListener("focus", () => {
      void this.checkExternalChanges();
      this.refreshWorkspaceFilesSoon();
    });
    window.addEventListener("blur", () => this.flushAutosaves());
    setInterval(() => document.hasFocus() && this.active?.path && void this.checkExternalChanges([this.active]), 4000);
    this.backend.onFileDrop((paths, at) => void dropImageFiles(this, paths, at).then((rest) => this.openPaths(rest)));
    this.backend.onOpenRequest((paths) => void this.openPaths(paths));
    this.backend.onCloseRequested(() => beforeClose(this));

    this.backend.onSettingsChanged(() => void this.reloadSettingsFromDisk());

    await restoreSession(this);
    const startup = await this.backend.windowPaths().catch(() => [] as string[]);
    if (this.backend.kind === "web" && this.backend.windowLabel === "main") {
      // Browser demo: the main window opens the demo folder.
      if (startup.length && !this.workspace) await this.openFolder(startup[0]);
    } else if (startup.length) await this.openPaths(startup);
    this.on("settings", () => syncAssistant(this));
    // Pinned and recent notes: the explorer, "Go to file" and the welcome screen follow.
    onPinsChanged((change) => change === "pins" && this.emit("pins"));
    this.on("active", () => {
      const p = this.active?.path;
      if (p && !isInside(p, this.configDir)) noteOpened(p);
    });
    this.renderAll();
    if (this.backend.windowLabel === "main") {
      void restoreOtherWindows(this);
      // Once per launch, in the first window, until "Don't show at startup" is ticked.
      if (this.settings.show_shortcuts_at_startup) void openCheatSheet(this, { startup: true });
    }
  }

  private blankState() {
    return createEditorState("", "text", this.settings, this.taskCfg, () => {});
  }

  private makeTaskCfg(): TaskConfig {
    const s = this.settings;
    return makeTaskConfig({
      statuses: s.task_statuses,
      cycle: s.task_cycle,
      done: s.task_done_statuses,
      ongoing: s.task_ongoing_statuses,
      blocked: s.task_blocked_statuses,
      archiveStatus: s.archive_status,
      archiveDate: s.archive_date,
    });
  }

  private renderAll() {
    this.emit("docs");
    this.emit("active");
    this.emit("workspace");
    this.emit("settings");
  }

  focusEditor() {
    if (this.active) this.view.focus();
  }

  // -------------------------------------------------------------------------
  // Settings

  private async readSettingsFile(): Promise<Partial<Settings> | null> {
    try {
      const { text } = await this.backend.readText(this.settingsPath);
      return parseJsonc<Partial<Settings>>(text);
    } catch {
      return null;
    }
  }

  applySettings() {
    const s = this.settings;
    const theme = findTheme(s.theme, this.systemDark.matches);
    applyTheme(theme, s.accent, s.colors);
    applyMascot(s.mascot);
    setIconPack(s.icon_pack as IconPack);
    this.backend.setDark(theme.dark);
    const root = document.documentElement.style;
    root.setProperty("--kn-font", s.font_family);
    root.setProperty("--kn-font-size", `${s.font_size}px`);
    root.setProperty("--kn-line-height", String(s.line_height));
    root.setProperty("--kn-ui-size", `${s.ui_font_size}px`);
    setKeybindings(defaultKeybindings(this), s.keybindings);
    this.taskCfg = this.makeTaskCfg();
    registerStatusCommands(this);
    for (const doc of this.docs) {
      if (!this.stateMade(doc)) continue; // (made with the settings of the moment)
      const effects = settingsCompartment.reconfigure(settingsExtensions(s, this.taskCfg, doc.lang));
      if (doc === this.active) this.view.dispatch({ effects });
      else doc.state = doc.state.update({ effects }).state;
    }
    this.emit("settings");
  }

  /** Changes one value in settings.json (keeping its comments), then applies it. */
  async updateSetting(key: keyof Settings, value: unknown) {
    const open = this.findDoc(this.settingsPath);
    let text: string;
    if (open) text = open.state.doc.toString();
    else {
      try {
        text = (await this.backend.readText(this.settingsPath)).text;
      } catch {
        text = SETTINGS_TEMPLATE;
      }
    }
    const next = setSettingInText(text, key, value);
    try {
      // Through mergeSettings: values are checked and normalized like on startup.
      this.settings = mergeSettings(parseJsonc<Partial<Settings>>(next));
    } catch {
      (this.settings as unknown as Record<string, unknown>)[key] = value;
    }
    this.applySettings();
    if (open) {
      this.replaceDocContent(open, next);
      this.quietSettings = true;
      await this.save(open).finally(() => (this.quietSettings = false));
    } else {
      await this.backend.writeText(this.settingsPath, next).then(
        () => this.backend.broadcastSettingsChanged(),
        (e) => toast(`Settings not saved: ${e}`, { kind: "error" }),
      );
    }
  }

  /** The settings screen, or the settings.json file itself. */
  async openSettings(json = false) {
    if (!json) {
      void openSettingsView(this);
      return;
    }
    const exists = await this.backend.stat(this.settingsPath);
    if (!exists) await this.backend.writeText(this.settingsPath, SETTINGS_TEMPLATE);
    await this.openFile(this.settingsPath);
  }

  private quietSettings = false;
  /** On autosave, apply silently and only if the JSON is valid (it may be mid-edit). */
  private onSettingsSaved(text: string, auto: boolean) {
    let parsed: Partial<Settings>;
    try {
      parsed = parseJsonc<Partial<Settings>>(text);
    } catch (e) {
      if (!auto) toast(`Error in settings.json: ${(e as Error).message}`, { kind: "error" });
      return;
    }
    this.settings = mergeSettings(parsed);
    this.applySettings();
    this.backend.broadcastSettingsChanged();
    if (!auto && !this.quietSettings) toast("Settings applied", { kind: "success", timeout: 1600 });
  }

  /** Another window changed the settings file. */
  private async reloadSettingsFromDisk() {
    const user = await this.readSettingsFile();
    if (!user) return;
    this.settings = mergeSettings(user);
    this.applySettings();
  }

  // -------------------------------------------------------------------------
  // Documents

  createDoc(init: {
    path: string | null; text: string; savedText?: string; eol?: "\n" | "\r\n"; encoding?: string;
    mtime?: number; title?: string; lang?: LangId; color?: string | null; groupId?: string | null; cursor?: number; scrollTop?: number;
  }): Doc {
    const lang = init.lang ?? langForPath(init.path);
    const doc = {
      id: this.nextId++,
      path: init.path,
      title: init.title ?? (init.path ? basename(init.path) : this.untitledTitle()),
      dirty: false,
      eol: init.eol ?? this.defaultEol(),
      encoding: init.encoding ?? "UTF-8",
      mtime: init.mtime ?? 0,
      lang,
      color: init.color ?? null,
      groupId: init.groupId ?? null,
      missing: false,
      conflict: false,
      scroll: null,
      pendingScrollTop: init.scrollTop ?? 0,
      saving: null,
    } as Doc;
    // The editor state is made when the tab is first needed (shown, edited…): a
    // session restores many tabs at once, and most are not looked at right away.
    const saved = init.savedText ?? (init.path ? init.text : "");
    let state: EditorState | null = null;
    let savedText: Text | null = null;
    const make = () => {
      this.unmade.delete(doc);
      let s = createEditorState(init.text, doc.lang, this.settings, this.taskCfg, (u) => this.onEditorUpdate(u));
      if (init.cursor) s = s.update({ selection: { anchor: Math.min(init.cursor, s.doc.length) } }).state;
      // Saved as it is: the saved text is the editor's first one (shared, not copied).
      if (savedText === null && saved === init.text) savedText = s.doc;
      return s;
    };
    Object.defineProperty(doc, "state", {
      get: () => (state ??= make()),
      set: (s: EditorState) => {
        this.unmade.delete(doc);
        state = s;
      },
      enumerable: true,
      configurable: true,
    });
    this.unmade.set(doc, { text: init.text, cursor: init.cursor ?? 0 });
    Object.defineProperty(doc, "savedText", {
      get: () => {
        if (savedText === null) {
          if (saved === init.text) void doc.state; // (sets it)
          else savedText = Text.of(saved.split(/\r\n|\r|\n/));
        }
        return savedText!;
      },
      set: (t: Text) => void (savedText = t),
      enumerable: true,
      configurable: true,
    });
    // (Line endings aside, as the editor reads them.)
    doc.dirty = saved !== init.text && saved.replace(/\r\n?/g, "\n") !== init.text.replace(/\r\n?/g, "\n");
    this.ensureLanguage(doc);
    return doc;
  }

  /** The tabs whose editor state is not made yet: their text and cursor. */
  private unmade = new WeakMap<Doc, { text: string; cursor: number }>();

  /** Whether a tab's editor state is made (it is made when first needed). */
  stateMade(doc: Doc): boolean {
    return !this.unmade.has(doc);
  }

  /** The text of a tab, without making its editor state. */
  docText(doc: Doc): string {
    const pending = this.unmade.get(doc);
    if (pending) return pending.text;
    return (doc === this.active ? this.view.state : doc.state).doc.toString();
  }

  /** The cursor of a tab, without making its editor state. */
  docCursor(doc: Doc): number {
    const pending = this.unmade.get(doc);
    if (pending) return pending.cursor;
    return (doc === this.active ? this.view.state : doc.state).selection.main.head;
  }

  /** Sets the document type of a tab: its coloring and the note features. */
  setLang(doc: Doc, lang: LangId) {
    doc.lang = lang;
    this.applyToDoc(doc, { effects: [reconfigureLanguage(lang), settingsCompartment.reconfigure(settingsExtensions(this.settings, this.taskCfg, lang))] });
    this.ensureLanguage(doc);
    this.emit("docs");
  }

  /** Code languages are loaded on first use: the coloring appears once ready. */
  private ensureLanguage(doc: Doc) {
    const lang = doc.lang;
    if (languageReady(lang)) return;
    void loadLanguage(lang).then((ok) => {
      // (A tab whose state is not made yet gets the language when it is made.)
      if (ok && doc.lang === lang && this.stateMade(doc)) this.applyToDoc(doc, { effects: reconfigureLanguage(lang) });
    });
  }

  /** "Untitled N" with the smallest N that no open draft uses (closed drafts free their number). */
  private untitledTitle(): string {
    const used = new Set<number>();
    for (const d of this.docs) {
      const m = !d.path && /^Untitled (\d+)$/.exec(d.title);
      if (m) used.add(Number(m[1]));
    }
    let n = 1;
    while (used.has(n)) n++;
    return `Untitled ${n}`;
  }

  private defaultEol(): "\n" | "\r\n" {
    const pref = this.settings.default_line_ending;
    if (pref === "crlf") return "\r\n";
    if (pref === "lf") return "\n";
    return this.backend.platform === "windows" ? "\r\n" : "\n";
  }

  findDoc(path: string): Doc | undefined {
    return this.docs.find((d) => d.path && samePath(d.path, path));
  }

  docName(doc: Doc) {
    return doc.path ? basename(doc.path) : doc.title;
  }

  newDoc(opts: { text?: string; title?: string; lang?: LangId; groupId?: string | null } = {}) {
    const doc = this.createDoc({ path: null, text: opts.text ?? "", title: opts.title, lang: opts.lang });
    doc.groupId = opts.groupId ?? this.active?.groupId ?? null;
    this.insertDoc(doc);
    this.activate(doc);
    return doc;
  }

  /** Inserts a tab right after the active one (or at the end of its group). */
  private insertDoc(doc: Doc) {
    if (doc.groupId) {
      const members = this.docs.filter((d) => d.groupId === doc.groupId);
      if (members.length) {
        const anchor = this.active?.groupId === doc.groupId ? this.active : members[members.length - 1];
        this.docs.splice(this.docs.indexOf(anchor) + 1, 0, doc);
        return;
      }
    }
    const i = this.active ? this.docs.indexOf(this.active) : -1;
    if (i >= 0 && !this.active!.groupId) this.docs.splice(i + 1, 0, doc);
    else this.docs.push(doc);
  }

  async openPaths(paths: string[]) {
    for (const p of paths) {
      const meta = await this.backend.stat(p);
      if (meta?.isDir) await this.openFolder(p);
      else if (meta) await this.openFile(p);
    }
  }

  async openFile(path: string, opts: { activate?: boolean; line?: number; select?: [number, number] } = {}): Promise<Doc | null> {
    const activate = opts.activate ?? true;
    let doc = this.findDoc(path);
    if (!doc) {
      // KiloNote never hands a file to the operating system to open or run it:
      // executables (and any other non-text file) can only be shown in the file manager.
      if (isProbablyBinary(path)) return this.refuseBinary(path);
      // A huge file (a log of several hundred MB…) would freeze the window.
      const size = (await this.backend.stat(path))?.size ?? 0;
      if (size > MAX_FILE_SIZE) {
        toast(`"${basename(path)}" is too large to open (${formatSize(size)}).`, { kind: "error" });
        return null;
      }
      if (size > LARGE_FILE_SIZE) {
        const r = await confirm({
          title: `Open "${basename(path)}"?`,
          message: `This file is large (${formatSize(size)}): KiloNote may slow down while it is open.`,
          okLabel: "Open anyway",
        });
        if (r !== "ok") return null;
      }
      try {
        const ft = await this.backend.readText(path);
        doc = this.findDoc(path); // opened in the meantime?
        if (!doc) {
          doc = this.createDoc({
            path, text: ft.text, eol: ft.text.includes("\r\n") ? "\r\n" : ft.text.includes("\n") ? "\n" : this.defaultEol(),
            encoding: ft.encoding, mtime: ft.mtime,
          });
          if (!activate) this.docs.push(doc);
          else this.insertDoc(doc);
          this.normalizeOrder();
          this.emit("docs");
        }
      } catch (e) {
        // The content says binary (an executable or archive renamed, or without extension).
        if (String(e).includes(NOT_TEXT)) return this.refuseBinary(path);
        toast(`Cannot open ${basename(path)}: ${e}`, { kind: "error" });
        return null;
      }
    }
    if (activate) this.activate(doc);
    if (opts.line != null || opts.select) this.reveal(doc, opts.line ?? 1, opts.select);
    return doc;
  }

  private refuseBinary(path: string): null {
    toast(`"${basename(path)}" is not a text file. KiloNote only opens text files and never runs programs.`, {
      kind: "error",
      action: { label: "Reveal in file manager", run: () => this.backend.reveal(path) },
    });
    return null;
  }

  activate(doc: Doc | null) {
    if (doc === this.active) {
      if (doc) this.focusEditor();
      return;
    }
    const prev = this.active;
    if (prev && this.docs.includes(prev)) {
      closeSlashMenu(this.view);
      prev.state = this.view.state;
      prev.scroll = this.view.scrollSnapshot();
    }
    this.active = doc;
    if (doc) {
      this.view.setState(doc.state);
      if (doc.scroll) this.view.dispatch({ effects: doc.scroll });
      else if (doc.pendingScrollTop) {
        const top = doc.pendingScrollTop;
        requestAnimationFrame(() => (this.view.scrollDOM.scrollTop = top));
        doc.pendingScrollTop = 0;
      }
    } else {
      this.view.setState(this.blankState());
    }
    // Show the editor first (the welcome screen hides it), then focus it.
    this.emit("active");
    if (doc) this.view.focus();
  }

  /** Centers line `line` (1-based) on screen, with an optional selection within that line. */
  reveal(doc: Doc, line: number, select?: [number, number]) {
    const st = doc === this.active ? this.view.state : doc.state;
    const l = st.doc.line(Math.max(1, Math.min(line, st.doc.lines)));
    const anchor = select ? Math.min(l.from + select[0], l.to) : l.from;
    const head = select ? Math.min(l.from + select[1], l.to) : l.from;
    const spec: TransactionSpec = { selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) };
    if (doc === this.active) {
      this.view.dispatch(spec);
      this.view.focus();
    } else doc.state = doc.state.update(spec).state;
  }

  private onEditorUpdate(u: ViewUpdate) {
    const doc = this.active;
    if (!doc) return;
    doc.state = u.state;
    if (u.docChanged) {
      this.notifyChanges(doc, u.changes);
      this.afterDocChange(doc);
    }
    if (u.docChanged || u.selectionSet) this.emit("selection");
  }

  private afterDocChange(doc: Doc) {
    const wasDirty = doc.dirty;
    doc.dirty = !doc.state.doc.eq(doc.savedText);
    if (doc.dirty) this.scheduleAutosave(doc);
    if (wasDirty !== doc.dirty) this.emit("docs");
    this.saveSessionSoon();
  }

  /** Applies a transaction to a document, whether it is active or not. */
  applyToDoc(doc: Doc, spec: TransactionSpec) {
    if (doc === this.active) this.view.dispatch(spec);
    else {
      const tr = doc.state.update(spec);
      doc.state = tr.state;
      if (tr.docChanged) {
        this.notifyChanges(doc, tr.changes);
        this.afterDocChange(doc);
      }
    }
  }

  private changeWatchers = new Map<Doc, Set<(changes: ChangeSet) => void>>();
  private notifyChanges(doc: Doc, changes: ChangeSet) {
    this.changeWatchers.get(doc)?.forEach((fn) => fn(changes));
  }

  /** Collects the edits made to a document from now on (to map positions across an await). */
  trackChanges(doc: Doc) {
    const start = doc === this.active ? this.view.state.doc : doc.state.doc;
    let since = ChangeSet.empty(start.length);
    const fn = (c: ChangeSet) => (since = since.compose(c));
    if (!this.changeWatchers.has(doc)) this.changeWatchers.set(doc, new Set());
    this.changeWatchers.get(doc)!.add(fn);
    return {
      changes: () => since,
      stop: () => this.changeWatchers.get(doc)?.delete(fn),
    };
  }

  /** Replaces the content with a minimal change (cursor and undo history are preserved). */
  replaceDocContent(doc: Doc, text: string) {
    const old = doc.state.doc.toString();
    const next = text.replace(/\r\n?/g, "\n");
    if (old === next) return;
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let endOld = old.length;
    let endNew = next.length;
    while (endOld > start && endNew > start && old[endOld - 1] === next[endNew - 1]) {
      endOld--;
      endNew--;
    }
    this.applyToDoc(doc, { changes: { from: start, to: endOld, insert: next.slice(start, endNew) } });
  }

  // -------------------------------------------------------------------------
  // Saving

  private scheduleAutosave(doc: Doc) {
    if (!this.settings.autosave || !doc.path || doc.missing) return;
    clearTimeout(doc.timer);
    doc.timer = setTimeout(() => {
      if (doc.dirty) void this.save(doc, { auto: true });
    }, this.settings.autosave_delay);
  }

  flushAutosaves() {
    for (const d of this.docs) {
      if (d.dirty && d.path && !d.missing && !d.conflict && this.settings.autosave) {
        void this.save(d, { auto: true });
      }
    }
    saveSessionNow(this);
  }

  async save(doc: Doc, opts: { auto?: boolean } = {}): Promise<boolean> {
    if (!doc.path) return opts.auto ? false : this.saveAs(doc);
    clearTimeout(doc.timer);
    if (opts.auto && doc.conflict) return false;
    if (doc.saving) await doc.saving;
    const run = (async () => {
      const path = doc.path!;
      const snapshot = doc.state.doc;
      // Has another program modified the file since it was loaded?
      const meta = await this.backend.stat(path);
      if (meta && doc.mtime && Math.abs(meta.mtime - doc.mtime) > 1) {
        if (opts.auto) {
          this.flagConflict(doc);
          return false;
        }
        const r = await confirm({
          title: `"${basename(path)}" changed on disk`,
          message: "Another program modified this file. Overwrite it with your version?",
          okLabel: "Overwrite", danger: true, altLabel: "Reload from disk",
        });
        if (r === "alt") {
          await this.reloadDoc(doc, true);
          return false;
        }
        if (r === "cancel") return false;
        await keepVersion(this, doc, "disk");
      }
      try {
        const text = snapshot.sliceString(0, snapshot.length, doc.eol);
        const written = await this.backend.writeText(path, text, doc.encoding);
        doc.mtime = written.mtime;
        doc.savedText = snapshot;
        doc.missing = false;
        doc.conflict = false;
        // The file keeps its encoding, unless Windows-1252 cannot hold a new character.
        const converted = written.encoding !== doc.encoding;
        if (converted) {
          toast(`"${basename(path)}" now contains characters that ${doc.encoding} cannot hold: it was saved as ${written.encoding}.`);
        }
        doc.encoding = written.encoding;
        const wasDirty = doc.dirty;
        doc.dirty = !doc.state.doc.eq(snapshot);
        if (wasDirty !== doc.dirty || converted) this.emit("docs");
        this.emit("saved");
        if (samePath(path, this.settingsPath)) this.onSettingsSaved(text, !!opts.auto);
        return true;
      } catch (e) {
        toast(`Could not save ${basename(path)}: ${e}`, { kind: "error" });
        return false;
      }
    })();
    doc.saving = run;
    try {
      return await run;
    } finally {
      if (doc.saving === run) doc.saving = null;
    }
  }

  async saveAs(doc: Doc): Promise<boolean> {
    const base = doc.path ? dirname(doc.path) : this.workspace;
    const suggested = doc.path ? basename(doc.path) : `${doc.title.replace(/[\\/:*?"<>|]/g, "-")}${extname(doc.title) ? "" : ".txt"}`;
    const target = await this.backend.pickSavePath(base ? join(base, suggested) : suggested);
    if (!target) return false;
    const before = { path: doc.path, title: doc.title, mtime: doc.mtime };
    doc.path = target;
    doc.mtime = 0;
    doc.title = basename(target);
    if (!(await this.save(doc))) {
      // Nothing was written: the note stays attached to its previous file.
      Object.assign(doc, before);
      this.emit("docs");
      return false;
    }
    // A tab showing the overwritten file is now out of date.
    const other = this.docs.find((d) => d !== doc && d.path && samePath(d.path, target));
    if (other) await this.closeDoc(other, { force: true });
    const lang = langForPath(target, doc.lang);
    if (lang !== doc.lang) this.setLang(doc, lang);
    this.emit("docs");
    this.refreshWorkspaceFilesSoon();
    return true;
  }

  async saveAll() {
    for (const d of this.docs) if (d.dirty && d.path) await this.save(d);
  }

  async reloadDoc(doc: Doc, force = false) {
    if (!doc.path) return;
    if (doc.dirty && !force) return;
    if (doc.dirty) await keepVersion(this, doc, "mine");
    try {
      const ft = await this.backend.readText(doc.path);
      this.replaceDocContent(doc, ft.text);
      doc.savedText = doc.state.doc;
      doc.dirty = false;
      doc.mtime = ft.mtime;
      doc.encoding = ft.encoding;
      // The other program may have changed the line endings: keep them.
      if (ft.text.includes("\n")) doc.eol = ft.text.includes("\r\n") ? "\r\n" : "\n";
      doc.missing = false;
      doc.conflict = false;
      clearTimeout(doc.timer);
      this.emit("docs");
      this.emit("selection");
    } catch (e) {
      toast(`Could not reload: ${e}`, { kind: "error" });
    }
  }

  private checking = false;
  async checkExternalChanges(docs = this.docs) {
    if (this.checking) return;
    this.checking = true;
    try {
      let changed = false;
      for (const doc of docs) {
        if (!doc.path || doc.saving || doc.conflict) continue;
        const meta = await this.backend.stat(doc.path);
        if (!meta) {
          if (!doc.missing) {
            doc.missing = true;
            changed = true;
          }
          continue;
        }
        if (doc.missing) {
          doc.missing = false;
          changed = true;
        }
        if (doc.mtime && Math.abs(meta.mtime - doc.mtime) > 1) {
          if (!doc.dirty) await this.reloadDoc(doc);
          else this.flagConflict(doc);
        }
      }
      if (changed) this.emit("docs");
    } finally {
      this.checking = false;
    }
  }

  /**
   * The file changed on disk while the tab has unsaved edits:
   * pause autosave and let the user decide.
   */
  flagConflict(doc: Doc) {
    if (doc.conflict) return;
    doc.conflict = true;
    clearTimeout(doc.timer);
    this.emit("docs");
    toast(`"${this.docName(doc)}" was modified by another program.`, {
      kind: "error",
      timeout: 30000,
      actions: [
        { label: "Reload", run: () => this.resolveConflict(doc, "disk") },
        { label: "Keep mine", run: () => this.resolveConflict(doc, "mine") },
      ],
    });
  }

  async resolveConflict(doc: Doc, keep: "disk" | "mine") {
    if (keep === "disk") return this.reloadDoc(doc, true);
    await keepVersion(this, doc, "disk");
    doc.conflict = false;
    doc.mtime = 0; // skip the next check: overwrite
    return this.save(doc);
  }

  // -------------------------------------------------------------------------
  // Closing tabs

  async closeDoc(doc: Doc, opts: { force?: boolean } = {}): Promise<boolean> {
    if (doc.dirty && !opts.force) {
      if (doc.path && this.settings.autosave && !doc.missing && !doc.conflict) {
        clearTimeout(doc.timer);
        if (!(await this.save(doc))) return false;
      } else {
        if (doc !== this.active) this.activate(doc);
        const r = await confirm({
          title: `Save "${this.docName(doc)}"?`,
          message: "Your changes will be lost if you don't save them.",
          okLabel: "Save",
          altLabel: "Don't save",
        });
        if (r === "cancel") return false;
        if (r === "ok" && !(await this.save(doc))) return false;
      }
    }
    clearTimeout(doc.timer);
    const i = this.docs.indexOf(doc);
    if (i < 0) return true;
    if (doc.path) {
      this.closed.push(sessionTab(this, doc));
      if (this.closed.length > 30) this.closed.shift();
    }
    this.docs.splice(i, 1);
    if (this.active === doc) {
      this.active = null;
      const visible = this.docs.filter((d) => !this.isHidden(d));
      const next = this.docs[i] && !this.isHidden(this.docs[i]) ? this.docs[i] : visible[visible.length - 1] ?? this.docs[i - 1] ?? this.docs[0] ?? null;
      this.activate(next ?? null);
      if (!next) this.emit("active");
    }
    this.cleanGroups();
    this.emit("docs");
    return true;
  }

  async closeMany(list: Doc[]) {
    for (const d of [...list]) if (!(await this.closeDoc(d))) return;
  }

  async reopenClosed() {
    const t = this.closed.pop();
    if (!t?.path) return;
    const doc = await this.openFile(t.path);
    if (doc) {
      doc.color = t.color;
      if (t.group && this.groups.some((g) => g.id === t.group)) doc.groupId = t.group;
      this.normalizeOrder();
      this.emit("docs");
    }
  }

  private isHidden(doc: Doc) {
    return !!doc.groupId && !!this.groups.find((g) => g.id === doc.groupId)?.collapsed;
  }

  // -------------------------------------------------------------------------
  // Tab groups

  /** Keeps the tabs of a group next to each other. */
  normalizeOrder() {
    const out: Doc[] = [];
    const seen = new Set<string>();
    for (const d of this.docs) {
      if (!d.groupId) out.push(d);
      else if (!seen.has(d.groupId)) {
        seen.add(d.groupId);
        out.push(...this.docs.filter((x) => x.groupId === d.groupId));
      }
    }
    this.docs = out;
  }

  cleanGroups() {
    this.groups = this.groups.filter((g) => this.docs.some((d) => d.groupId === g.id));
  }

  async createGroup(docs: Doc[]) {
    const used = new Set(this.groups.map((g) => g.color));
    const color = this.settings.tab_colors.find((c) => !used.has(c) && c !== "grey") ?? "blue";
    const r = await prompt({
      title: "New tab group",
      placeholder: "Group name (e.g. Work)",
      okLabel: "Create",
      colors: { options: this.settings.tab_colors, selected: color },
    });
    if (!r) return;
    const group: TabGroup = { id: `g${Date.now().toString(36)}`, name: r.value, color: r.color ?? color, collapsed: false };
    this.groups.push(group);
    // The group takes the place of its first tab.
    const first = Math.min(...docs.map((d) => this.docs.indexOf(d)));
    const rest = this.docs.filter((d) => !docs.includes(d));
    rest.splice(Math.min(first, rest.length), 0, ...docs);
    this.docs = rest;
    for (const d of docs) d.groupId = group.id;
    this.normalizeOrder();
    this.cleanGroups();
    this.emit("docs");
  }

  addToGroup(doc: Doc, groupId: string | null) {
    if (groupId) {
      const members = this.docs.filter((d) => d.groupId === groupId && d !== doc);
      this.docs.splice(this.docs.indexOf(doc), 1);
      const last = members.length ? this.docs.indexOf(members[members.length - 1]) : this.docs.length - 1;
      this.docs.splice(last + 1, 0, doc);
    } else if (doc.groupId) {
      // Leaving a group: the tab goes right after the group.
      const members = this.docs.filter((d) => d.groupId === doc.groupId);
      this.docs.splice(this.docs.indexOf(doc), 1);
      const last = this.docs.indexOf(members.filter((d) => d !== doc).pop() ?? doc);
      this.docs.splice(last + 1, 0, doc);
    }
    doc.groupId = groupId;
    this.normalizeOrder();
    this.cleanGroups();
    this.emit("docs");
  }

  async editGroup(group: TabGroup) {
    const r = await prompt({
      title: "Edit group",
      value: group.name,
      okLabel: "Save",
      colors: { options: this.settings.tab_colors, selected: group.color },
    });
    if (!r) return;
    group.name = r.value;
    if (r.color) group.color = r.color;
    this.emit("docs");
  }

  /**
   * Collapses or expands a group. A collapsed group shows only its chip, plus
   * its tab that is being edited (like a compact tab stack).
   */
  toggleGroup(group: TabGroup, collapsed = !group.collapsed) {
    if (group.collapsed === collapsed) return;
    group.collapsed = collapsed;
    this.emit("docs");
  }

  /** The group of the current tab (palette command). */
  toggleActiveGroup() {
    const group = this.active?.groupId ? this.groups.find((g) => g.id === this.active!.groupId) : null;
    if (!group) {
      this.toastInfo("This tab is not in a group: right-click a tab to create one.");
      return;
    }
    this.toggleGroup(group);
  }

  setAllGroupsCollapsed(collapsed: boolean) {
    if (!this.groups.length) {
      this.toastInfo("No tab group yet: right-click a tab to create one.");
      return;
    }
    for (const g of this.groups) g.collapsed = collapsed;
    this.emit("docs");
  }

  ungroup(group: TabGroup) {
    for (const d of this.docs) if (d.groupId === group.id) d.groupId = null;
    this.cleanGroups();
    this.emit("docs");
  }

  /** Moves a tab to index `to` (drag and drop) and updates its group. */
  moveDoc(doc: Doc, to: number) {
    const from = this.docs.indexOf(doc);
    if (from < 0) return;
    this.docs.splice(from, 1);
    const idx = to > from ? to - 1 : to;
    this.docs.splice(idx, 0, doc);
    const left = this.docs[idx - 1];
    const right = this.docs[idx + 1];
    if (left?.groupId && left.groupId === right?.groupId) doc.groupId = left.groupId;
    else if (doc.groupId && (left?.groupId === doc.groupId || right?.groupId === doc.groupId)) {
      /* stays in its group */
    } else doc.groupId = null;
    this.normalizeOrder();
    this.cleanGroups();
    this.emit("docs");
  }

  // -------------------------------------------------------------------------
  // Workspace

  async openFolder(path?: string) {
    const dir = path ?? (await this.backend.pickFolder());
    if (!dir) return;
    if (path && !(await this.backend.stat(dir))?.isDir) {
      // A recent folder that was moved, deleted, or is on a disconnected drive.
      this.recent = this.recent.filter((r) => !samePath(r, dir));
      toast(`Folder not found: ${dir}`, { kind: "error" });
      this.emit("workspace");
      return;
    }
    this.workspace = dir;
    this.recent = [dir, ...this.recent.filter((r) => !samePath(r, dir))].slice(0, 8);
    this.sidebar.visible = true;
    this.emit("workspace");
    await this.refreshWorkspaceFiles();
  }

  closeFolder() {
    this.workspace = null;
    this.workspaceFiles = [];
    this.emit("workspace");
  }

  async refreshWorkspaceFiles() {
    if (!this.workspace) return;
    try {
      this.workspaceFiles = await this.backend.walk(this.workspace, this.settings.show_hidden_files, 20000);
    } catch {
      this.workspaceFiles = [];
    }
    this.emit("workspace");
  }

  refreshWorkspaceFilesSoon = debounce(() => void this.refreshWorkspaceFiles(), 400);

  isNoteFile(path: string) {
    const ext = extname(path);
    return this.settings.note_extensions.includes(ext) || (!ext && !isProbablyBinary(path));
  }

  /**
   * The texts of the files read lately for the whole folder (search, tasks, board…),
   * with their stamp: a file is read again only when it changed. Bounded in size.
   */
  private fileTexts = new Map<string, { mtime: number; size: number; text: string | null }>();
  private fileTextsChars = 0;
  private static FILE_TEXTS_MAX = 16_000_000;

  private keepFileText(path: string, entry: { mtime: number; size: number; text: string | null } | null) {
    const old = this.fileTexts.get(path);
    if (old) {
      this.fileTexts.delete(path);
      this.fileTextsChars -= old.text?.length ?? 0;
    }
    if (!entry) return;
    this.fileTexts.set(path, entry);
    this.fileTextsChars += entry.text?.length ?? 0;
    // The ones not needed for the longest time go first.
    for (const [p, e] of this.fileTexts) {
      if (this.fileTextsChars <= App.FILE_TEXTS_MAX || p === path) break;
      this.fileTexts.delete(p);
      this.fileTextsChars -= e.text?.length ?? 0;
    }
  }

  /** File contents: the in-memory version if the tab is open, otherwise from disk (only what changed is read again). */
  async readFiles(paths: string[]): Promise<(string | null)[]> {
    const out: (string | null)[] = new Array(paths.length).fill(null);
    let toRead: number[] = [];
    paths.forEach((p, i) => {
      const d = this.findDoc(p);
      if (d) out[i] = this.docText(d);
      else toRead.push(i);
    });
    // Twice at most: a file known when asked may have been forgotten meanwhile (read again, whole).
    for (let pass = 0; pass < 2 && toRead.length; pass++) {
      const known = toRead.map((i): [number, number] | null => {
        const k = pass ? undefined : this.fileTexts.get(paths[i]);
        return k ? [k.mtime, k.size] : null;
      });
      const fresh = await this.backend.readChanged(toRead.map((i) => paths[i]), known, 2_000_000);
      const missed: number[] = [];
      toRead.forEach((i, k) => {
        const f = fresh[k];
        const path = paths[i];
        if (!f) this.keepFileText(path, null);
        else if (!f.same) this.keepFileText(path, { mtime: f.mtime, size: f.size, text: f.text });
        else {
          const kept = this.fileTexts.get(path);
          if (!kept) return void missed.push(i);
          this.keepFileText(path, kept); // (now the most recent)
        }
        out[i] = this.fileTexts.get(path)?.text ?? null;
      });
      toRead = missed;
    }
    return out;
  }

  /** settings.json back to the template (the current file goes to the local history). */
  async resetSettings() {
    try {
      const { text } = await this.backend.readText(this.settingsPath);
      await this.backend.writeText(join(historyDir(this), historyName(this.settingsPath, "disk")), text);
    } catch {
      /* no file yet */
    }
    const open = this.findDoc(this.settingsPath);
    if (open) {
      this.replaceDocContent(open, SETTINGS_TEMPLATE);
      this.quietSettings = true;
      await this.save(open).finally(() => (this.quietSettings = false));
    } else await this.backend.writeText(this.settingsPath, SETTINGS_TEMPLATE);
    this.settings = mergeSettings(null);
    this.applySettings();
    this.backend.broadcastSettingsChanged();
  }

  // -------------------------------------------------------------------------
  // Session (session.ts)

  sessionReady = false;
  saveSessionSoon = debounce(() => saveSessionNow(this), 1000);

  // -------------------------------------------------------------------------
  // Display

  updateTitle() {
    const d = this.active;
    const ws = this.workspace ? basename(this.workspace) : null;
    const parts = [d ? `${d.dirty ? "● " : ""}${this.docName(d)}` : null, ws, "KiloNote"].filter(Boolean);
    this.backend.setTitle(parts.join(" — "));
  }

  setZen(on: boolean) {
    this.zen = on;
    document.body.classList.toggle("zen", on);
    this.saveSessionSoon();
  }

  zoom(delta: number | null) {
    const size = delta == null ? 14 : Math.max(8, Math.min(40, this.settings.font_size + delta));
    void this.updateSetting("font_size", size);
  }

  toastInfo(message: string) {
    toast(message);
  }

  // -------------------------------------------------------------------------
  // Tab order

  /** Every command (commands.ts), as the palette lists them. */
  commandList: Command[] = [];

  private visibleDocs() {
    return this.docs.filter((d) => !this.isHidden(d) || d === this.active);
  }

  cycleTab(dir: number) {
    const list = this.visibleDocs();
    if (!list.length) return;
    const i = this.active ? list.indexOf(this.active) : -1;
    this.activate(list[(i + dir + list.length) % list.length]);
  }

  gotoTab(n: number) {
    const list = this.visibleDocs();
    const doc = n === 9 ? list[list.length - 1] : list[n - 1];
    if (doc) this.activate(doc);
  }
}
