// Sidebar: file explorer, folder-wide task view, search in files.

import type { App } from "../app/app";
import { shortcutFor, titleWithKey } from "../core/commands";
import type { Entry } from "../core/backend";
import { basename, dirname, isDoneFile, isInside, projectName, relative, samePath } from "../core/path";
import { resolveColor } from "../core/themes";
import { fileKindFor } from "../editor/languages";
import { dueState, findTags, findTasks, isDoneStatus, isOngoingStatus, todayISO, type FoundTask, type TaskConfig } from "../text/tasks";
import { debounce, h, icon } from "./dom";
import { confirm, showMenu, toast, type MenuItem } from "./overlay";
import { copyText, createFileIn, createFolderIn, renamePath, trashPath } from "../app/files";
import { replaceInFiles } from "../app/history";
import { changeTaskInNote, generateReport } from "../app/tasks";
import { openBoard } from "./lazy";
import { pinnedNotes, setPinned } from "../app/pins";

export type Panel = "files" | "tasks" | "search";

/** "2026-11-14" → "Nov 14" (with the year when it is not the current one). */
function shortDate(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}
type TaskFilter = "open" | "ongoing" | "due" | "all";

/** Icon of a file in the explorer, and its type class (colored by some icon packs). */
export function fileIcon(path: string, archiveSuffix: string): [string, string] {
  if (isDoneFile(path, archiveSuffix)) return ["fileDone", "ft-done"];
  const kind = fileKindFor(path);
  const name = { markdown: "fileMd", json: "fileJson", code: "fileCode", config: "fileCode", markup: "fileCode", diagram: "fileDiagram", image: "fileImage", video: "fileVideo", binary: "fileBin", text: "file" }[kind];
  return [name, `ft-${kind}`];
}

/** "Expand all" stops after this many folders (huge trees stay usable). */
const EXPAND_LIMIT = 300;

export class Sidebar {
  visible = true;
  width = 260;
  panel: Panel = "files";
  private expanded = new Set<string>();
  private toggleAllBtn = h("button", { class: "kn-icon-btn sb-toggle-all" });
  private cache = new Map<string, Entry[]>();
  private panels: Record<Panel, HTMLElement>;
  private switchBtns: Record<Panel, HTMLElement>;
  private taskBadge = h("span", { class: "sb-badge" });
  private treeEl = h("div", { class: "sb-tree" });
  private pinsEl = h("div", { class: "sb-pins" });
  private filesHeader = h("div", { class: "sb-header" });
  private tasksList = h("div", { class: "sb-list" });
  private taskFilter: TaskFilter = "open";
  private taskTag: string | null = null;
  private tagChip = h("button", { class: "sb-chip sb-tag-chip", title: "Filter by #tag" });
  private lastTags = new Map<string, number>();
  private searchInput = h("input", { class: "kn-input sb-search-input", type: "text", placeholder: "Search in folder…", spellcheck: "false" });
  private searchResults = h("div", { class: "sb-list" });
  private replaceInput = h("input", { class: "kn-input sb-search-input", type: "text", placeholder: "Replace with…", spellcheck: "false" });
  private replaceRow = h("div", { class: "sb-search-box sb-replace-box" });
  /** Files with matches in the last search. */
  private hitFiles: { path: string; count: number }[] = [];
  private searchCase = false;
  private searchRegex = false;
  private treeRender = 0;

  constructor(private app: App, el: HTMLElement, resizer: HTMLElement) {
    const mk = (p: Panel, ic: string, title: string, extra?: HTMLElement) => {
      const b = h("button", { class: "sb-switch-btn", title, onclick: () => this.show(p, true) }, icon(ic), extra ?? null);
      return b;
    };
    this.switchBtns = {
      files: mk("files", "files", titleWithKey("Explorer", "view.files")),
      tasks: mk("tasks", "tasks", titleWithKey("Folder tasks", "view.tasks"), this.taskBadge),
      search: mk("search", "search", titleWithKey("Search in files", "view.search")),
    };
    const hideBtn = h("button", { class: "kn-icon-btn sb-hide", title: titleWithKey("Hide sidebar", "view.sidebar"), onclick: () => this.toggle() }, icon("panelClose"));
    const switcher = h("div", { class: "sb-switch" }, this.switchBtns.files, this.switchBtns.tasks, this.switchBtns.search, h("span", { class: "kn-spacer" }), hideBtn);

    const filesPanel = h("div", { class: "sb-panel" }, this.filesHeader, this.pinsEl, this.treeEl);
    this.treeEl.addEventListener("contextmenu", (e) => {
      if (e.target !== this.treeEl || !app.workspace) return;
      e.preventDefault();
      this.showDirMenu(app.workspace, e.clientX, e.clientY, true);
    });
    this.toggleAllBtn.addEventListener("click", () => void this.toggleAll());

    const filterBar = h("div", { class: "sb-chips" });
    const filters: [TaskFilter, string][] = [["open", "Open"], ["ongoing", "Ongoing"], ["due", "Due"], ["all", "All"]];
    for (const [f, label] of filters) {
      filterBar.append(
        h("button", {
          class: `sb-chip${f === this.taskFilter ? " active" : ""}`,
          onclick: (e: Event) => {
            this.taskFilter = f;
            filterBar.querySelectorAll(".sb-chip").forEach((c) => c.classList.toggle("active", c === e.currentTarget));
            void this.renderTasks(false);
          },
        }, label),
      );
    }
    this.tagChip.addEventListener("click", (e) => this.tagMenu(e));
    filterBar.append(this.tagChip);
    this.renderTagChip();
    const tasksPanel = h(
      "div",
      { class: "sb-panel" },
      h("div", { class: "sb-header" }, h("span", { class: "sb-title" }, "Tasks"), h("span", { class: "kn-spacer" }),
        h("button", { class: "kn-icon-btn", title: titleWithKey("Task board", "view.board"), onclick: () => void openBoard(app) }, icon("board")),
        h("button", { class: "kn-icon-btn", title: "Activity report", onclick: () => generateReport(app) }, icon("chart")),
        h("button", { class: "kn-icon-btn", title: "Refresh", onclick: () => this.renderTasks() }, icon("refresh"))),
      filterBar,
      this.tasksList,
    );

    const caseBtn = h("button", { class: "sb-toggle", title: "Match case" }, "Aa");
    const reBtn = h("button", { class: "sb-toggle", title: "Regular expression" }, ".*");
    caseBtn.addEventListener("click", () => {
      this.searchCase = !this.searchCase;
      caseBtn.classList.toggle("active", this.searchCase);
      void this.runSearch();
    });
    reBtn.addEventListener("click", () => {
      this.searchRegex = !this.searchRegex;
      reBtn.classList.toggle("active", this.searchRegex);
      void this.runSearch();
    });
    const replaceToggle = h("button", { class: "kn-icon-btn", title: "Replace in files" }, icon("replace"));
    replaceToggle.addEventListener("click", () => {
      this.replaceRow.hidden = !this.replaceRow.hidden;
      replaceToggle.classList.toggle("active", !this.replaceRow.hidden);
      if (!this.replaceRow.hidden) this.replaceInput.focus();
      if (this.searchInput.value) void this.runSearch(); // shows the per-file buttons
    });
    this.replaceRow.hidden = true;
    this.replaceRow.append(
      this.replaceInput,
      h("button", { class: "kn-btn sb-replace-all", title: "Replace every match of the folder", onclick: () => this.replaceAll() }, "All"),
    );
    this.replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        // Without this, the same key press would also click the dialog's focused button.
        e.preventDefault();
        void this.replaceAll();
      }
      if (e.key === "Escape") app.focusEditor();
    });
    const searchPanel = h(
      "div",
      { class: "sb-panel" },
      h("div", { class: "sb-header" }, h("span", { class: "sb-title" }, "Search"), h("span", { class: "kn-spacer" }), replaceToggle),
      h("div", { class: "sb-search-box" }, this.searchInput, caseBtn, reBtn),
      this.replaceRow,
      this.searchResults,
    );
    const searchSoon = debounce(() => void this.runSearch(), 220);
    this.searchInput.addEventListener("input", searchSoon);
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.runSearch();
      if (e.key === "Escape") app.focusEditor();
    });

    this.panels = { files: filesPanel, tasks: tasksPanel, search: searchPanel };
    el.append(switcher, filesPanel, tasksPanel, searchPanel);
    this.setupResizer(resizer);

    const tasksSoon = debounce(() => void this.renderTasks(true), 350);
    const tasksQuick = debounce(() => void this.renderTasks(false), 350);
    let lastFiles: string[] = [];
    app.on("workspace", () => {
      this.renderFilesHeader();
      // The file list was re-read (file created, archived, renamed…):
      // drop the cached folders and rescan the tasks.
      if (app.workspaceFiles !== lastFiles) {
        lastFiles = app.workspaceFiles;
        this.cache.clear();
        tasksSoon();
      }
      this.renderPins();
      void this.renderTree();
    });
    app.on("pins", () => {
      this.renderPins();
      void this.renderTree();
    });
    app.on("saved", tasksQuick);
    app.on("active", () => this.markActive());
    app.on("settings", () => {
      this.cache.clear();
      void this.renderTree();
      tasksSoon();
    });
    this.applyLayout();
  }

  // ---------------------------------------------------------------------------
  // Disposition

  sessionState() {
    return { visible: this.visible, width: this.width, panel: this.panel, expanded: [...this.expanded] };
  }

  restore(s?: { visible: boolean; width: number; panel: string; expanded: string[] }) {
    if (!s) return;
    this.visible = s.visible ?? true;
    this.width = s.width || 260;
    this.panel = (["files", "tasks", "search"].includes(s.panel) ? s.panel : "files") as Panel;
    this.expanded = new Set(s.expanded ?? []);
    this.applyLayout();
  }

  private applyLayout() {
    const app = document.getElementById("app")!;
    app.classList.toggle("no-sidebar", !this.visible);
    app.style.setProperty("--sb-width", `${this.width}px`);
    for (const p of Object.keys(this.panels) as Panel[]) {
      this.panels[p].hidden = p !== this.panel;
      this.switchBtns[p].classList.toggle("active", p === this.panel);
    }
  }

  toggle() {
    this.visible = !this.visible;
    this.applyLayout();
    this.app.emit("workspace");
    if (!this.visible) this.app.focusEditor();
  }

  show(panel: Panel, fromClick = false) {
    if (this.visible && this.panel === panel && !fromClick) {
      // Shortcut pressed twice: go back to the editor.
      if (panel === "search" && document.activeElement !== this.searchInput) this.focusSearch();
      else this.app.focusEditor();
      return;
    }
    this.visible = true;
    this.panel = panel;
    this.applyLayout();
    if (panel === "tasks") void this.renderTasks(false);
    if (panel === "search") this.focusSearch();
    this.app.emit("workspace");
  }

  private focusSearch() {
    const sel = this.app.active ? this.app.view.state.sliceDoc(this.app.view.state.selection.main.from, this.app.view.state.selection.main.to) : "";
    if (sel && !sel.includes("\n")) {
      this.searchInput.value = sel;
      void this.runSearch();
    }
    this.searchInput.focus();
    this.searchInput.select();
  }

  private setupResizer(resizer: HTMLElement) {
    resizer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing");
      const move = (ev: PointerEvent) => {
        this.width = Math.max(170, Math.min(600, ev.clientX));
        document.getElementById("app")!.style.setProperty("--sb-width", `${this.width}px`);
      };
      const up = () => {
        resizer.removeEventListener("pointermove", move);
        resizer.removeEventListener("pointerup", up);
        document.body.classList.remove("resizing");
        this.app.emit("workspace");
      };
      resizer.addEventListener("pointermove", move);
      resizer.addEventListener("pointerup", up);
    });
    resizer.addEventListener("dblclick", () => {
      this.width = 260;
      this.applyLayout();
    });
  }

  // ---------------------------------------------------------------------------
  // File explorer

  private renderFilesHeader() {
    const app = this.app;
    this.filesHeader.replaceChildren(
      h("span", { class: "sb-title", title: app.workspace ?? "" }, app.workspace ? basename(app.workspace) : "Explorer"),
      h("span", { class: "kn-spacer" }),
    );
    if (app.workspace) {
      const ws = app.workspace;
      this.filesHeader.append(
        h("button", { class: "kn-icon-btn", title: "New note", onclick: () => createFileIn(app, ws) }, icon("newFile")),
        h("button", { class: "kn-icon-btn", title: "New folder", onclick: () => createFolderIn(app, ws) }, icon("newFolder")),
        h("button", { class: "kn-icon-btn", title: "Refresh", onclick: () => this.refreshTree() }, icon("refresh")),
        this.toggleAllBtn,
        h("button", { class: "kn-icon-btn", title: "Close folder", onclick: () => app.closeFolder() }, icon("x")),
      );
    }
  }

  expand(dir: string) {
    this.expanded.add(dir);
  }

  refreshTree() {
    this.cache.clear();
    void this.renderTree();
  }

  private async list(dir: string): Promise<Entry[]> {
    let entries = this.cache.get(dir);
    if (!entries) {
      try {
        entries = await this.app.backend.listDir(dir, this.app.settings.show_hidden_files);
      } catch {
        entries = [];
      }
      this.cache.set(dir, entries);
    }
    return entries;
  }

  async renderTree() {
    const app = this.app;
    const token = ++this.treeRender;
    if (!app.workspace) {
      const recent = app.recent.slice(0, 6);
      this.treeEl.replaceChildren(
        h("div", { class: "sb-empty" },
          h("p", {}, "No folder open."),
          h("button", { class: "kn-btn primary", onclick: () => app.openFolder() }, "Open folder"),
          recent.length ? h("div", { class: "sb-recent-title" }, "Recent") : null,
          ...recent.map((r) => h("button", { class: "sb-recent", title: r, onclick: () => app.openFolder(r) }, icon("folder"), h("span", {}, basename(r)))),
        ),
      );
      return;
    }
    const frag = document.createDocumentFragment();
    await this.renderDir(app.workspace, 0, frag);
    if (token !== this.treeRender) return;
    this.treeEl.replaceChildren(frag);
    this.markActive();
  }

  private async renderDir(dir: string, depth: number, out: DocumentFragment) {
    const entries = await this.list(dir);
    const suffix = this.app.settings.archive_suffix;
    const pins = pinnedNotes();
    // Children of expanded folders are loaded in parallel.
    await Promise.all(entries.filter((e) => e.isDir && this.expanded.has(e.path)).map((e) => this.list(e.path)));
    for (const e of entries) {
      const open = e.isDir && this.expanded.has(e.path);
      const done = !e.isDir && isDoneFile(e.path, suffix);
      const [ic, kind] = e.isDir ? [open ? "folderOpen" : "folder", "ft-dir"] : fileIcon(e.path, suffix);
      const row = h(
        "div",
        { class: `sb-row${e.isDir ? " dir" : ""}${done ? " done" : ""}`, style: { paddingLeft: `${10 + depth * 14}px` }, title: e.path, "data-path": e.path },
        e.isDir ? icon("chevron", `sb-chevron${open ? " open" : ""}`) : h("span", { class: "sb-chevron-space" }),
        icon(ic, `sb-file-icon ${kind}`),
        h("span", { class: "sb-name" }, e.name),
        !e.isDir && pins.some((p) => samePath(p, e.path)) ? icon("pin", "sb-pin-mark") : null,
      );
      if (e.isDir) {
        // Shown on hover: everything inside this folder, expanded or collapsed.
        const all = h("button", { class: "kn-icon-btn sb-row-action", tabindex: "-1" });
        row.append(all);
        row.addEventListener("mouseenter", () => {
          const expand = this.canExpandMore(e.path);
          all.title = expand ? "Expand everything inside (Alt+click)" : "Collapse this folder";
          all.replaceChildren(icon(expand ? "expand" : "collapse"));
        });
        all.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void (this.canExpandMore(e.path) ? this.expandAll(e.path) : this.collapseAll(e.path));
        });
      }
      row.addEventListener("click", (ev) => {
        if (e.isDir) {
          // Alt+click: the folder and everything inside it.
          if (ev.altKey) void (this.canExpandMore(e.path) ? this.expandAll(e.path) : this.collapseAll(e.path));
          else {
            if (open) this.expanded.delete(e.path);
            else this.expanded.add(e.path);
            void this.renderTree();
            this.app.emit("workspace");
          }
        } else void this.app.openFile(e.path);
      });
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        if (e.isDir) this.showDirMenu(e.path, ev.clientX, ev.clientY);
        else this.showFileMenu(e.path, ev.clientX, ev.clientY);
      });
      out.append(row);
      if (open) await this.renderDir(e.path, depth + 1, out);
    }
  }

  /** The pinned notes, above the tree (they can be in any folder). */
  private renderPins() {
    const app = this.app;
    const pins = pinnedNotes();
    this.pinsEl.hidden = !pins.length;
    if (!pins.length) {
      this.pinsEl.replaceChildren();
      return;
    }
    this.pinsEl.replaceChildren(
      h("div", { class: "sb-pins-title" }, "Pinned"),
      ...pins.map((p) => {
        const where = app.workspace && isInside(p, app.workspace) ? relative(app.workspace, dirname(p)) : basename(dirname(p));
        const unpin = h("button", { class: "kn-icon-btn sb-row-action", title: "Unpin", tabindex: "-1" }, icon("x"));
        unpin.addEventListener("click", (ev) => {
          ev.stopPropagation();
          setPinned(p, false);
        });
        const row = h(
          "div",
          { class: "sb-row sb-pin", title: p, "data-path": p },
          icon("pin", "sb-file-icon sb-pin-icon"),
          h("span", { class: "sb-name" }, basename(p)),
          where ? h("span", { class: "sb-pin-where" }, where) : null,
          unpin,
        );
        row.addEventListener("click", () => void app.openFile(p));
        row.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          this.showFileMenu(p, ev.clientX, ev.clientY);
        });
        return row;
      }),
    );
    this.markActive();
  }

  private markActive() {
    const p = this.app.active?.path;
    this.pinsEl.querySelectorAll<HTMLElement>(".sb-row").forEach((r) => {
      r.classList.toggle("active", !!p && samePath(r.dataset.path!, p));
    });
    this.treeEl.querySelectorAll<HTMLElement>(".sb-row").forEach((r) => {
      r.classList.toggle("active", !!p && samePath(r.dataset.path!, p));
    });
    this.updateToggleAll();
  }

  // ---------------------------------------------------------------------------
  // Expand / collapse all

  /** A folder (or one inside it) is still closed. */
  private canExpandMore(dir: string): boolean {
    const isRoot = !!this.app.workspace && samePath(dir, this.app.workspace);
    if (!isRoot && !this.expanded.has(dir)) return true;
    for (const r of this.treeEl.querySelectorAll<HTMLElement>(".sb-row.dir")) {
      const p = r.dataset.path!;
      if (isInside(p, dir) && !this.expanded.has(p)) return true;
    }
    return false;
  }

  /** Some folder of the tree is open. */
  private anyOpen(): boolean {
    for (const r of this.treeEl.querySelectorAll<HTMLElement>(".sb-row.dir")) if (this.expanded.has(r.dataset.path!)) return true;
    return false;
  }

  /** The header button: "Collapse all" as soon as a folder is open, otherwise "Expand all". */
  private updateToggleAll() {
    const collapse = this.anyOpen();
    this.toggleAllBtn.title = collapse ? "Collapse all folders" : "Expand all folders";
    if (this.toggleAllBtn.dataset.mode !== (collapse ? "collapse" : "expand")) {
      this.toggleAllBtn.dataset.mode = collapse ? "collapse" : "expand";
      this.toggleAllBtn.replaceChildren(icon(collapse ? "collapse" : "expand"));
    }
  }

  async toggleAll() {
    const ws = this.app.workspace;
    if (!ws) return;
    if (this.anyOpen()) this.collapseAll(ws);
    else await this.expandAll(ws);
  }

  /** Opens a folder and all its subfolders (up to EXPAND_LIMIT folders). */
  async expandAll(dir: string) {
    const ws = this.app.workspace;
    if (!ws) return;
    let level = [dir];
    let count = 0;
    if (!samePath(dir, ws)) this.expanded.add(dir);
    while (level.length && count < EXPAND_LIMIT) {
      const lists = await Promise.all(level.map((d) => this.list(d)));
      const next: string[] = [];
      for (const entries of lists) {
        for (const e of entries) {
          if (!e.isDir || count >= EXPAND_LIMIT) continue;
          this.expanded.add(e.path);
          next.push(e.path);
          count++;
        }
      }
      level = next;
    }
    if (count >= EXPAND_LIMIT) toast(`Only the first ${EXPAND_LIMIT} folders were expanded.`);
    await this.renderTree();
    this.app.emit("workspace");
  }

  collapseAll(dir: string) {
    const ws = this.app.workspace;
    if (ws && samePath(dir, ws)) this.expanded.clear();
    else for (const p of [...this.expanded]) if (samePath(p, dir) || isInside(p, dir)) this.expanded.delete(p);
    void this.renderTree();
    this.app.emit("workspace");
  }

  private showFileMenu(path: string, x: number, y: number) {
    const app = this.app;
    showMenu(
      [
        { label: "Open", icon: "file", action: () => app.openFile(path) },
        { label: "Open in new window", icon: "newWindow", action: () => app.backend.openWindow([path]) },
        pinnedNotes().some((p) => samePath(p, path))
          ? { label: "Unpin", icon: "pin", action: () => setPinned(path, false) }
          : { label: "Pin to the top", icon: "pin", action: () => setPinned(path, true) },
        { separator: true },
        { label: "Rename…", action: () => renamePath(app, path) },
        { label: "Copy path", action: () => copyText(path) },
        { label: "Reveal in file manager", icon: "folderOpen", action: () => app.backend.reveal(path) },
        { separator: true },
        { label: "Move to trash", danger: true, action: () => trashPath(app, path) },
      ],
      x,
      y,
    );
  }

  private showDirMenu(path: string, x: number, y: number, isRoot = false) {
    const app = this.app;
    const items: MenuItem[] = [
      { label: "New note here…", icon: "newFile", action: () => { this.expanded.add(path); return createFileIn(app, path); } },
      { label: "New folder…", icon: "newFolder", action: () => createFolderIn(app, path) },
      { label: "Open folder in new window", icon: "newWindow", action: () => app.backend.openWindow([path]) },
      { separator: true },
      { label: "Expand all", icon: "expand", action: () => this.expandAll(path) },
      { label: "Collapse all", icon: "collapse", action: () => this.collapseAll(path) },
      { separator: true },
      { label: "Copy path", action: () => copyText(path) },
      { label: "Reveal in file manager", icon: "folderOpen", action: () => app.backend.reveal(path) },
    ];
    if (isRoot) items.push({ separator: true }, { label: "Refresh", icon: "refresh", action: () => this.refreshTree() }, { label: "Close folder", action: () => app.closeFolder() });
    else items.push({ separator: true }, { label: "Rename…", action: () => renamePath(app, path) }, { label: "Move to trash", danger: true, action: () => trashPath(app, path) });
    showMenu(items, x, y);
  }

  // ---------------------------------------------------------------------------
  // Folder tasks

  private tasksToken = 0;
  /** Contents of the scanned notes (avoids re-reading the whole folder on every save). */
  private taskTexts = new Map<string, string | null>();
  /** The tasks found in each note, kept while its text and the task settings stay the same. */
  private taskCache = new Map<string, { text: string; cfg: TaskConfig; tasks: FoundTask[] }>();

  async renderTasks(full = true) {
    const app = this.app;
    const token = ++this.tasksToken;
    if (!app.workspace) {
      this.taskBadge.textContent = "";
      this.tasksList.replaceChildren(h("div", { class: "sb-empty" }, h("p", {}, "Open a folder to see the tasks of all your notes."), h("button", { class: "kn-btn primary", onclick: () => app.openFolder() }, "Open folder")));
      return;
    }
    const suffix = app.settings.archive_suffix;
    const files = app.workspaceFiles.filter((p) => app.isNoteFile(p) && !isDoneFile(p, suffix)).slice(0, 3000);
    const missing = full ? files : files.filter((f) => !this.taskTexts.has(f));
    const read = await app.readFiles(missing);
    if (token !== this.tasksToken) return;
    if (full) this.taskTexts.clear();
    missing.forEach((f, i) => this.taskTexts.set(f, read[i]));
    // Notes that are gone (or another folder): their tasks are forgotten.
    if (full) for (const p of this.taskCache.keys()) if (!this.taskTexts.has(p)) this.taskCache.delete(p);
    // Open notes win (their in-memory content is the most recent).
    for (const d of app.docs) if (d.path && this.taskTexts.has(d.path)) this.taskTexts.set(d.path, app.docText(d));
    const texts = files.map((f) => this.taskTexts.get(f) ?? null);
    const cfg = app.taskCfg;
    const today = todayISO();
    let ongoingTotal = 0;
    let overdueTotal = 0;
    const tagCounts = new Map<string, number>();
    const groups: { path: string; tasks: FoundTask[]; ongoing: number }[] = [];
    files.forEach((path, i) => {
      const text = texts[i];
      if (!text) return;
      let cached = this.taskCache.get(path);
      if (!cached || cached.cfg !== cfg || cached.text !== text) this.taskCache.set(path, (cached = { text, cfg, tasks: findTasks(text, cfg) }));
      const all = cached.tasks;
      const ongoing = all.filter((t) => isOngoingStatus(t.task.key, cfg)).length;
      ongoingTotal += ongoing;
      for (const t of all) {
        const open = !isDoneStatus(t.task.key, cfg);
        if (open && t.task.due && t.task.due < today) overdueTotal++;
        if (open || this.taskFilter === "all") for (const tag of findTags(t.raw)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
      const tasks = all.filter((t) => {
        if (this.taskTag && !findTags(t.raw).includes(this.taskTag)) return false;
        if (this.taskFilter === "all") return true;
        if (this.taskFilter === "ongoing") return isOngoingStatus(t.task.key, cfg);
        if (this.taskFilter === "due") return !!t.task.due && !isDoneStatus(t.task.key, cfg);
        return !isDoneStatus(t.task.key, cfg);
      });
      if (tasks.length) groups.push({ path, tasks, ongoing });
    });
    this.lastTags = tagCounts;
    // The badge: overdue tasks (red) first, otherwise the ongoing ones.
    this.taskBadge.classList.toggle("overdue", overdueTotal > 0);
    this.taskBadge.textContent = overdueTotal ? String(overdueTotal) : ongoingTotal ? String(ongoingTotal) : "";
    this.taskBadge.title = overdueTotal
      ? `${overdueTotal} overdue task${overdueTotal > 1 ? "s" : ""}`
      : `${ongoingTotal} ongoing task${ongoingTotal > 1 ? "s" : ""}`;
    groups.sort((a, b) => b.ongoing - a.ongoing || basename(a.path).localeCompare(basename(b.path)));
    const order = cfg.cycle;
    const rank = (k: string) => (isOngoingStatus(k, cfg) ? -1 : order.indexOf(k) < 0 ? 99 : order.indexOf(k));
    // Earliest due date first; tasks without one after.
    const dueKey = (t: FoundTask) => t.task.due ?? "9999";

    const frag = document.createDocumentFragment();
    if (!groups.length) {
      const what = this.taskFilter === "ongoing" ? "No ongoing task" : this.taskFilter === "due" ? "No task with a due date" : "No task found";
      frag.append(h("div", { class: "sb-empty" }, h("p", {}, `${what}${this.taskTag ? ` tagged ${this.taskTag}` : ""}.`), h("p", { class: "sb-hint" }, `Write "- my task - todo" or press ${shortcutFor("task.cycle")} on a line.`)));
    }
    for (const g of groups) {
      const rel = relative(app.workspace, dirname(g.path));
      frag.append(
        h("div", { class: "sb-group-title", title: g.path, onclick: () => app.openFile(g.path) },
          icon("file", "sb-file-icon"),
          h("span", { class: "sb-name" }, projectName(g.path, suffix)),
          rel ? h("span", { class: "sb-dim" }, rel) : null,
          h("span", { class: "kn-spacer" }),
          h("span", { class: "sb-count" }, String(g.tasks.length))),
      );
      if (this.taskFilter === "due") g.tasks.sort((a, b) => dueKey(a).localeCompare(dueKey(b)) || a.line - b.line);
      else g.tasks.sort((a, b) => rank(a.task.key) - rank(b.task.key) || dueKey(a).localeCompare(dueKey(b)) || a.line - b.line);
      for (const t of g.tasks) {
        const color = resolveColor(cfg.statuses[t.task.key]);
        const row = h(
          "div",
          { class: `sb-task${isDoneStatus(t.task.key, cfg) ? " done" : ""}`, title: `${t.raw.trim()}\nLine ${t.line}` },
          h("span", { class: "sb-task-status", style: { "--c": color } }, t.task.status),
          h("span", { class: "sb-task-text" }, t.task.text.replace(/(\*\*|\*|`)(\S(?:.*?\S)?)\1/g, "$2").replace(/(^|\s)@\d{4}-\d{2}-\d{2}/, "")),
          t.task.due ? h("span", { class: `sb-due ${isDoneStatus(t.task.key, cfg) ? "" : dueState(t.task.due, today)}`, title: `Due ${t.task.due}` }, shortDate(t.task.due)) : null,
          h("span", { class: "sb-task-actions" },
            h("button", { class: "kn-icon-btn", title: "Next status", onclick: (e: Event) => { e.stopPropagation(); void this.taskAction(g.path, t, "cycle"); } }, icon("cycle")),
            h("button", { class: "kn-icon-btn", title: "Archive to _done", onclick: (e: Event) => { e.stopPropagation(); void this.taskAction(g.path, t, "archive"); } }, icon("archive"))),
        );
        row.addEventListener("click", () => void app.openFile(g.path, { line: t.line, select: [t.task.textFrom, t.task.textTo] }));
        frag.append(row);
      }
    }
    this.tasksList.replaceChildren(frag);
  }

  private renderTagChip() {
    this.tagChip.classList.toggle("active", !!this.taskTag);
    if (this.taskTag) this.tagChip.replaceChildren(h("span", {}, this.taskTag), icon("x"));
    else this.tagChip.replaceChildren(icon("tag"));
    this.tagChip.title = this.taskTag ? "Remove the tag filter" : "Filter by #tag";
  }

  private tagMenu(e: MouseEvent) {
    if (this.taskTag) {
      this.taskTag = null;
      this.renderTagChip();
      void this.renderTasks(false);
      return;
    }
    const tags = [...this.lastTags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showMenu(
      tags.length
        ? [{ header: "Show the tasks tagged" }, ...tags.map(([t, n]) => ({
            label: `${t}  (${n})`, icon: "tag", action: () => {
              this.taskTag = t;
              this.renderTagChip();
              void this.renderTasks(false);
            },
          }))]
        : [{ header: "No #tag in the tasks yet" }],
      r.left,
      r.bottom + 4,
    );
  }

  /** Quick action from the list, without necessarily opening a tab. */
  private async taskAction(path: string, t: FoundTask, action: "cycle" | "archive") {
    const text = await changeTaskInNote(this.app, path, t, { archive: action === "archive" });
    if (text == null) {
      toast("The note changed in the meantime: list refreshed.");
      void this.renderTasks();
      return;
    }
    this.taskTexts.set(path, text);
    void this.renderTasks(false);
  }

  // ---------------------------------------------------------------------------
  // Search in files

  /** The search expression, or null when invalid. */
  private searchRegExp(): RegExp | null {
    const q = this.searchInput.value;
    try {
      return new RegExp(this.searchRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), this.searchCase ? "g" : "gi");
    } catch {
      return null;
    }
  }

  /** Replaces the matches of the last search, in every file or in one. */
  private async replaceAll(only?: string) {
    const re = this.searchRegExp();
    if (!this.searchInput.value || !re) return;
    if (re.test("")) {
      toast("This expression also matches empty text: make it more specific before replacing.", { kind: "error" });
      return;
    }
    const files = only ? this.hitFiles.filter((f) => f.path === only) : this.hitFiles;
    if (!files.length) return;
    const total = files.reduce((n, f) => n + f.count, 0);
    const replacement = this.replaceInput.value;
    const r = await confirm({
      title: `Replace in ${files.length} file${files.length > 1 ? "s" : ""}?`,
      message: `"${this.searchInput.value}" → "${replacement}" (${total}+ match${total > 1 ? "es" : ""}). A copy of each closed file goes to the local history, and the notification offers to undo.`,
      okLabel: "Replace",
      danger: true,
    });
    if (r !== "ok") return;
    await replaceInFiles(this.app, files.map((f) => f.path), re, replacement, !this.searchRegex);
    await this.runSearch();
  }

  private searchToken = 0;
  async runSearch() {
    const app = this.app;
    const q = this.searchInput.value;
    const token = ++this.searchToken;
    if (!q) {
      this.searchResults.replaceChildren();
      return;
    }
    if (!app.workspace) {
      this.searchResults.replaceChildren(h("div", { class: "sb-empty" }, h("p", {}, "Open a folder to search in it.")));
      return;
    }
    let re: RegExp;
    try {
      re = new RegExp(this.searchRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), this.searchCase ? "g" : "gi");
    } catch (e) {
      this.searchResults.replaceChildren(h("div", { class: "sb-empty error" }, `Invalid expression: ${(e as Error).message}`));
      return;
    }
    const files = app.workspaceFiles.filter((p) => app.isNoteFile(p)).slice(0, 5000);
    const texts = await app.readFiles(files);
    if (token !== this.searchToken) return;
    this.hitFiles = [];
    const frag = document.createDocumentFragment();
    let total = 0;
    let fileCount = 0;
    const LIMIT = 2000;
    for (let i = 0; i < files.length && total < LIMIT; i++) {
      const text = texts[i];
      if (!text) continue;
      const lines = text.split(/\r\n|\r|\n/);
      const hits: HTMLElement[] = [];
      for (let ln = 0; ln < lines.length && total < LIMIT; ln++) {
        const line = lines[ln];
        re.lastIndex = 0;
        const m = re.exec(line);
        if (!m || !m[0].length) continue;
        total++;
        // Little context before the match so that it stays visible.
        let start = Math.max(0, m.index - 16);
        const space = line.lastIndexOf(" ", m.index - 1);
        if (start > 0 && space >= start - 8 && space < m.index) start = space + 1;
        const before = (start > 0 ? "…" : "") + line.slice(start, m.index).trimStart();
        const after = line.slice(m.index + m[0].length, m.index + m[0].length + 80);
        const path = files[i];
        const col = m.index;
        const len = m[0].length;
        const row = h("div", { class: "sb-hit", title: line.trim() },
          h("span", { class: "sb-hit-line" }, String(ln + 1)),
          h("span", { class: "sb-hit-text" }, before, h("mark", {}, m[0]), after));
        row.addEventListener("click", () => void app.openFile(path, { line: ln + 1, select: [col, col + len] }));
        hits.push(row);
      }
      if (hits.length) {
        fileCount++;
        const path = files[i];
        this.hitFiles.push({ path, count: hits.length });
        const rel = relative(app.workspace, dirname(path));
        frag.append(
          h("div", { class: "sb-group-title", title: path }, icon("file", "sb-file-icon"), h("span", { class: "sb-name" }, basename(path)), rel ? h("span", { class: "sb-dim" }, rel) : null, h("span", { class: "kn-spacer" }),
            this.replaceRow.hidden ? null : h("button", { class: "kn-icon-btn sb-replace-file", title: "Replace in this file", onclick: (e: Event) => { e.stopPropagation(); void this.replaceAll(path); } }, icon("replace")),
            h("span", { class: "sb-count" }, String(hits.length))),
          ...hits,
        );
      }
    }
    const summary = h("div", { class: "sb-summary" }, total ? `${total}${total >= LIMIT ? "+" : ""} result${total > 1 ? "s" : ""} in ${fileCount} file${fileCount > 1 ? "s" : ""}` : "No results");
    this.searchResults.replaceChildren(summary, frag);
  }
}
