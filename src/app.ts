// Main controller: documents, tabs, tab groups, session, commands.

import { ChangeSet, EditorState, Text, type ChangeSpec, type TransactionSpec } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import type { Backend } from "./core/backend";
import { registerCommands, runCommand, setKeybindings, setPlatform, shortcutFor, type Command } from "./core/commands";
import { parseJsonc } from "./core/jsonc";
import {
  basename, dirname, doneFileFor, extname, isDoneFile, isInside, isProbablyBinary, isWindowsPath, join, projectName, relative, samePath, stem,
} from "./core/path";
import { mergeSettings, setSettingInText, SETTINGS_TEMPLATE, type Settings } from "./core/settings";
import { applyMascot, applyTheme, findTheme, MASCOT_VARIANTS, PALETTE_LABELS, THEMES } from "./core/themes";
import { fuzzyFilter } from "./core/fuzzy";
import { editorHooks } from "./editor/decorations";
import { createEditorState, langForPath, languageReady, loadLanguage, reconfigureLanguage, settingsCompartment, settingsExtensions, type LangId } from "./editor/setup";
import { isLangId, LANGUAGES, languageLabel } from "./editor/languages";
import { FormatError, formatKindFor, formatText, minifyJson } from "./editor/format";
import {
  archivedLine, cycleLine, findTags, findTasks, isDoneStatus, makeTaskConfig, parseDateInput, parseTask, setDueInLine, todayISO,
  type TaskConfig,
} from "./editor/tasks";
import { buildReport, periodFor, type PeriodKind, type ReportSource } from "./report";
import { debounce } from "./ui/dom";
import { confirm, prompt, setFocusRestorer, showMenu, toast, type MenuItem } from "./ui/overlay";
import { openPicker, setPaletteFocusRestorer, type PickItem } from "./ui/palette";
import { TabBar } from "./ui/tabbar";
import { Sidebar } from "./ui/sidebar";
import { StatusBar } from "./ui/statusbar";
import { Welcome } from "./ui/welcome";
import { Preview, type SideKind } from "./ui/preview";
import { showSettingsView } from "./ui/settings-view";
import { showCheatSheet } from "./ui/cheatsheet";
import { setIconPack, type IconPack } from "./ui/icons";
import { GUIDE } from "./guide";

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

interface SessionTab {
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

interface Session {
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
}

type AppEvent = "docs" | "active" | "workspace" | "settings" | "saved" | "selection";

/** Each window keeps its own session: session.json for the main one, session-<label>.json otherwise. */
const sessionFileName = (label: string) => (label === "main" ? "session.json" : `session-${label}.json`);
const SESSION_FILE_RE = /^session-(kn-[a-zA-Z0-9-]+)\.json$/;
/** Error of the native backend for a file whose content is binary. */
const NOT_TEXT = "not a text file";

/** Local history: <config>/history/<stamp>_<path hash>_<kind>_<file name>, newest kept. */
type HistoryKind = "disk" | "mine" | "replace";
const HISTORY_KEEP = 300;
const HISTORY_LABELS: Record<HistoryKind, string> = {
  disk: "Version on disk, before KiloNote overwrote it",
  mine: "Your unsaved edits, before reloading from disk",
  replace: "Before \"Replace in files\"",
};

/** FNV-1a hash of a path (case-insensitive on Windows). */
export function pathHash(path: string): string {
  const norm = isWindowsPath(path) ? path.replace(/\\/g, "/").toLowerCase() : path;
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function historyName(path: string, kind: HistoryKind, now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`;
  return `${stamp}_${pathHash(path)}_${kind}_${basename(path)}`;
}

export function parseHistoryName(name: string): { hash: string; kind: HistoryKind; when: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-\d{3}_([0-9a-f]{8})_(disk|mine|replace)_/.exec(name);
  if (!m) return null;
  return { hash: m[7], kind: m[8] as HistoryKind, when: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` };
}

/** Files above this size ask for confirmation; above the maximum, they are not opened. */
const LARGE_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILE_SIZE = 300 * 1024 * 1024;
const formatSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(0)} MB` : `${Math.ceil(n / 1024)} KB`);

/** Removes whole lines (1-based numbers, ascending), in contiguous blocks so that changes never overlap. */
function lineRemoval(doc: Text, numbers: number[]): ChangeSet {
  const specs: { from: number; to: number }[] = [];
  let i = 0;
  while (i < numbers.length) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    const a = doc.line(numbers[i]);
    const b = doc.line(numbers[j]);
    if (b.number < doc.lines) specs.push({ from: a.from, to: b.to + 1 });
    else specs.push({ from: a.number > 1 ? a.from - 1 : a.from, to: b.to });
    i = j + 1;
  }
  return ChangeSet.of(specs, doc.length);
}

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
  private systemDark = matchMedia("(prefers-color-scheme: dark)");

  constructor(public backend: Backend) {}

  // -------------------------------------------------------------------------
  // Events

  on(ev: AppEvent, fn: () => void) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
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
    setKeybindings(this.defaultKeybindings(), this.settings.keybindings);

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
    editorHooks.onStatusClick = (_v, line, x, y) => this.showStatusMenu(line, x, y);
    editorHooks.openUrl = (url) => void this.backend.openUrl(url);

    this.registerAllCommands();
    this.applySettings();
    this.systemDark.addEventListener("change", () => this.settings.theme === "auto" && this.applySettings());

    window.addEventListener("focus", () => {
      void this.checkExternalChanges();
      this.refreshWorkspaceFilesSoon();
    });
    window.addEventListener("blur", () => this.flushAutosaves());
    setInterval(() => document.hasFocus() && this.active?.path && void this.checkExternalChanges([this.active]), 4000);
    this.backend.onFileDrop((paths) => void this.openPaths(paths));
    this.backend.onOpenRequest((paths) => void this.openPaths(paths));
    this.backend.onCloseRequested(() => this.beforeClose());

    this.backend.onSettingsChanged(() => void this.reloadSettingsFromDisk());

    await this.restoreSession();
    const startup = await this.backend.windowPaths().catch(() => [] as string[]);
    if (this.backend.kind === "web" && this.backend.windowLabel === "main") {
      // Browser demo: the main window opens the demo folder.
      if (startup.length && !this.workspace) await this.openFolder(startup[0]);
    } else if (startup.length) await this.openPaths(startup);
    this.renderAll();
    if (this.backend.windowLabel === "main") {
      void this.restoreOtherWindows();
      // Once per launch, in the first window, until "Don't show at startup" is ticked.
      if (this.settings.show_shortcuts_at_startup) showCheatSheet(this, { startup: true });
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
    setKeybindings(this.defaultKeybindings(), s.keybindings);
    this.taskCfg = this.makeTaskCfg();
    this.registerStatusCommands();
    for (const doc of this.docs) {
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
      showSettingsView(this);
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

  private createDoc(init: {
    path: string | null; text: string; savedText?: string; eol?: "\n" | "\r\n"; encoding?: string;
    mtime?: number; title?: string; lang?: LangId; color?: string | null; groupId?: string | null; cursor?: number; scrollTop?: number;
  }): Doc {
    const lang = init.lang ?? langForPath(init.path);
    const doc: Doc = {
      id: this.nextId++,
      path: init.path,
      title: init.title ?? (init.path ? basename(init.path) : this.untitledTitle()),
      state: null as unknown as EditorState,
      savedText: Text.empty,
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
    };
    let state = createEditorState(init.text, lang, this.settings, this.taskCfg, (u) => this.onEditorUpdate(u));
    if (init.cursor) state = state.update({ selection: { anchor: Math.min(init.cursor, state.doc.length) } }).state;
    doc.state = state;
    const saved = init.savedText ?? (init.path ? init.text : "");
    doc.savedText = saved === init.text ? state.doc : Text.of(saved.split(/\r\n|\r|\n/));
    doc.dirty = !state.doc.eq(doc.savedText);
    this.ensureLanguage(doc);
    return doc;
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
      if (ok && doc.lang === lang) this.applyToDoc(doc, { effects: reconfigureLanguage(lang) });
    });
  }

  /**
   * Formats the selection, or the whole document: JSON (comments kept), XML,
   * HTML, CSS, Markdown tables. One undo step; the cursor stays close.
   */
  formatDocument(mode: "format" | "minify" = "format") {
    const doc = this.active;
    if (!doc) return;
    const st = this.view.state;
    const sel = st.selection.main;
    const whole = sel.empty;
    const from = whole ? 0 : sel.from;
    const to = whole ? st.doc.length : sel.to;
    const text = st.sliceDoc(from, to);
    if (!text.trim()) return;
    // A selection is recognized by its content first (some JSON in a note).
    const kind = mode === "minify" ? "json" : whole ? formatKindFor(doc.lang, text) : (formatKindFor("text", text) ?? formatKindFor(doc.lang, text));
    if (!kind) {
      this.toastInfo(`Nothing to format in ${languageLabel(doc.lang)}: KiloNote formats JSON, XML, HTML, CSS and Markdown tables (select some JSON or XML to format just that).`);
      return;
    }
    let out: string;
    try {
      const indent = this.settings.indent_with_tabs ? "\t" : " ".repeat(this.settings.tab_size);
      out = mode === "minify" ? minifyJson(text) : formatText(kind, text, indent);
    } catch (e) {
      if (!(e instanceof FormatError)) throw e;
      const pos = from + Math.min(e.pos, text.length);
      const goto = () => {
        if (doc !== this.active) this.activate(doc);
        const line = this.view.state.doc.lineAt(Math.min(pos, this.view.state.doc.length));
        this.reveal(doc, line.number, [pos - line.from, pos - line.from]);
      };
      toast(e.message, { kind: "error", action: { label: "Go to the error", run: goto } });
      return;
    }
    if (!whole && !text.endsWith("\n")) out = out.replace(/\n$/, "");
    if (whole && mode === "minify" && text.endsWith("\n")) out += "\n";
    if (out === text) {
      this.toastInfo(mode === "minify" ? "Already minified." : "Already formatted.");
      return;
    }
    // Only the part that differs is replaced: the cursor and the scroll stay put.
    let a = 0;
    while (a < text.length && a < out.length && text[a] === out[a]) a++;
    let b = 0;
    while (b < text.length - a && b < out.length - a && text[text.length - 1 - b] === out[out.length - 1 - b]) b++;
    this.view.dispatch({
      changes: { from: from + a, to: to - b, insert: out.slice(a, out.length - b) },
      userEvent: "input.format",
      ...(whole ? {} : { selection: { anchor: from, head: from + out.length } }),
    });
    this.focusEditor();
  }

  /** Picker of the document types (status bar, palette). */
  selectLanguage(doc = this.active) {
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
      pick: (it) => this.setLang(doc, it.value as LangId),
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
  private trackChanges(doc: Doc) {
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
    this.saveSessionNow();
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
        await this.keepVersion(doc, "disk");
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
    if (doc.dirty) await this.keepVersion(doc, "mine");
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
  private flagConflict(doc: Doc) {
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
    await this.keepVersion(doc, "disk");
    doc.conflict = false;
    doc.mtime = 0; // skip the next check: overwrite
    return this.save(doc);
  }

  // -------------------------------------------------------------------------
  // Local history: a copy of any version KiloNote is about to throw away
  // (the file on disk before overwriting it, unsaved edits before reloading).

  private historyDir() {
    return join(this.configDir, "history");
  }

  async keepVersion(doc: Doc, kind: HistoryKind) {
    if (!doc.path) return;
    try {
      const text = kind === "mine" ? (doc === this.active ? this.view.state : doc.state).doc.toString() : (await this.backend.readText(doc.path)).text;
      await this.backend.writeText(join(this.historyDir(), historyName(doc.path, kind)), text);
      void this.backend.pruneHistory(HISTORY_KEEP).catch(() => {});
    } catch {
      /* best effort: never block a save or a reload */
    }
  }

  /**
   * "Replace in files": every match of `re` (line by line) in these files. Open
   * notes are changed in their tab and saved; the others are rewritten in their
   * own encoding after a copy goes to the local history. Undo puts every file back.
   */
  async replaceInFiles(paths: string[], re: RegExp, replacement: string, literal: boolean): Promise<{ files: number; count: number }> {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    const global = new RegExp(re.source, flags);
    const done: { path: string; original: string; encoding: string; mtime: number; open: boolean }[] = [];
    let count = 0;
    for (const path of paths) {
      const doc = this.findDoc(path);
      let original: string;
      let encoding = "UTF-8";
      if (doc) original = (doc === this.active ? this.view.state : doc.state).doc.toString();
      else {
        try {
          const ft = await this.backend.readText(path);
          original = ft.text;
          encoding = ft.encoding;
        } catch {
          continue;
        }
      }
      let n = 0;
      const eol = original.includes("\r\n") ? "\r\n" : "\n";
      const next = original
        .split(/\r\n|\r|\n/)
        .map((line) => {
          for (const m of line.matchAll(global)) if (m[0].length) n++;
          return literal ? line.replace(global, () => replacement) : line.replace(global, replacement);
        })
        .join(eol);
      if (!n || next === original) continue;
      if (doc) {
        this.replaceDocContent(doc, next);
        if (doc.path && !(await this.save(doc))) continue;
        done.push({ path, original, encoding: doc.encoding, mtime: doc.mtime, open: true });
      } else {
        await this.backend.writeText(join(this.historyDir(), historyName(path, "replace")), original).catch(() => {});
        try {
          const written = await this.backend.writeText(path, next, encoding);
          done.push({ path, original, encoding: written.encoding, mtime: written.mtime, open: false });
        } catch (e) {
          toast(`Could not write ${basename(path)}: ${e}`, { kind: "error" });
          continue;
        }
      }
      count += n;
    }
    void this.backend.pruneHistory(HISTORY_KEEP).catch(() => {});
    if (done.length) {
      const undo = async () => {
        for (const f of done) {
          const doc = this.findDoc(f.path);
          if (doc) {
            this.replaceDocContent(doc, f.original);
            await this.save(doc);
          } else if ((await this.backend.stat(f.path))?.mtime === f.mtime) {
            await this.backend.writeText(f.path, f.original, f.encoding).catch(() => {});
          }
        }
        this.emit("saved");
      };
      toast(`${count} replacement${count > 1 ? "s" : ""} in ${done.length} file${done.length > 1 ? "s" : ""}.`, {
        kind: "success", timeout: 12000, action: { label: "Undo", run: undo },
      });
      this.emit("saved");
    }
    return { files: done.length, count };
  }

  async showLocalHistory() {
    const doc = this.active;
    if (!doc?.path) {
      toast("Local history keeps earlier versions of saved notes.");
      return;
    }
    const path = doc.path;
    const entries = (await this.backend.listDir(this.historyDir(), true).catch(() => []))
      .map((e) => ({ entry: e, info: parseHistoryName(e.name) }))
      .filter((x) => x.info?.hash === pathHash(path))
      .sort((a, b) => b.entry.name.localeCompare(a.entry.name));
    if (!entries.length) {
      toast(`No earlier version of "${basename(path)}" yet. KiloNote keeps one whenever a version is about to be overwritten (conflicts, reloads, replace in files).`, { timeout: 6000 });
      return;
    }
    openPicker({
      placeholder: `Earlier versions of ${basename(path)}`,
      provide: (q) => ({
        items: fuzzyFilter(q, entries, (x) => `${x.info!.when} ${HISTORY_LABELS[x.info!.kind]}`).map(({ item }) => ({
          label: item.info!.when, detail: HISTORY_LABELS[item.info!.kind], icon: "file", value: item.entry.path,
        })),
      }),
      pick: async (it) => {
        const { text } = await this.backend.readText(it.value as string);
        const when = parseHistoryName(basename(it.value as string))!.when;
        this.newDoc({ text, title: `${basename(path)} (${when})`, lang: doc.lang });
      },
    });
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
      this.closed.push(this.sessionTab(doc));
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

  /** File contents: the in-memory version if the tab is open, otherwise read from disk. */
  async readFiles(paths: string[]): Promise<(string | null)[]> {
    const out: (string | null)[] = new Array(paths.length).fill(null);
    const toRead: number[] = [];
    paths.forEach((p, i) => {
      const d = this.findDoc(p);
      if (d) out[i] = d.state.doc.toString();
      else toRead.push(i);
    });
    if (toRead.length) {
      const texts = await this.backend.readMany(toRead.map((i) => paths[i]), 2_000_000);
      toRead.forEach((i, k) => (out[i] = texts[k]));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Tasks

  private selectedLines(state: EditorState): number[] {
    const set = new Set<number>();
    for (const r of state.selection.ranges) {
      const a = state.doc.lineAt(r.from).number;
      const endLine = state.doc.lineAt(r.to);
      let b = endLine.number;
      if (!r.empty && b > a && endLine.from === r.to) b--;
      for (let i = a; i <= b; i++) set.add(i);
    }
    return [...set].sort((x, y) => x - y);
  }

  /**
   * Ctrl+Enter: next status (or `target`) on the selected lines.
   * Resolves once an automatic archive (auto_archive) is written.
   */
  async cycleTasks(target?: string, doc = this.active, lines?: number[]): Promise<void> {
    if (!doc) return;
    const state = doc === this.active ? this.view.state : doc.state;
    const nums = lines ?? this.selectedLines(state);
    const multi = nums.length > 1;
    const changes: ChangeSpec[] = [];
    let cursor: number | null = null;
    const nowDone: number[] = [];
    for (const n of nums) {
      const line = state.doc.line(n);
      if (multi && !line.text.trim()) continue;
      const edit = cycleLine(line.text, this.taskCfg, target);
      if (!edit) continue;
      for (const c of edit.changes) changes.push({ from: line.from + c.from, to: line.from + c.to, insert: c.insert });
      if (!multi && edit.cursor != null) cursor = line.from + edit.cursor;
      let text = line.text;
      for (const c of [...edit.changes].reverse()) text = text.slice(0, c.from) + c.insert + text.slice(c.to);
      const t = parseTask(text, this.taskCfg);
      if (t && isDoneStatus(t.key, this.taskCfg)) nowDone.push(n);
    }
    if (!changes.length) return;
    this.applyToDoc(doc, {
      changes,
      selection: cursor != null ? { anchor: cursor } : undefined,
      userEvent: "input.task",
      scrollIntoView: doc === this.active,
    });
    if (this.settings.auto_archive && nowDone.length && doc.path && !isDoneFile(doc.path, this.settings.archive_suffix)) {
      await this.archiveLines(doc, nowDone);
    }
  }

  /** Moves lines to the archive file (<name>_done.<ext>). */
  async archiveLines(doc: Doc, lineNumbers: number[]) {
    if (!doc.path) {
      toast("Save this note first to archive its tasks.", {
        action: { label: "Save", run: () => void this.saveAs(doc) },
      });
      return;
    }
    const suffix = this.settings.archive_suffix;
    if (isDoneFile(doc.path, suffix)) {
      toast("This note is already an archive file.");
      return;
    }
    const state = doc === this.active ? this.view.state : doc.state;
    const lines = lineNumbers.map((n) => state.doc.line(n)).filter((l) => l.text.trim());
    if (!lines.length) return;
    const date = todayISO();
    const out = lines.map((l) => archivedLine(l.text, this.taskCfg, date));
    const target = doneFileFor(doc.path, suffix);

    // The archive is written first: if that fails, the note is left untouched.
    const tracker = this.trackChanges(doc);
    try {
      await this.appendToFile(target, out);
    } catch (e) {
      toast(`Could not archive (${e}). The note was not changed.`, { kind: "error" });
      return;
    } finally {
      tracker.stop();
    }
    // Then the lines leave the note, wherever they are now (it may have been edited meanwhile).
    const current = doc === this.active ? this.view.state : doc.state;
    const since = tracker.changes();
    const kept: number[] = [];
    const now: number[] = [];
    for (const l of lines) {
      const pos = since.mapPos(l.from, 1);
      const line = current.doc.lineAt(Math.min(pos, current.doc.length));
      if (line.from === pos && line.text === l.text && !now.includes(line.number)) now.push(line.number);
      else kept.push(l.number);
    }
    const removal = lineRemoval(current.doc, now);
    if (!removal.empty) this.applyToDoc(doc, { changes: removal, userEvent: "delete.archive" });
    const n = out.length;
    toast(
      kept.length
        ? `${n} task${n > 1 ? "s" : ""} archived → ${basename(target)}. ${kept.length} line${kept.length > 1 ? "s were" : " was"} edited meanwhile and kept in the note.`
        : `${n} task${n > 1 ? "s" : ""} archived → ${basename(target)}`,
      { kind: "success", action: { label: "Open", run: () => void this.openFile(target) } },
    );
    this.refreshWorkspaceFilesSoon();
  }

  async archiveSelection() {
    const doc = this.active;
    if (!doc) return;
    await this.archiveLines(doc, this.selectedLines(this.view.state));
  }

  async archiveAllDone() {
    const doc = this.active;
    if (!doc) return;
    const found = findTasks(this.view.state.doc.toString(), this.taskCfg).filter((f) => isDoneStatus(f.task.key, this.taskCfg));
    if (!found.length) {
      toast("No completed task in this note.");
      return;
    }
    await this.archiveLines(doc, found.map((f) => f.line));
  }

  private async appendToFile(path: string, lines: string[]) {
    const open = this.findDoc(path);
    if (open) {
      const d = open.state.doc;
      const last = d.line(d.lines);
      const prefix = d.length === 0 || last.length === 0 ? "" : "\n";
      this.applyToDoc(open, { changes: { from: d.length, insert: prefix + lines.join("\n") + "\n" } });
      if (!(await this.save(open))) throw new Error("could not save the archive");
    } else {
      await this.backend.appendLines(path, lines);
    }
  }

  /** Switches between work.txt and work_done.txt. */
  async toggleDoneFile() {
    const doc = this.active;
    if (!doc?.path) return;
    const suffix = this.settings.archive_suffix;
    let target: string;
    if (isDoneFile(doc.path, suffix)) {
      const s = stem(doc.path);
      target = join(dirname(doc.path), s.slice(0, s.length - suffix.length) + (extname(doc.path) ? doc.path.slice(doc.path.lastIndexOf(".")) : ""));
    } else target = doneFileFor(doc.path, suffix);
    if (!(await this.backend.stat(target))) {
      toast(`${basename(target)} doesn't exist yet: it will be created by the first archive.`);
      return;
    }
    await this.openFile(target);
  }

  showStatusMenu(lineNo: number, x: number, y: number) {
    const doc = this.active;
    if (!doc) return;
    const line = this.view.state.doc.line(lineNo);
    const task = parseTask(line.text, this.taskCfg);
    const items: MenuItem[] = [{ header: "Status" }];
    for (const [name, color] of Object.entries(this.taskCfg.statuses)) {
      items.push({
        label: name,
        color,
        checked: task?.key === name,
        action: () => this.cycleTasks(name, doc, [lineNo]),
      });
    }
    if (doc.path && !isDoneFile(doc.path, this.settings.archive_suffix)) {
      items.push({ separator: true });
      items.push({
        label: `Archive to ${basename(doneFileFor(doc.path, this.settings.archive_suffix))}`,
        icon: "archive",
        shortcut: shortcutFor("task.archive"),
        action: () => this.archiveLines(doc, [lineNo]),
      });
    }
    showMenu(items, x, y);
  }

  // -------------------------------------------------------------------------
  // Activity report

  private needFolder(): boolean {
    if (this.workspace) return true;
    toast("Open the folder that contains your notes first.", { action: { label: "Open folder", run: () => void this.openFolder() } });
    return false;
  }

  /** Every project of the folder: its note and its _done archive. */
  private async reportSources(): Promise<ReportSource[]> {
    await this.refreshWorkspaceFiles();
    const suffix = this.settings.archive_suffix;
    const notes = this.workspaceFiles.filter((p) => this.isNoteFile(p));
    const projects = new Map<string, { done: string | null; active: string | null }>();
    const keyOf = (p: string) => join(dirname(p), projectName(p, suffix));
    for (const p of notes) if (isDoneFile(p, suffix)) projects.set(keyOf(p), { done: p, active: null });
    for (const p of notes) {
      if (isDoneFile(p, suffix)) continue;
      const k = keyOf(p);
      if (projects.has(k)) projects.get(k)!.active = p;
      else projects.set(k, { done: null, active: p });
    }
    const entries = [...projects.entries()];
    const paths = entries.flatMap(([, v]) => [v.done, v.active].filter((x): x is string => !!x));
    const texts = await this.readFiles(paths);
    const byPath = new Map(paths.map((p, i) => [p, texts[i]]));
    return entries.map(([k, v]) => ({
      project: relative(this.workspace, k).replace(/\\/g, "/"),
      doneText: v.done ? byPath.get(v.done) ?? null : null,
      activeText: v.active ? byPath.get(v.active) ?? null : null,
    }));
  }

  async generateReport(tag: string | null = null) {
    if (!this.needFolder()) return;
    const y = new Date().getFullYear();
    const choices: { kind: PeriodKind; label: string }[] = [
      { kind: "year", label: `This year (${y})` },
      { kind: "lastYear", label: `Last year (${y - 1})` },
      { kind: "12months", label: "Last 12 months" },
      { kind: "month", label: "This month" },
      { kind: "lastMonth", label: "Last month" },
      { kind: "week", label: "This week" },
      { kind: "lastWeek", label: "Last week" },
      { kind: "all", label: "All time" },
    ];
    openPicker({
      placeholder: tag ? `Report period (${tag})` : "Report period",
      provide: (q) => ({
        items: fuzzyFilter(q, choices, (c) => c.label).map(({ item, result }) => ({
          label: item.label, icon: "chart", positions: result.positions, value: item.kind,
        })),
      }),
      pick: async (it) => {
        const period = periodFor(it.value as PeriodKind);
        const md = buildReport(await this.reportSources(), this.taskCfg, period, new Date(), { tag });
        this.newDoc({ text: md, title: `Activity report — ${period.label}${tag ? ` ${tag}` : ""}.md`, lang: "markdown" });
      },
    });
  }

  /** The report limited to one #tag (a client, a topic…). */
  async generateTagReport() {
    if (!this.needFolder()) return;
    const counts = new Map<string, number>();
    for (const src of await this.reportSources()) {
      for (const text of [src.doneText, src.activeText]) {
        for (const line of text?.split(/\r\n|\r|\n/) ?? []) for (const t of findTags(line)) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    if (!counts.size) {
      toast("No #tag in your notes yet: add one to a task, e.g. \"- call the client #acme - todo\".");
      return;
    }
    const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    openPicker({
      placeholder: "Report for the tag…",
      provide: (q) => ({
        items: fuzzyFilter(q, tags, (t) => t[0]).map(({ item, result }) => ({
          label: item[0], hint: `${item[1]} line${item[1] > 1 ? "s" : ""}`, icon: "chart", positions: result.positions, value: item[0],
        })),
      }),
      pick: (it) => this.generateReport(it.value as string),
    });
  }

  /** Ctrl+Shift+U: sets the due date ("@2026-11-14") of the selected tasks. */
  setDueDate() {
    const doc = this.active;
    if (!doc) return;
    const lines = this.selectedLines(this.view.state).filter((n) => parseTask(this.view.state.doc.line(n).text, this.taskCfg));
    if (!lines.length) {
      toast(`Put the cursor on a task first (${shortcutFor("task.cycle")} turns a line into a task).`);
      return;
    }
    const current = parseTask(this.view.state.doc.line(lines[0]).text, this.taskCfg)?.due ?? null;
    const today = new Date();
    const plus = (days: number) => {
      const d = new Date(today);
      d.setDate(d.getDate() + days);
      return todayISO(d);
    };
    const monday = plus(((8 - today.getDay()) % 7) || 7);
    const endOfMonth = todayISO(new Date(today.getFullYear(), today.getMonth() + 1, 0));
    const presets: { label: string; date: string | null }[] = [
      { label: "Today", date: todayISO(today) },
      { label: "Tomorrow", date: plus(1) },
      { label: "Next Monday", date: monday },
      { label: "In a week", date: plus(7) },
      { label: "In two weeks", date: plus(14) },
      { label: "End of the month", date: endOfMonth },
    ];
    if (current) presets.push({ label: "Remove the due date", date: null });
    openPicker({
      placeholder: "Due date: pick one, or type 2026-11-14, 14/11, +3, 2w…",
      provide: (q) => {
        const typed = q.trim() ? parseDateInput(q) : null;
        const items = typed
          ? [{ label: `Due ${typed}`, icon: "calendar", value: typed }]
          : presets.map((p) => ({ label: p.label, hint: p.date ?? undefined, icon: "calendar", value: p.date }));
        return { items, empty: "Not a date: try 2026-11-14, 14/11, +3 or 2w" };
      },
      pick: (it) => {
        const due = it.value as string | null;
        const state = this.view.state;
        const changes: ChangeSpec[] = [];
        for (const n of lines) {
          const line = state.doc.line(n);
          const edit = setDueInLine(line.text, this.taskCfg, due);
          if (edit) for (const c of edit.changes) changes.push({ from: line.from + c.from, to: line.from + c.to, insert: c.insert });
        }
        if (changes.length) this.applyToDoc(doc, { changes, userEvent: "input.due" });
      },
    });
  }

  // -------------------------------------------------------------------------
  // Palette

  openCommandPalette(query = "") {
    openPicker({
      placeholder: "Command…",
      query,
      provide: (q) => {
        const cmds = this.paletteCommands();
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

  private paletteCommands(): Command[] {
    return [...this.commandList].filter((c) => !c.hidden);
  }

  listCommands(): Command[] {
    return this.paletteCommands();
  }

  /** settings.json back to the template (the current file goes to the local history). */
  async resetSettings() {
    try {
      const { text } = await this.backend.readText(this.settingsPath);
      await this.backend.writeText(join(this.historyDir(), historyName(this.settingsPath, "disk")), text);
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

  openQuickOpen(prefix = "") {
    openPicker({
      placeholder: "File…   ( > commands   : line   @ headings and tasks )",
      query: prefix,
      provide: (q) => {
        if (q.startsWith(">")) return this.provideCommands(q.slice(1));
        if (q.startsWith(":")) {
          const n = parseInt(q.slice(1), 10);
          const total = this.active ? this.view.state.doc.lines : 0;
          return { items: [], empty: this.active ? (n ? `Press Enter to go to line ${Math.min(n, total)} / ${total}` : `Line number (1 – ${total})`) : "No open file" };
        }
        if (q.startsWith("@")) return this.provideSymbols(q.slice(1));
        return this.provideFiles(q);
      },
      pick: (it, q) => {
        if (q.startsWith(">")) return runCommand(it.value as string);
        if (q.startsWith("@")) return this.active && this.reveal(this.active, it.value as number);
        const v = it.value as { doc?: Doc; path?: string };
        if (v.doc) this.activate(v.doc);
        else if (v.path) return this.openFile(v.path);
      },
      submit: (q) => {
        const n = parseInt(q.slice(1), 10);
        if (q.startsWith(":") && n && this.active) {
          this.reveal(this.active, n);
          return true;
        }
        return false;
      },
    });
  }

  private provideCommands(q: string) {
    return {
      items: fuzzyFilter(q, this.paletteCommands(), (c) => c.title).map(({ item, result }) => ({
        label: item.title, hint: shortcutFor(item.id), icon: "command", positions: result.positions, value: item.id,
      })),
      empty: "No matching command",
    };
  }

  private provideSymbols(q: string) {
    if (!this.active) return { items: [], empty: "No open file" };
    const doc = this.view.state.doc;
    const symbols: { label: string; line: number; icon: string; color?: string }[] = [];
    for (let i = 1; i <= doc.lines; i++) {
      const text = doc.line(i).text;
      const h = /^(#{1,6})\s+(.*)$/.exec(text);
      if (h) symbols.push({ label: `${"  ".repeat(h[1].length - 1)}${h[2]}`, line: i, icon: "chevron" });
      else {
        const t = text.length > 4 ? parseTask(text, this.taskCfg) : null;
        if (t) symbols.push({ label: `${t.text}  · ${t.status}`, line: i, icon: "tasks", color: this.taskCfg.statuses[t.key] });
      }
    }
    return {
      items: fuzzyFilter(q, symbols, (s) => s.label).map(({ item, result }) => ({
        label: item.label, icon: item.icon, color: item.color, hint: `L${item.line}`, positions: result.positions, value: item.line,
      })),
      empty: "No heading or task in this note",
    };
  }

  private provideFiles(q: string) {
    const items: { label: string; detail: string; doc?: Doc; path?: string; open: boolean }[] = [];
    const seen = new Set<string>();
    for (const d of this.docs) {
      items.push({ label: this.docName(d), detail: d.path ? relative(this.workspace, dirname(d.path)) || "·" : "unsaved", doc: d, open: true });
      if (d.path) seen.add(d.path);
    }
    for (const p of this.workspaceFiles) {
      if (seen.has(p) || !this.isNoteFile(p)) continue;
      items.push({ label: basename(p), detail: relative(this.workspace, dirname(p)) || "·", path: p, open: false });
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
          icon: isDoneFile(item.label, this.settings.archive_suffix) ? "fileDone" : "file",
          hint: item.open ? "open" : undefined,
          value: { doc: item.doc, path: item.path },
        } satisfies PickItem;
      }),
      empty: this.workspace ? "No matching file" : `Open a folder to search your notes (${shortcutFor("folder.open")})`,
    };
  }

  selectTheme() {
    const original = this.settings.theme;
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
        this.settings.theme = it.value as string;
        this.applySettings();
      },
      cancel: () => {
        this.settings.theme = original;
        this.applySettings();
      },
      pick: (it) => this.updateSetting("theme", it.value),
    });
  }

  selectAccent() {
    const names = Object.keys(PALETTE_LABELS);
    const opts = [{ id: null as string | null, label: "Theme color" }, ...names.map((n) => ({ id: n as string | null, label: PALETTE_LABELS[n] }))];
    const original = this.settings.accent;
    const theme = findTheme(this.settings.theme, this.systemDark.matches);
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
        this.settings.accent = resolve(it.value as string | null);
        this.applySettings();
      },
      cancel: () => {
        this.settings.accent = original;
        this.applySettings();
      },
      pick: (it) => {
        this.settings.accent = original;
        this.applySettings();
        const value = resolve(it.value as string | null);
        return this.updateSetting("accent", value);
      },
    });
  }

  selectMascot() {
    const original = this.settings.mascot;
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
      pick: (it) => this.updateSetting("mascot", it.value),
    });
  }

  // -------------------------------------------------------------------------
  // Files (explorer)

  async createFileIn(dir: string) {
    const r = await prompt({ title: "New note", value: "note.txt", selectStem: true, okLabel: "Create", message: relative(this.workspace, dir) || undefined });
    if (!r?.value) return;
    const name = extname(r.value) ? r.value : `${r.value}.txt`;
    const path = join(dir, name);
    try {
      await this.backend.createFile(path);
    } catch (e) {
      toast(`Could not create: ${e}`, { kind: "error" });
      return;
    }
    await this.refreshWorkspaceFiles();
    this.sidebar.refreshTree();
    await this.openFile(path);
  }

  async createFolderIn(dir: string) {
    const r = await prompt({ title: "New folder", placeholder: "Folder name", okLabel: "Create" });
    if (!r?.value) return;
    try {
      await this.backend.createDir(join(dir, r.value));
      this.sidebar.expand(dir);
      this.sidebar.refreshTree();
    } catch (e) {
      toast(`Could not create: ${e}`, { kind: "error" });
    }
  }

  async renamePath(path: string) {
    const r = await prompt({ title: "Rename", value: basename(path), selectStem: true, okLabel: "Rename" });
    if (!r?.value || r.value === basename(path)) return;
    const target = join(dirname(path), r.value);
    for (const d of this.docs) if (d.dirty && d.path && (samePath(d.path, path) || isInside(d.path, path))) await this.save(d);
    try {
      await this.backend.rename(path, target);
    } catch (e) {
      toast(`Could not rename: ${e}`, { kind: "error" });
      return;
    }
    for (const d of this.docs) {
      if (!d.path) continue;
      if (samePath(d.path, path)) d.path = target;
      else if (isInside(d.path, path)) d.path = target + d.path.slice(path.length);
      else continue;
      d.title = basename(d.path);
      // "notes.txt" renamed "notes.md": the coloring follows.
      const lang = langForPath(d.path);
      if (lang !== d.lang) this.setLang(d, lang);
      const st = await this.backend.stat(d.path);
      if (st) d.mtime = st.mtime;
    }
    if (this.workspace && samePath(this.workspace, path)) this.workspace = target;
    this.emit("docs");
    await this.refreshWorkspaceFiles();
    this.sidebar.refreshTree();
  }

  async trashPath(path: string) {
    const r = await confirm({
      title: `Move "${basename(path)}" to the trash?`,
      message: "You can restore it from the system trash.",
      okLabel: "Move to trash",
      danger: true,
    });
    if (r !== "ok") return;
    try {
      await this.backend.trash(path);
    } catch (e) {
      toast(`Could not delete: ${e}`, { kind: "error" });
      return;
    }
    for (const d of [...this.docs]) if (d.path && (samePath(d.path, path) || isInside(d.path, path))) await this.closeDoc(d, { force: true });
    await this.refreshWorkspaceFiles();
    this.sidebar.refreshTree();
  }

  async copyText(text: string, what = "Path copied") {
    try {
      await navigator.clipboard.writeText(text);
      toast(what, { timeout: 1500 });
    } catch {
      toast("Could not copy", { kind: "error" });
    }
  }

  // -------------------------------------------------------------------------
  // Session

  private sessionTab(d: Doc): SessionTab {
    const state = d === this.active ? this.view.state : d.state;
    const keepContent = this.settings.hot_exit && (d.dirty || !d.path);
    return {
      path: d.path,
      title: d.title,
      color: d.color,
      group: d.groupId,
      content: keepContent ? state.doc.toString() : undefined,
      eol: d.eol,
      cursor: state.selection.main.head,
      scrollTop: d === this.active ? this.view.scrollDOM.scrollTop : 0,
      lang: d.path ? undefined : d.lang,
      mtime: keepContent && d.path ? d.mtime : undefined,
      conflict: d.conflict || undefined,
    };
  }

  private sessionData(): Session {
    const tabs = this.docs.filter((d) => d.path || (this.settings.hot_exit && d.state.doc.length > 0));
    return {
      version: 1,
      workspace: this.workspace,
      recent: this.recent,
      tabs: tabs.map((d) => this.sessionTab(d)),
      active: this.active ? tabs.indexOf(this.active) : -1,
      groups: this.groups,
      sidebar: this.sidebar.sessionState(),
      zen: this.zen,
      preview: [...this.preview.open],
    };
  }

  private sessionReady = false;
  private saveSessionNow() {
    if (!this.sessionReady) return;
    this.saveSessionSoon.cancel();
    void this.backend.writeText(this.sessionPath, JSON.stringify(this.sessionData())).catch(() => {});
  }
  private saveSessionSoon = debounce(() => this.saveSessionNow(), 1000);

  private async readSession(path: string): Promise<Session | null> {
    try {
      return JSON.parse((await this.backend.readText(path)).text) as Session;
    } catch {
      return null;
    }
  }

  /** Labels of the other windows that have a saved session. */
  private async otherSessionLabels(): Promise<string[]> {
    const entries = await this.backend.listDir(this.configDir, true).catch(() => []);
    return entries.map((e) => SESSION_FILE_RE.exec(e.name)?.[1]).filter((l): l is string => !!l);
  }

  /** Reopens the other windows of the last session (desktop app only). */
  private async restoreOtherWindows() {
    if (this.backend.kind !== "tauri") return;
    for (const label of await this.otherSessionLabels()) await this.backend.openWindow([], label).catch(() => {});
  }

  private async restoreSession() {
    let s = await this.readSession(this.sessionPath);
    // The main window was closed while others stayed open: take over one of their sessions.
    if (!s && this.backend.windowLabel === "main") {
      const other = (await this.otherSessionLabels())[0];
      if (other) {
        s = await this.readSession(join(this.configDir, sessionFileName(other)));
        if (s) await this.backend.deleteSession(other).catch(() => {});
      }
    }
    if (s && s.version === 1) {
      this.recent = s.recent ?? [];
      this.groups = (s.groups ?? []).map((g) => ({ ...g }));
      this.sidebar.restore(s.sidebar);
      if (s.workspace && (await this.backend.stat(s.workspace))?.isDir) {
        this.workspace = s.workspace;
        void this.refreshWorkspaceFiles();
      }
      const conflicts: Doc[] = [];
      const docs = await Promise.all(
        (s.tabs ?? []).map(async (t) => {
          if (!t.path) {
            return this.createDoc({ path: null, text: t.content ?? "", savedText: "", title: t.title, lang: isLangId(t.lang) ? t.lang : undefined, color: t.color, groupId: t.group, cursor: t.cursor, scrollTop: t.scrollTop, eol: t.eol });
          }
          try {
            const ft = await this.backend.readText(t.path);
            const d = this.createDoc({
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
            const d = this.createDoc({ path: t.path, text: t.content, savedText: "", eol: t.eol, color: t.color, groupId: t.group });
            d.missing = true;
            return d;
          }
        }),
      );
      this.docs = docs.filter((d): d is Doc => !!d);
      this.groups = this.groups.filter((g) => this.docs.some((d) => d.groupId === g.id));
      for (const d of this.docs) if (d.groupId && !this.groups.some((g) => g.id === d.groupId)) d.groupId = null;
      this.normalizeOrder();
      const activeTab = s.tabs?.[s.active];
      const target = activeTab ? this.docs.find((d) => (activeTab.path ? d.path === activeTab.path : d.title === activeTab.title)) : this.docs[0];
      if (s.zen) this.setZen(true);
      const views: unknown[] = Array.isArray(s.preview) ? s.preview : s.preview ? ["markdown"] : [];
      this.preview.open = new Set(views.filter((v): v is SideKind => v === "markdown" || v === "html" || v === "tree"));
      this.activate(target ?? this.docs[0] ?? null);
      for (const d of conflicts) this.flagConflict(d);
    }
    this.sessionReady = true;
  }

  private async beforeClose(): Promise<boolean> {
    this.sessionReady = true;
    // Other windows stay open: this window's session is dropped, so unsaved
    // drafts would be lost (the last window keeps them when hot_exit is on).
    const others = (await this.backend.windowCount().catch(() => 1)) > 1;
    if (others || !this.settings.hot_exit) {
      const unsaved = this.docs.filter((d) => d.dirty && (!d.path || !this.settings.autosave || d.missing || d.conflict));
      if (unsaved.length) {
        const r = await confirm({
          title: others ? "Close this window?" : "Quit without saving?",
          message: `Unsaved changes will be lost: ${unsaved.map((d) => this.docName(d)).join(", ")}.`,
          okLabel: others ? "Close window" : "Quit",
          danger: true,
        });
        if (r !== "ok") return false;
      }
    }
    const pending: Promise<boolean>[] = [];
    for (const d of this.docs) {
      clearTimeout(d.timer);
      if (d.dirty && d.path && !d.missing && !d.conflict && this.settings.autosave) pending.push(this.save(d, { auto: true }));
    }
    await Promise.all(pending);
    if (others) {
      this.sessionReady = false;
      this.saveSessionSoon.cancel();
      await this.backend.deleteSession(this.backend.windowLabel).catch(() => {});
      return true;
    }
    await this.backend.writeText(this.sessionPath, JSON.stringify(this.sessionData())).catch(() => {});
    return true;
  }

  /**
   * A tab dropped outside the window: into the window under the pointer, or a
   * new window opened there (screen coordinates in CSS pixels).
   */
  async dropTabOutside(doc: Doc, screenX: number, screenY: number) {
    if (!doc.path) {
      toast("Save this note first to move it to another window.", { action: { label: "Save", run: () => void this.saveAs(doc) } });
      return;
    }
    if (doc.dirty && !(await this.save(doc))) return;
    const target = await this.backend.windowAt(screenX, screenY).catch(() => null);
    if (target) await this.backend.sendPaths(target, [doc.path]);
    else await this.backend.openWindow([doc.path], undefined, { x: Math.max(0, screenX - 160), y: Math.max(0, screenY - 16) });
    await this.closeDoc(doc, { force: true });
  }

  /** Moves a saved note to a new window. */
  async moveToNewWindow(doc: Doc) {
    if (!doc.path) {
      toast("Save this note first to move it to another window.", { action: { label: "Save", run: () => void this.saveAs(doc) } });
      return;
    }
    if (doc.dirty && !(await this.save(doc))) return;
    await this.backend.openWindow([doc.path]);
    await this.closeDoc(doc, { force: true });
  }

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

  showAbout() {
    void confirm({
      title: `KiloNote ${__APP_VERSION__}`,
      message: "Notes as light as a kilobyte. A fast editor with todo / ongoing / done tasks, archives and yearly activity reports. Built with Tauri and CodeMirror.",
      okLabel: "Nice!",
      cancelLabel: "Close",
    });
  }

  // -------------------------------------------------------------------------
  // Commands

  private commandList: Command[] = [];

  defaultKeybindings(): Record<string, string> {
    const keys: Record<string, string> = {
      "Mod+N": "file.new",
      "Mod+Shift+N": "window.new",
      "Mod+O": "file.open",
      "Mod+Shift+O": "folder.open",
      "Mod+S": "file.save",
      "Mod+Shift+S": "file.saveAs",
      "Mod+W": "tab.close",
      "Ctrl+F4": "tab.close",
      "Mod+Shift+T": "tab.reopen",
      "Ctrl+Tab": "tab.next",
      "Ctrl+Shift+Tab": "tab.prev",
      "Mod+PageDown": "tab.next",
      "Mod+PageUp": "tab.prev",
      "Mod+P": "palette.files",
      "Mod+Shift+P": "palette.commands",
      F1: "palette.commands",
      "Mod+G": "palette.line",
      "Mod+R": "palette.symbol",
      "Mod+B": "view.sidebar",
      "Mod+Shift+E": "view.files",
      "Mod+Shift+A": "view.tasks",
      "Mod+Shift+F": "view.search",
      "Mod+Enter": "task.cycle",
      "Mod+Shift+Enter": "task.archive",
      "Mod+Shift+D": "file.toggleDone",
      "Mod+Shift+U": "task.due",
      "Mod+,": "settings.open",
      "Mod+=": "view.zoomIn",
      "Mod++": "view.zoomIn",
      "Mod+-": "view.zoomOut",
      "Mod+0": "view.zoomReset",
      F11: "view.fullscreen",
      "Shift+F11": "view.zen",
      "Alt+Z": "view.wrap",
      "Mod+Shift+V": "view.preview",
      "Shift+Alt+F": "edit.format",
      "Mod+?": "help.shortcuts",
    };
    if (this.backend.platform !== "macos") keys["Mod+H"] = "edit.replace";
    for (let i = 1; i <= 9; i++) keys[`Mod+${i}`] = `tab.goto.${i}`;
    return keys;
  }

  private registerStatusCommands() {
    const cmds: Command[] = Object.keys(this.taskCfg.statuses).map((name) => ({
      id: `task.set.${name}`,
      title: `Task: Mark as "${name}"`,
      run: () => this.cycleTasks(name),
    }));
    this.commandList = this.commandList.filter((c) => !c.id.startsWith("task.set."));
    this.commandList.push(...cmds);
    registerCommands(cmds);
  }

  private registerAllCommands() {
    const cmds: Command[] = [
      { id: "file.new", title: "File: New note", run: () => this.newDoc() },
      { id: "window.new", title: "Window: New window", run: () => this.backend.openWindow([]) },
      { id: "window.moveTab", title: "Window: Move tab to new window", run: () => this.active && this.moveToNewWindow(this.active) },
      { id: "file.open", title: "File: Open…", run: async () => { for (const p of await this.backend.pickFiles()) await this.openFile(p); } },
      { id: "folder.open", title: "Folder: Open…", run: () => this.openFolder() },
      { id: "folder.close", title: "Folder: Close", run: () => this.closeFolder() },
      { id: "file.save", title: "File: Save", run: () => this.active && this.save(this.active) },
      { id: "file.saveAs", title: "File: Save as…", run: () => this.active && this.saveAs(this.active) },
      { id: "file.saveAll", title: "File: Save all", run: () => this.saveAll() },
      { id: "file.rename", title: "File: Rename…", run: () => this.active?.path && this.renamePath(this.active.path) },
      { id: "file.reveal", title: "File: Reveal in file manager", run: () => this.active?.path && this.backend.reveal(this.active.path) },
      { id: "file.copyPath", title: "File: Copy path", run: () => this.active?.path && this.copyText(this.active.path) },
      { id: "file.toggleDone", title: "Tasks: Switch between note and its _done archive", run: () => this.toggleDoneFile() },
      { id: "file.reload", title: "File: Reload from disk", run: () => this.active && this.reloadDoc(this.active, true) },
      { id: "file.history", title: "File: Local history (earlier versions)…", run: () => this.showLocalHistory() },
      { id: "tab.close", title: "Tab: Close", run: () => this.active && this.closeDoc(this.active) },
      { id: "tab.closeOthers", title: "Tab: Close others", run: () => this.closeMany(this.docs.filter((d) => d !== this.active)) },
      { id: "tab.closeAll", title: "Tab: Close all", run: () => this.closeMany(this.docs) },
      { id: "tab.reopen", title: "Tab: Reopen last closed", run: () => this.reopenClosed() },
      { id: "tab.list", title: "Tab: List all tabs", run: () => this.tabbar.showTabList() },
      { id: "tab.next", title: "Tab: Next", run: () => this.cycleTab(1) },
      { id: "tab.prev", title: "Tab: Previous", run: () => this.cycleTab(-1) },
      { id: "tab.color", title: "Tab: Color…", run: () => this.active && this.tabbar.showColorMenu(this.active) },
      { id: "tab.group", title: "Tab: Add to new group…", run: () => this.active && this.createGroup([this.active]) },
      { id: "tab.ungroup", title: "Tab: Remove from group", run: () => this.active && this.addToGroup(this.active, null) },
      { id: "tab.toggleGroup", title: "Tab: Collapse or expand its group", run: () => this.toggleActiveGroup() },
      { id: "tab.collapseGroups", title: "Tab: Collapse all groups", run: () => this.setAllGroupsCollapsed(true) },
      { id: "tab.expandGroups", title: "Tab: Expand all groups", run: () => this.setAllGroupsCollapsed(false) },
      { id: "palette.commands", title: "Command palette", run: () => this.openCommandPalette() },
      { id: "palette.files", title: "Go to file…", run: () => this.openQuickOpen() },
      { id: "palette.line", title: "Go to line…", run: () => this.openQuickOpen(":") },
      { id: "palette.symbol", title: "Go to heading or task…", run: () => this.openQuickOpen("@") },
      { id: "edit.find", title: "Edit: Find", run: () => this.active && openSearchPanel(this.view) },
      { id: "edit.replace", title: "Edit: Find and replace", run: () => this.active && openSearchPanel(this.view) },
      { id: "edit.format", title: "Edit: Format document (JSON, XML, HTML, CSS, Markdown tables)", run: () => this.formatDocument() },
      { id: "edit.minify", title: "Edit: Minify JSON", run: () => this.formatDocument("minify") },
      { id: "view.sidebar", title: "View: Toggle sidebar", run: () => this.sidebar.toggle() },
      { id: "view.files", title: "View: File explorer", run: () => this.sidebar.show("files") },
      { id: "view.tasks", title: "View: Folder tasks", run: () => this.sidebar.show("tasks") },
      { id: "view.search", title: "View: Search in files", run: () => this.sidebar.show("search") },
      { id: "view.zen", title: "View: Zen mode", run: () => this.setZen(!this.zen) },
      { id: "view.fullscreen", title: "View: Full screen", run: () => this.backend.toggleFullscreen() },
      { id: "view.zoomIn", title: "View: Increase text size", run: () => this.zoom(1) },
      { id: "view.zoomOut", title: "View: Decrease text size", run: () => this.zoom(-1) },
      { id: "view.zoomReset", title: "View: Reset text size", run: () => this.zoom(null) },
      { id: "view.wrap", title: "View: Toggle word wrap", run: () => this.updateSetting("word_wrap", !this.settings.word_wrap) },
      { id: "view.preview", title: "View: Toggle preview or tree view (Markdown, HTML, SVG, JSON, YAML)", run: () => this.preview.toggle() },
      { id: "view.language", title: "View: Document type (syntax coloring)…", run: () => this.selectLanguage() },
      { id: "view.lineNumbers", title: "View: Toggle line numbers", run: () => this.updateSetting("line_numbers", !this.settings.line_numbers) },
      { id: "theme.select", title: "Theme: Select…", run: () => this.selectTheme() },
      { id: "theme.accent", title: "Theme: Accent color…", run: () => this.selectAccent() },
      { id: "theme.mascot", title: "Theme: Kilo's color…", run: () => this.selectMascot() },
      { id: "settings.open", title: "Preferences: Settings", run: () => this.openSettings() },
      { id: "settings.json", title: "Preferences: Open settings.json", run: () => this.openSettings(true) },
      { id: "task.cycle", title: "Task: Next status", run: () => this.cycleTasks() },
      { id: "task.archive", title: "Task: Archive line to _done", run: () => this.archiveSelection() },
      { id: "task.archiveDone", title: "Task: Archive all completed tasks", run: () => this.archiveAllDone() },
      { id: "report.generate", title: "Report: Generate activity report…", run: () => this.generateReport() },
      { id: "report.tag", title: "Report: Generate activity report for a #tag…", run: () => this.generateTagReport() },
      { id: "task.due", title: "Task: Set due date…", run: () => this.setDueDate() },
      { id: "help.shortcuts", title: "Help: Keyboard shortcuts (cheat sheet)", run: () => showCheatSheet(this) },
      { id: "help.guide", title: "Help: KiloNote guide", run: () => this.newDoc({ text: GUIDE, title: "KiloNote guide.md", lang: "markdown" }) },
      { id: "help.about", title: "Help: About", run: () => this.showAbout() },
    ];
    for (let i = 1; i <= 9; i++) {
      cmds.push({ id: `tab.goto.${i}`, title: `Tab ${i}`, hidden: true, run: () => this.gotoTab(i) });
    }
    this.commandList = cmds;
    registerCommands(cmds);
  }

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
