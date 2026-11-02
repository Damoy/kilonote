// Contrôleur principal : documents, onglets, groupes, session, commandes.

import { ChangeSet, EditorState, Text, type ChangeSpec, type TransactionSpec } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import type { Backend } from "./core/backend";
import { registerCommands, runCommand, setKeybindings, setPlatform, shortcutFor, type Command } from "./core/commands";
import { parseJsonc } from "./core/jsonc";
import {
  basename, dirname, doneFileFor, extname, isDoneFile, isInside, isProbablyBinary, join, projectName, relative, samePath, stem,
} from "./core/path";
import { mergeSettings, setSettingInText, SETTINGS_TEMPLATE, type Settings } from "./core/settings";
import { applyTheme, findTheme, PALETTE_LABELS, THEMES } from "./core/themes";
import { fuzzyFilter } from "./core/fuzzy";
import { editorHooks } from "./editor/decorations";
import { createEditorState, langForPath, reconfigureLanguage, settingsCompartment, settingsExtensions, type LangId } from "./editor/setup";
import {
  archivedLine, cycleLine, findTasks, isDoneStatus, makeTaskConfig, parseTask, todayISO, type TaskConfig,
} from "./editor/tasks";
import { buildReport, periodFor, type ReportSource } from "./report";
import { debounce } from "./ui/dom";
import { confirm, prompt, setFocusRestorer, showMenu, toast, type MenuItem } from "./ui/overlay";
import { openPicker, setPaletteFocusRestorer, type PickItem } from "./ui/palette";
import { TabBar } from "./ui/tabbar";
import { Sidebar } from "./ui/sidebar";
import { StatusBar } from "./ui/statusbar";
import { Welcome } from "./ui/welcome";
import { GUIDE } from "./guide";

export interface Doc {
  id: number;
  path: string | null;
  title: string;
  state: EditorState;
  savedText: Text;
  dirty: boolean;
  eol: "\n" | "\r\n";
  bom: boolean;
  encoding: string;
  mtime: number;
  lang: LangId;
  color: string | null;
  groupId: string | null;
  missing: boolean;
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
}

interface Session {
  version: 1;
  workspace: string | null;
  recent: string[];
  tabs: SessionTab[];
  active: number;
  groups: TabGroup[];
  untitled: number;
  sidebar: { visible: boolean; width: number; panel: string; expanded: string[] };
  zen?: boolean;
}

type AppEvent = "docs" | "active" | "workspace" | "settings" | "saved" | "selection";

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
  configDir = "";
  settingsPath = "";
  sessionPath = "";
  zen = false;
  private nextId = 1;
  private untitledCounter = 0;
  private closed: SessionTab[] = [];
  private listeners = new Map<AppEvent, Set<() => void>>();
  private systemDark = matchMedia("(prefers-color-scheme: dark)");

  constructor(public backend: Backend) {}

  // -------------------------------------------------------------------------
  // Évènements

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
  // Démarrage

  async init() {
    setPlatform(this.backend.platform);
    document.documentElement.dataset.platform = this.backend.platform;
    this.configDir = await this.backend.configDir();
    this.settingsPath = join(this.configDir, "settings.json");
    this.sessionPath = join(this.configDir, "session.json");
    this.settings = mergeSettings(await this.readSettingsFile());
    this.taskCfg = this.makeTaskCfg();

    const host = document.getElementById("editor-host")!;
    this.view = new EditorView({ parent: host, state: this.blankState() });
    this.tabbar = new TabBar(this, document.getElementById("tabbar")!);
    this.sidebar = new Sidebar(this, document.getElementById("sidebar")!, document.getElementById("sb-resizer")!);
    this.statusbar = new StatusBar(this, document.getElementById("statusbar")!);
    this.welcome = new Welcome(this, document.getElementById("welcome")!);

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
    this.backend.onCloseRequested(() => this.beforeClose());

    await this.restoreSession();
    const startup = await this.backend.startupPaths().catch(() => []);
    if (startup.length && this.backend.kind === "tauri") await this.openPaths(startup);
    else if (startup.length && !this.workspace) await this.openFolder(startup[0]);
    this.renderAll();
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
  // Paramètres

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

  /** Modifie une valeur dans settings.json (en gardant les commentaires) puis l'applique. */
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
    (this.settings as unknown as Record<string, unknown>)[key] = value;
    this.applySettings();
    if (open) {
      this.replaceDocContent(open, next);
      this.quietSettings = true;
      await this.save(open).finally(() => (this.quietSettings = false));
    } else {
      await this.backend.writeText(this.settingsPath, next).catch((e) => toast(`Paramètres non enregistrés : ${e}`, { kind: "error" }));
    }
  }

  async openSettings() {
    const exists = await this.backend.stat(this.settingsPath);
    if (!exists) await this.backend.writeText(this.settingsPath, SETTINGS_TEMPLATE);
    await this.openFile(this.settingsPath);
  }

  private quietSettings = false;
  private onSettingsSaved(text: string) {
    try {
      this.settings = mergeSettings(parseJsonc<Partial<Settings>>(text));
      this.applySettings();
      if (!this.quietSettings) toast("Paramètres appliqués", { kind: "success", timeout: 1600 });
    } catch (e) {
      toast(`Erreur dans settings.json : ${(e as Error).message}`, { kind: "error" });
    }
  }

  // -------------------------------------------------------------------------
  // Documents

  private createDoc(init: {
    path: string | null; text: string; savedText?: string; eol?: "\n" | "\r\n"; bom?: boolean; encoding?: string;
    mtime?: number; title?: string; lang?: LangId; color?: string | null; groupId?: string | null; cursor?: number; scrollTop?: number;
  }): Doc {
    const lang = init.lang ?? langForPath(init.path);
    const doc: Doc = {
      id: this.nextId++,
      path: init.path,
      title: init.title ?? (init.path ? basename(init.path) : `Sans titre ${++this.untitledCounter}`),
      state: null as unknown as EditorState,
      savedText: Text.empty,
      dirty: false,
      eol: init.eol ?? this.defaultEol(),
      bom: init.bom ?? false,
      encoding: init.encoding ?? "UTF-8",
      mtime: init.mtime ?? 0,
      lang,
      color: init.color ?? null,
      groupId: init.groupId ?? null,
      missing: false,
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
    return doc;
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

  /** Insère un onglet à droite de l'onglet actif (ou à la fin de son groupe). */
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
      if (isProbablyBinary(path)) {
        await this.backend.openPath(path).catch((e) => toast(`Impossible d'ouvrir : ${e}`, { kind: "error" }));
        return null;
      }
      try {
        const ft = await this.backend.readText(path);
        doc = this.findDoc(path); // ouvert entre-temps ?
        if (!doc) {
          doc = this.createDoc({
            path, text: ft.text, eol: ft.text.includes("\r\n") ? "\r\n" : ft.text.includes("\n") ? "\n" : this.defaultEol(),
            bom: ft.encoding === "UTF-8 BOM", encoding: ft.encoding, mtime: ft.mtime,
          });
          if (!activate) this.docs.push(doc);
          else this.insertDoc(doc);
          this.normalizeOrder();
          this.emit("docs");
        }
      } catch (e) {
        toast(`Impossible d'ouvrir ${basename(path)} : ${e}`, { kind: "error" });
        return null;
      }
    }
    if (activate) this.activate(doc);
    if (opts.line != null || opts.select) this.reveal(doc, opts.line ?? 1, opts.select);
    return doc;
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
      const group = doc.groupId ? this.groups.find((g) => g.id === doc.groupId) : null;
      if (group?.collapsed) group.collapsed = false;
      this.view.setState(doc.state);
      if (doc.scroll) this.view.dispatch({ effects: doc.scroll });
      else if (doc.pendingScrollTop) {
        const top = doc.pendingScrollTop;
        requestAnimationFrame(() => (this.view.scrollDOM.scrollTop = top));
        doc.pendingScrollTop = 0;
      }
      this.view.focus();
    } else {
      this.view.setState(this.blankState());
    }
    this.emit("active");
  }

  /** Met la ligne `line` (1-based) au centre de l'écran, avec une sélection optionnelle (dans la ligne). */
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
    if (u.docChanged) this.afterDocChange(doc);
    if (u.docChanged || u.selectionSet) this.emit("selection");
  }

  private afterDocChange(doc: Doc) {
    const wasDirty = doc.dirty;
    doc.dirty = !doc.state.doc.eq(doc.savedText);
    if (doc.dirty) this.scheduleAutosave(doc);
    if (wasDirty !== doc.dirty) this.emit("docs");
    this.saveSessionSoon();
  }

  /** Applique une transaction à un document, actif ou non. */
  applyToDoc(doc: Doc, spec: TransactionSpec) {
    if (doc === this.active) this.view.dispatch(spec);
    else {
      const tr = doc.state.update(spec);
      doc.state = tr.state;
      if (tr.docChanged) this.afterDocChange(doc);
    }
  }

  /** Remplace le contenu par une modification minimale (le curseur et l'historique sont préservés). */
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
  // Enregistrement

  private scheduleAutosave(doc: Doc) {
    if (!this.settings.autosave || !doc.path || doc.missing) return;
    clearTimeout(doc.timer);
    doc.timer = setTimeout(() => void this.save(doc, { auto: true }), this.settings.autosave_delay);
  }

  flushAutosaves() {
    for (const d of this.docs) {
      if (d.dirty && d.path && !d.missing && this.settings.autosave) {
        clearTimeout(d.timer);
        void this.save(d, { auto: true });
      }
    }
    this.saveSessionNow();
  }

  async save(doc: Doc, opts: { auto?: boolean } = {}): Promise<boolean> {
    if (!doc.path) return opts.auto ? false : this.saveAs(doc);
    if (doc.saving) await doc.saving;
    const run = (async () => {
      const path = doc.path!;
      const snapshot = doc.state.doc;
      // Le fichier a-t-il été modifié par un autre programme depuis son ouverture ?
      const meta = await this.backend.stat(path);
      if (meta && doc.mtime && Math.abs(meta.mtime - doc.mtime) > 1) {
        if (opts.auto) {
          toast(`« ${basename(path)} » a été modifié en dehors de KiloNote.`, {
            kind: "error",
            timeout: 12000,
            action: { label: "Écraser", run: () => { doc.mtime = 0; void this.save(doc); } },
          });
          return false;
        }
        const r = await confirm({
          title: `« ${basename(path)} » a changé sur le disque`,
          message: "Un autre programme a modifié ce fichier. Écraser avec votre version ?",
          okLabel: "Écraser", danger: true, altLabel: "Recharger depuis le disque",
        });
        if (r === "alt") {
          await this.reloadDoc(doc, true);
          return false;
        }
        if (r === "cancel") return false;
      }
      try {
        const text = snapshot.sliceString(0, snapshot.length, doc.eol);
        const written = await this.backend.writeText(path, text, doc.bom);
        doc.mtime = written.mtime;
        doc.savedText = snapshot;
        doc.missing = false;
        const wasDirty = doc.dirty;
        doc.dirty = !doc.state.doc.eq(snapshot);
        if (wasDirty !== doc.dirty) this.emit("docs");
        this.emit("saved");
        if (samePath(path, this.settingsPath)) this.onSettingsSaved(text);
        return true;
      } catch (e) {
        toast(`Échec de l'enregistrement de ${basename(path)} : ${e}`, { kind: "error" });
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
    const other = this.findDoc(target);
    if (other && other !== doc) await this.closeDoc(other, { force: true });
    doc.path = target;
    doc.mtime = 0;
    doc.title = basename(target);
    const lang = langForPath(target, doc.lang);
    if (lang !== doc.lang) {
      doc.lang = lang;
      this.applyToDoc(doc, { effects: [reconfigureLanguage(lang), settingsCompartment.reconfigure(settingsExtensions(this.settings, this.taskCfg, lang))] });
    }
    const ok = await this.save(doc);
    this.emit("docs");
    this.refreshWorkspaceFilesSoon();
    return ok;
  }

  async saveAll() {
    for (const d of this.docs) if (d.dirty && d.path) await this.save(d);
  }

  async reloadDoc(doc: Doc, force = false) {
    if (!doc.path) return;
    if (doc.dirty && !force) return;
    try {
      const ft = await this.backend.readText(doc.path);
      this.replaceDocContent(doc, ft.text);
      doc.savedText = doc.state.doc;
      doc.dirty = false;
      doc.mtime = ft.mtime;
      doc.encoding = ft.encoding;
      doc.missing = false;
      clearTimeout(doc.timer);
      this.emit("docs");
      this.emit("selection");
    } catch (e) {
      toast(`Rechargement impossible : ${e}`, { kind: "error" });
    }
  }

  private checking = false;
  async checkExternalChanges(docs = this.docs) {
    if (this.checking) return;
    this.checking = true;
    try {
      let changed = false;
      for (const doc of docs) {
        if (!doc.path || doc.saving) continue;
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
          else {
            doc.mtime = meta.mtime; // pour ne pas redemander en boucle
            toast(`« ${this.docName(doc)} » a été modifié en dehors de KiloNote.`, {
              kind: "error",
              timeout: 15000,
              action: { label: "Recharger", run: () => void this.reloadDoc(doc, true) },
            });
          }
        }
      }
      if (changed) this.emit("docs");
    } finally {
      this.checking = false;
    }
  }

  // -------------------------------------------------------------------------
  // Fermeture des onglets

  async closeDoc(doc: Doc, opts: { force?: boolean } = {}): Promise<boolean> {
    if (doc.dirty && !opts.force) {
      if (doc.path && this.settings.autosave && !doc.missing) {
        clearTimeout(doc.timer);
        if (!(await this.save(doc))) return false;
      } else {
        if (doc !== this.active) this.activate(doc);
        const r = await confirm({
          title: `Enregistrer « ${this.docName(doc)} » ?`,
          message: "Les modifications seront perdues si vous ne les enregistrez pas.",
          okLabel: "Enregistrer",
          altLabel: "Ne pas enregistrer",
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
  // Groupes d'onglets

  /** Garde les onglets d'un même groupe côte à côte. */
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
      title: "Nouveau groupe d'onglets",
      placeholder: "Nom du groupe (ex. Projet MC)",
      okLabel: "Créer",
      colors: { options: this.settings.tab_colors, selected: color },
    });
    if (!r) return;
    const group: TabGroup = { id: `g${Date.now().toString(36)}`, name: r.value, color: r.color ?? color, collapsed: false };
    this.groups.push(group);
    // Le groupe prend la place du premier onglet concerné.
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
      // Retirer du groupe : l'onglet se place juste après le groupe.
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
      title: "Modifier le groupe",
      value: group.name,
      okLabel: "Enregistrer",
      colors: { options: this.settings.tab_colors, selected: group.color },
    });
    if (!r) return;
    group.name = r.value;
    if (r.color) group.color = r.color;
    this.emit("docs");
  }

  toggleGroup(group: TabGroup) {
    group.collapsed = !group.collapsed;
    if (group.collapsed && this.active?.groupId === group.id) {
      const next = this.docs.find((d) => !this.isHidden(d));
      if (next) this.activate(next);
      else group.collapsed = false;
    }
    this.emit("docs");
  }

  ungroup(group: TabGroup) {
    for (const d of this.docs) if (d.groupId === group.id) d.groupId = null;
    this.cleanGroups();
    this.emit("docs");
  }

  /** Déplace un onglet à l'index `to` (glisser-déposer) et met à jour son groupe. */
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
      /* reste dans son groupe */
    } else doc.groupId = null;
    this.normalizeOrder();
    this.cleanGroups();
    this.emit("docs");
  }

  // -------------------------------------------------------------------------
  // Espace de travail

  async openFolder(path?: string) {
    const dir = path ?? (await this.backend.pickFolder());
    if (!dir) return;
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

  /** Contenu d'un fichier : version en mémoire si l'onglet est ouvert, sinon disque. */
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
  // Tâches

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

  /** Ctrl+Entrée : statut suivant (ou `target`) sur les lignes sélectionnées. */
  cycleTasks(target?: string, doc = this.active, lines?: number[]) {
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
      void this.archiveLines(doc, nowDone);
    }
  }

  /** Déplace des lignes vers le fichier d'archive (<nom>_done.<ext>). */
  async archiveLines(doc: Doc, lineNumbers: number[]) {
    if (!doc.path) {
      toast("Enregistrez d'abord cette note pour pouvoir archiver ses tâches.", {
        action: { label: "Enregistrer", run: () => void this.saveAs(doc) },
      });
      return;
    }
    const suffix = this.settings.archive_suffix;
    if (isDoneFile(doc.path, suffix)) {
      toast("Cette note est déjà un fichier d'archive.");
      return;
    }
    const state = doc === this.active ? this.view.state : doc.state;
    const lines = lineNumbers.map((n) => state.doc.line(n)).filter((l) => l.text.trim());
    if (!lines.length) return;
    const date = todayISO();
    const out = lines.map((l) => archivedLine(l.text, this.taskCfg, date));
    const target = doneFileFor(doc.path, suffix);

    // Suppression des lignes (par blocs contigus, pour ne pas chevaucher).
    const specs: { from: number; to: number }[] = [];
    let i = 0;
    while (i < lines.length) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1].number === lines[j].number + 1) j++;
      const a = lines[i];
      const b = lines[j];
      if (b.number < state.doc.lines) specs.push({ from: a.from, to: b.to + 1 });
      else specs.push({ from: a.number > 1 ? a.from - 1 : a.from, to: b.to });
      i = j + 1;
    }
    const removal = ChangeSet.of(specs, state.doc.length);
    this.applyToDoc(doc, { changes: removal, userEvent: "delete.archive" });
    const after = doc === this.active ? this.view.state : doc.state;

    try {
      await this.appendToFile(target, out);
    } catch (e) {
      const current = doc === this.active ? this.view.state : doc.state;
      if (current === after) this.applyToDoc(doc, { changes: removal.invert(state.doc) });
      toast(`Archivage impossible (${e}). Rien n'a été perdu.`, { kind: "error" });
      return;
    }
    const n = out.length;
    toast(`${n} tâche${n > 1 ? "s" : ""} archivée${n > 1 ? "s" : ""} → ${basename(target)}`, {
      kind: "success",
      action: { label: "Ouvrir", run: () => void this.openFile(target) },
    });
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
      toast("Aucune tâche terminée dans cette note.");
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
      if (!(await this.save(open))) throw new Error("enregistrement de l'archive impossible");
    } else {
      await this.backend.appendLines(path, lines);
    }
  }

  /** Bascule entre mc.txt et mc_done.txt. */
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
      toast(`${basename(target)} n'existe pas encore : il sera créé à la première archive.`);
      return;
    }
    await this.openFile(target);
  }

  showStatusMenu(lineNo: number, x: number, y: number) {
    const doc = this.active;
    if (!doc) return;
    const line = this.view.state.doc.line(lineNo);
    const task = parseTask(line.text, this.taskCfg);
    const items: MenuItem[] = [{ header: "Statut" }];
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
        label: `Archiver dans ${basename(doneFileFor(doc.path, this.settings.archive_suffix))}`,
        icon: "archive",
        shortcut: shortcutFor("task.archive"),
        action: () => this.archiveLines(doc, [lineNo]),
      });
    }
    showMenu(items, x, y);
  }

  // -------------------------------------------------------------------------
  // Bilan

  async generateReport() {
    if (!this.workspace) {
      toast("Ouvrez d'abord le dossier qui contient vos notes.", { action: { label: "Ouvrir un dossier", run: () => void this.openFolder() } });
      return;
    }
    const choices: { kind: "year" | "lastYear" | "12months" | "all"; label: string }[] = [
      { kind: "year", label: `Cette année (${new Date().getFullYear()})` },
      { kind: "lastYear", label: `L'année dernière (${new Date().getFullYear() - 1})` },
      { kind: "12months", label: "Les 12 derniers mois" },
      { kind: "all", label: "Tout l'historique" },
    ];
    openPicker({
      placeholder: "Période du bilan",
      provide: (q) => ({
        items: fuzzyFilter(q, choices, (c) => c.label).map(({ item, result }) => ({
          label: item.label, icon: "chart", positions: result.positions, value: item.kind,
        })),
      }),
      pick: async (it) => {
        await this.refreshWorkspaceFiles();
        const suffix = this.settings.archive_suffix;
        const notes = this.workspaceFiles.filter((p) => this.isNoteFile(p));
        const doneFiles = notes.filter((p) => isDoneFile(p, suffix));
        const projects = new Map<string, { done: string | null; active: string | null }>();
        const keyOf = (p: string) => join(dirname(p), projectName(p, suffix));
        for (const p of doneFiles) projects.set(keyOf(p), { done: p, active: null });
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
        const sources: ReportSource[] = entries.map(([k, v]) => ({
          project: relative(this.workspace, k).replace(/\\/g, "/"),
          doneText: v.done ? byPath.get(v.done) ?? null : null,
          activeText: v.active ? byPath.get(v.active) ?? null : null,
        }));
        const period = periodFor(it.value as "year");
        const md = buildReport(sources, this.taskCfg, period);
        this.newDoc({ text: md, title: `Bilan — ${period.label}.md`, lang: "markdown" });
      },
    });
  }

  // -------------------------------------------------------------------------
  // Palette

  openCommandPalette(query = "") {
    openPicker({
      placeholder: "Commande…",
      query,
      provide: (q) => {
        const cmds = this.paletteCommands();
        return {
          items: fuzzyFilter(q, cmds, (c) => c.title).map(({ item, result }) => ({
            label: item.title, hint: shortcutFor(item.id), icon: "command", positions: result.positions, value: item.id,
          })),
          empty: "Aucune commande",
        };
      },
      pick: (it) => runCommand(it.value as string),
    });
  }

  private paletteCommands(): Command[] {
    return [...this.commandList].filter((c) => !c.hidden);
  }

  openQuickOpen(prefix = "") {
    openPicker({
      placeholder: "Fichier… ( > commandes   : ligne   @ titres et tâches )",
      query: prefix,
      provide: (q) => {
        if (q.startsWith(">")) return this.provideCommands(q.slice(1));
        if (q.startsWith(":")) {
          const n = parseInt(q.slice(1), 10);
          const total = this.active ? this.view.state.doc.lines : 0;
          return { items: [], empty: this.active ? (n ? `Entrée pour aller à la ligne ${Math.min(n, total)} / ${total}` : `Numéro de ligne (1 – ${total})`) : "Aucun fichier ouvert" };
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
      empty: "Aucune commande",
    };
  }

  private provideSymbols(q: string) {
    if (!this.active) return { items: [], empty: "Aucun fichier ouvert" };
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
      empty: "Aucun titre ni tâche dans cette note",
    };
  }

  private provideFiles(q: string) {
    const items: { label: string; detail: string; doc?: Doc; path?: string; open: boolean }[] = [];
    const seen = new Set<string>();
    for (const d of this.docs) {
      items.push({ label: this.docName(d), detail: d.path ? relative(this.workspace, dirname(d.path)) || "·" : "non enregistré", doc: d, open: true });
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
          hint: item.open ? "ouvert" : undefined,
          value: { doc: item.doc, path: item.path },
        } satisfies PickItem;
      }),
      empty: this.workspace ? "Aucun fichier" : "Ouvrez un dossier pour chercher dans vos notes (Ctrl+Maj+O)",
    };
  }

  selectTheme() {
    const original = this.settings.theme;
    const items = [{ id: "auto", label: "Automatique — suit le système" }, ...THEMES.map((t) => ({ id: t.id, label: t.label }))];
    openPicker({
      placeholder: "Thème",
      provide: (q) => ({
        items: fuzzyFilter(q, items, (t) => t.label).map(({ item, result }) => ({
          label: item.label, icon: "palette", positions: result.positions, value: item.id, hint: item.id === original ? "actuel" : undefined,
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
    const opts = [{ id: null as string | null, label: "Couleur du thème" }, ...names.map((n) => ({ id: n as string | null, label: PALETTE_LABELS[n] }))];
    const original = this.settings.accent;
    const theme = findTheme(this.settings.theme, this.systemDark.matches);
    const resolve = (id: string | null) => (id ? (theme.colors as Record<string, string>)[id] ?? null : null);
    openPicker({
      placeholder: "Couleur d'accent",
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

  // -------------------------------------------------------------------------
  // Fichiers (explorateur)

  async createFileIn(dir: string) {
    const r = await prompt({ title: "Nouvelle note", value: "note.txt", selectStem: true, okLabel: "Créer", message: relative(this.workspace, dir) || undefined });
    if (!r?.value) return;
    const name = extname(r.value) ? r.value : `${r.value}.txt`;
    const path = join(dir, name);
    try {
      await this.backend.createFile(path);
    } catch (e) {
      toast(`Création impossible : ${e}`, { kind: "error" });
      return;
    }
    await this.refreshWorkspaceFiles();
    this.sidebar.refreshTree();
    await this.openFile(path);
  }

  async createFolderIn(dir: string) {
    const r = await prompt({ title: "Nouveau dossier", placeholder: "Nom du dossier", okLabel: "Créer" });
    if (!r?.value) return;
    try {
      await this.backend.createDir(join(dir, r.value));
      this.sidebar.expand(dir);
      this.sidebar.refreshTree();
    } catch (e) {
      toast(`Création impossible : ${e}`, { kind: "error" });
    }
  }

  async renamePath(path: string) {
    const r = await prompt({ title: "Renommer", value: basename(path), selectStem: true, okLabel: "Renommer" });
    if (!r?.value || r.value === basename(path)) return;
    const target = join(dirname(path), r.value);
    for (const d of this.docs) if (d.dirty && d.path && (samePath(d.path, path) || isInside(d.path, path))) await this.save(d);
    try {
      await this.backend.rename(path, target);
    } catch (e) {
      toast(`Renommage impossible : ${e}`, { kind: "error" });
      return;
    }
    for (const d of this.docs) {
      if (!d.path) continue;
      if (samePath(d.path, path)) d.path = target;
      else if (isInside(d.path, path)) d.path = target + d.path.slice(path.length);
      else continue;
      d.title = basename(d.path);
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
      title: `Mettre « ${basename(path)} » à la corbeille ?`,
      message: "Vous pourrez le récupérer depuis la corbeille du système.",
      okLabel: "Mettre à la corbeille",
      danger: true,
    });
    if (r !== "ok") return;
    try {
      await this.backend.trash(path);
    } catch (e) {
      toast(`Suppression impossible : ${e}`, { kind: "error" });
      return;
    }
    for (const d of [...this.docs]) if (d.path && (samePath(d.path, path) || isInside(d.path, path))) await this.closeDoc(d, { force: true });
    await this.refreshWorkspaceFiles();
    this.sidebar.refreshTree();
  }

  async copyText(text: string, what = "Chemin copié") {
    try {
      await navigator.clipboard.writeText(text);
      toast(what, { timeout: 1500 });
    } catch {
      toast("Copie impossible", { kind: "error" });
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
      untitled: this.untitledCounter,
      sidebar: this.sidebar.sessionState(),
      zen: this.zen,
    };
  }

  private sessionReady = false;
  private saveSessionNow() {
    if (!this.sessionReady) return;
    this.saveSessionSoon.cancel();
    void this.backend.writeText(this.sessionPath, JSON.stringify(this.sessionData())).catch(() => {});
  }
  private saveSessionSoon = debounce(() => this.saveSessionNow(), 1000);

  private async restoreSession() {
    let s: Session | null = null;
    try {
      s = JSON.parse((await this.backend.readText(this.sessionPath)).text) as Session;
    } catch {
      s = null;
    }
    if (s && s.version === 1) {
      this.recent = s.recent ?? [];
      this.groups = (s.groups ?? []).map((g) => ({ ...g }));
      this.untitledCounter = s.untitled ?? 0;
      this.sidebar.restore(s.sidebar);
      if (s.workspace && (await this.backend.stat(s.workspace))?.isDir) {
        this.workspace = s.workspace;
        void this.refreshWorkspaceFiles();
      }
      const docs = await Promise.all(
        (s.tabs ?? []).map(async (t) => {
          if (!t.path) {
            return this.createDoc({ path: null, text: t.content ?? "", savedText: "", title: t.title, lang: t.lang, color: t.color, groupId: t.group, cursor: t.cursor, scrollTop: t.scrollTop, eol: t.eol });
          }
          try {
            const ft = await this.backend.readText(t.path);
            return this.createDoc({
              path: t.path, text: t.content ?? ft.text, savedText: ft.text, eol: t.eol, bom: ft.encoding === "UTF-8 BOM",
              encoding: ft.encoding, mtime: ft.mtime, color: t.color, groupId: t.group, cursor: t.cursor, scrollTop: t.scrollTop,
            });
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
      this.activate(target ?? this.docs[0] ?? null);
    }
    this.sessionReady = true;
  }

  private async beforeClose(): Promise<boolean> {
    this.sessionReady = true;
    if (!this.settings.hot_exit) {
      const unsaved = this.docs.filter((d) => d.dirty && (!d.path || !this.settings.autosave || d.missing));
      if (unsaved.length) {
        const r = await confirm({
          title: "Quitter sans enregistrer ?",
          message: `Modifications non enregistrées : ${unsaved.map((d) => this.docName(d)).join(", ")}.`,
          okLabel: "Quitter",
          danger: true,
        });
        if (r !== "ok") return false;
      }
    }
    const pending: Promise<boolean>[] = [];
    for (const d of this.docs) {
      clearTimeout(d.timer);
      if (d.dirty && d.path && !d.missing && this.settings.autosave) pending.push(this.save(d, { auto: true }));
    }
    await Promise.all(pending);
    await this.backend.writeText(this.sessionPath, JSON.stringify(this.sessionData())).catch(() => {});
    return true;
  }

  // -------------------------------------------------------------------------
  // Affichage

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

  showAbout() {
    void confirm({
      title: "KiloNote 0.1.0",
      message: "Des notes légères comme un kilooctet. Éditeur rapide, tâches todo / ongoing / done, archives et bilan annuel. Fait avec Tauri et CodeMirror.",
      okLabel: "Super !",
      cancelLabel: "Fermer",
    });
  }

  // -------------------------------------------------------------------------
  // Commandes

  private commandList: Command[] = [];

  defaultKeybindings(): Record<string, string> {
    const keys: Record<string, string> = {
      "Mod+N": "file.new",
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
      "Mod+,": "settings.open",
      "Mod+=": "view.zoomIn",
      "Mod++": "view.zoomIn",
      "Mod+-": "view.zoomOut",
      "Mod+0": "view.zoomReset",
      F11: "view.fullscreen",
      "Shift+F11": "view.zen",
      "Alt+Z": "view.wrap",
    };
    if (this.backend.platform !== "macos") keys["Mod+H"] = "edit.replace";
    for (let i = 1; i <= 9; i++) keys[`Mod+${i}`] = `tab.goto.${i}`;
    return keys;
  }

  private registerStatusCommands() {
    const cmds: Command[] = Object.keys(this.taskCfg.statuses).map((name) => ({
      id: `task.set.${name}`,
      title: `Tâche : marquer « ${name} »`,
      run: () => this.cycleTasks(name),
    }));
    this.commandList = this.commandList.filter((c) => !c.id.startsWith("task.set."));
    this.commandList.push(...cmds);
    registerCommands(cmds);
  }

  private registerAllCommands() {
    const cmds: Command[] = [
      { id: "file.new", title: "Fichier : nouvelle note", run: () => this.newDoc() },
      { id: "file.open", title: "Fichier : ouvrir…", run: async () => { for (const p of await this.backend.pickFiles()) await this.openFile(p); } },
      { id: "folder.open", title: "Dossier : ouvrir…", run: () => this.openFolder() },
      { id: "folder.close", title: "Dossier : fermer", run: () => this.closeFolder() },
      { id: "file.save", title: "Fichier : enregistrer", run: () => this.active && this.save(this.active) },
      { id: "file.saveAs", title: "Fichier : enregistrer sous…", run: () => this.active && this.saveAs(this.active) },
      { id: "file.saveAll", title: "Fichier : tout enregistrer", run: () => this.saveAll() },
      { id: "file.rename", title: "Fichier : renommer…", run: () => this.active?.path && this.renamePath(this.active.path) },
      { id: "file.reveal", title: "Fichier : afficher dans l'explorateur du système", run: () => this.active?.path && this.backend.reveal(this.active.path) },
      { id: "file.copyPath", title: "Fichier : copier le chemin", run: () => this.active?.path && this.copyText(this.active.path) },
      { id: "file.toggleDone", title: "Tâches : basculer entre la note et son archive (_done)", run: () => this.toggleDoneFile() },
      { id: "file.reload", title: "Fichier : recharger depuis le disque", run: () => this.active && this.reloadDoc(this.active, true) },
      { id: "tab.close", title: "Onglet : fermer", run: () => this.active && this.closeDoc(this.active) },
      { id: "tab.closeOthers", title: "Onglet : fermer les autres", run: () => this.closeMany(this.docs.filter((d) => d !== this.active)) },
      { id: "tab.closeAll", title: "Onglet : tout fermer", run: () => this.closeMany(this.docs) },
      { id: "tab.reopen", title: "Onglet : rouvrir le dernier fermé", run: () => this.reopenClosed() },
      { id: "tab.next", title: "Onglet : suivant", run: () => this.cycleTab(1) },
      { id: "tab.prev", title: "Onglet : précédent", run: () => this.cycleTab(-1) },
      { id: "tab.color", title: "Onglet : couleur…", run: () => this.active && this.tabbar.showColorMenu(this.active) },
      { id: "tab.group", title: "Onglet : ajouter à un nouveau groupe…", run: () => this.active && this.createGroup([this.active]) },
      { id: "tab.ungroup", title: "Onglet : retirer du groupe", run: () => this.active && this.addToGroup(this.active, null) },
      { id: "palette.commands", title: "Palette de commandes", run: () => this.openCommandPalette() },
      { id: "palette.files", title: "Aller au fichier…", run: () => this.openQuickOpen() },
      { id: "palette.line", title: "Aller à la ligne…", run: () => this.openQuickOpen(":") },
      { id: "palette.symbol", title: "Aller à un titre ou une tâche…", run: () => this.openQuickOpen("@") },
      { id: "edit.find", title: "Édition : rechercher", run: () => this.active && openSearchPanel(this.view) },
      { id: "edit.replace", title: "Édition : rechercher et remplacer", run: () => this.active && openSearchPanel(this.view) },
      { id: "view.sidebar", title: "Affichage : barre latérale", run: () => this.sidebar.toggle() },
      { id: "view.files", title: "Affichage : explorateur de fichiers", run: () => this.sidebar.show("files") },
      { id: "view.tasks", title: "Affichage : tâches du dossier", run: () => this.sidebar.show("tasks") },
      { id: "view.search", title: "Affichage : rechercher dans les fichiers", run: () => this.sidebar.show("search") },
      { id: "view.zen", title: "Affichage : mode zen", run: () => this.setZen(!this.zen) },
      { id: "view.fullscreen", title: "Affichage : plein écran", run: () => this.backend.toggleFullscreen() },
      { id: "view.zoomIn", title: "Affichage : agrandir le texte", run: () => this.zoom(1) },
      { id: "view.zoomOut", title: "Affichage : réduire le texte", run: () => this.zoom(-1) },
      { id: "view.zoomReset", title: "Affichage : taille de texte par défaut", run: () => this.zoom(null) },
      { id: "view.wrap", title: "Affichage : retour à la ligne automatique", run: () => this.updateSetting("word_wrap", !this.settings.word_wrap) },
      { id: "view.lineNumbers", title: "Affichage : numéros de ligne", run: () => this.updateSetting("line_numbers", !this.settings.line_numbers) },
      { id: "theme.select", title: "Thème : choisir…", run: () => this.selectTheme() },
      { id: "theme.accent", title: "Thème : couleur d'accent…", run: () => this.selectAccent() },
      { id: "settings.open", title: "Préférences : paramètres", run: () => this.openSettings() },
      { id: "task.cycle", title: "Tâche : statut suivant", run: () => this.cycleTasks() },
      { id: "task.archive", title: "Tâche : archiver la ligne dans _done", run: () => this.archiveSelection() },
      { id: "task.archiveDone", title: "Tâche : archiver toutes les tâches terminées", run: () => this.archiveAllDone() },
      { id: "report.generate", title: "Bilan : générer le bilan d'activité…", run: () => this.generateReport() },
      { id: "help.guide", title: "Aide : guide de KiloNote", run: () => this.newDoc({ text: GUIDE, title: "Guide KiloNote.md", lang: "markdown" }) },
      { id: "help.about", title: "Aide : à propos", run: () => this.showAbout() },
    ];
    for (let i = 1; i <= 9; i++) {
      cmds.push({ id: `tab.goto.${i}`, title: `Onglet ${i}`, hidden: true, run: () => this.gotoTab(i) });
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
