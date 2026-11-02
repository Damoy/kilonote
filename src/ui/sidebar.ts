// Barre latérale : explorateur de fichiers, vue des tâches du dossier,
// recherche dans les fichiers.

import type { App } from "../app";
import { shortcutFor } from "../core/commands";
import type { Entry } from "../core/backend";
import { basename, dirname, extname, isDoneFile, projectName, relative, samePath } from "../core/path";
import { resolveColor } from "../core/themes";
import { findTasks, isDoneStatus, type FoundTask } from "../editor/tasks";
import { debounce, h, icon } from "./dom";
import { showMenu, toast, type MenuItem } from "./overlay";

export type Panel = "files" | "tasks" | "search";
type TaskFilter = "open" | "ongoing" | "all";

export class Sidebar {
  visible = true;
  width = 260;
  panel: Panel = "files";
  private expanded = new Set<string>();
  private cache = new Map<string, Entry[]>();
  private panels: Record<Panel, HTMLElement>;
  private switchBtns: Record<Panel, HTMLElement>;
  private taskBadge = h("span", { class: "sb-badge" });
  private treeEl = h("div", { class: "sb-tree" });
  private filesHeader = h("div", { class: "sb-header" });
  private tasksList = h("div", { class: "sb-list" });
  private taskFilter: TaskFilter = "open";
  private searchInput = h("input", { class: "kn-input sb-search-input", type: "text", placeholder: "Rechercher dans le dossier…", spellcheck: "false" });
  private searchResults = h("div", { class: "sb-list" });
  private searchCase = false;
  private searchRegex = false;
  private treeRender = 0;

  constructor(private app: App, el: HTMLElement, resizer: HTMLElement) {
    const mk = (p: Panel, ic: string, title: string, extra?: HTMLElement) => {
      const b = h("button", { class: "sb-switch-btn", title, onclick: () => this.show(p, true) }, icon(ic), extra ?? null);
      return b;
    };
    this.switchBtns = {
      files: mk("files", "files", `Explorateur (${shortcutFor("view.files")})`),
      tasks: mk("tasks", "tasks", `Tâches du dossier (${shortcutFor("view.tasks")})`, this.taskBadge),
      search: mk("search", "search", `Rechercher dans les fichiers (${shortcutFor("view.search")})`),
    };
    const switcher = h("div", { class: "sb-switch" }, this.switchBtns.files, this.switchBtns.tasks, this.switchBtns.search);

    const filesPanel = h("div", { class: "sb-panel" }, this.filesHeader, this.treeEl);
    this.treeEl.addEventListener("contextmenu", (e) => {
      if (e.target !== this.treeEl || !app.workspace) return;
      e.preventDefault();
      this.showDirMenu(app.workspace, e.clientX, e.clientY, true);
    });

    const filterBar = h("div", { class: "sb-chips" });
    const filters: [TaskFilter, string][] = [["open", "À traiter"], ["ongoing", "En cours"], ["all", "Toutes"]];
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
    const tasksPanel = h(
      "div",
      { class: "sb-panel" },
      h("div", { class: "sb-header" }, h("span", { class: "sb-title" }, "Tâches"), h("span", { class: "kn-spacer" }),
        h("button", { class: "kn-icon-btn", title: "Bilan d'activité", onclick: () => app.generateReport() }, icon("chart")),
        h("button", { class: "kn-icon-btn", title: "Actualiser", onclick: () => this.renderTasks() }, icon("refresh"))),
      filterBar,
      this.tasksList,
    );

    const caseBtn = h("button", { class: "sb-toggle", title: "Respecter la casse" }, "Aa");
    const reBtn = h("button", { class: "sb-toggle", title: "Expression régulière" }, ".*");
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
    const searchPanel = h(
      "div",
      { class: "sb-panel" },
      h("div", { class: "sb-header" }, h("span", { class: "sb-title" }, "Rechercher")),
      h("div", { class: "sb-search-box" }, this.searchInput, caseBtn, reBtn),
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
      // La liste des fichiers a été relue (fichier créé, archivé, renommé…) :
      // on oublie les dossiers en cache et on relit les tâches.
      if (app.workspaceFiles !== lastFiles) {
        lastFiles = app.workspaceFiles;
        this.cache.clear();
        tasksSoon();
      }
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
      // Raccourci pressé deux fois : on revient à l'éditeur.
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
  // Explorateur

  private renderFilesHeader() {
    const app = this.app;
    this.filesHeader.replaceChildren(
      h("span", { class: "sb-title", title: app.workspace ?? "" }, app.workspace ? basename(app.workspace) : "Explorateur"),
      h("span", { class: "kn-spacer" }),
    );
    if (app.workspace) {
      const ws = app.workspace;
      this.filesHeader.append(
        h("button", { class: "kn-icon-btn", title: "Nouvelle note", onclick: () => app.createFileIn(ws) }, icon("newFile")),
        h("button", { class: "kn-icon-btn", title: "Nouveau dossier", onclick: () => app.createFolderIn(ws) }, icon("newFolder")),
        h("button", { class: "kn-icon-btn", title: "Actualiser", onclick: () => this.refreshTree() }, icon("refresh")),
        h("button", { class: "kn-icon-btn", title: "Tout replier", onclick: () => { this.expanded.clear(); void this.renderTree(); } }, icon("collapse")),
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
          h("p", {}, "Aucun dossier ouvert."),
          h("button", { class: "kn-btn primary", onclick: () => app.openFolder() }, "Ouvrir un dossier"),
          recent.length ? h("div", { class: "sb-recent-title" }, "Récents") : null,
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
    // Les enfants des dossiers dépliés sont chargés en parallèle.
    await Promise.all(entries.filter((e) => e.isDir && this.expanded.has(e.path)).map((e) => this.list(e.path)));
    for (const e of entries) {
      const open = e.isDir && this.expanded.has(e.path);
      const done = !e.isDir && isDoneFile(e.path, suffix);
      const ext = extname(e.path);
      const row = h(
        "div",
        { class: `sb-row${e.isDir ? " dir" : ""}${done ? " done" : ""}`, style: { paddingLeft: `${10 + depth * 14}px` }, title: e.path, "data-path": e.path },
        e.isDir ? icon("chevron", `sb-chevron${open ? " open" : ""}`) : h("span", { class: "sb-chevron-space" }),
        icon(e.isDir ? "folder" : done ? "fileDone" : ext === "md" || ext === "markdown" ? "fileMd" : "file", "sb-file-icon"),
        h("span", { class: "sb-name" }, e.name),
      );
      row.addEventListener("click", () => {
        if (e.isDir) {
          if (open) this.expanded.delete(e.path);
          else this.expanded.add(e.path);
          void this.renderTree();
          this.app.emit("workspace");
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

  private markActive() {
    const p = this.app.active?.path;
    this.treeEl.querySelectorAll<HTMLElement>(".sb-row").forEach((r) => {
      r.classList.toggle("active", !!p && samePath(r.dataset.path!, p));
    });
  }

  private showFileMenu(path: string, x: number, y: number) {
    const app = this.app;
    showMenu(
      [
        { label: "Ouvrir", icon: "file", action: () => app.openFile(path) },
        { separator: true },
        { label: "Renommer…", action: () => app.renamePath(path) },
        { label: "Copier le chemin", action: () => app.copyText(path) },
        { label: "Afficher dans l'explorateur", icon: "folderOpen", action: () => app.backend.reveal(path) },
        { separator: true },
        { label: "Mettre à la corbeille", danger: true, action: () => app.trashPath(path) },
      ],
      x,
      y,
    );
  }

  private showDirMenu(path: string, x: number, y: number, isRoot = false) {
    const app = this.app;
    const items: MenuItem[] = [
      { label: "Nouvelle note ici…", icon: "newFile", action: () => { this.expanded.add(path); return app.createFileIn(path); } },
      { label: "Nouveau dossier…", icon: "newFolder", action: () => app.createFolderIn(path) },
      { separator: true },
      { label: "Copier le chemin", action: () => app.copyText(path) },
      { label: "Afficher dans l'explorateur", icon: "folderOpen", action: () => app.backend.reveal(path) },
    ];
    if (isRoot) items.push({ separator: true }, { label: "Actualiser", icon: "refresh", action: () => this.refreshTree() }, { label: "Fermer le dossier", action: () => app.closeFolder() });
    else items.push({ separator: true }, { label: "Renommer…", action: () => app.renamePath(path) }, { label: "Mettre à la corbeille", danger: true, action: () => app.trashPath(path) });
    showMenu(items, x, y);
  }

  // ---------------------------------------------------------------------------
  // Tâches du dossier

  private tasksToken = 0;
  /** Contenu des notes analysées (évite de relire tout le dossier à chaque enregistrement). */
  private taskTexts = new Map<string, string | null>();

  async renderTasks(full = true) {
    const app = this.app;
    const token = ++this.tasksToken;
    if (!app.workspace) {
      this.taskBadge.textContent = "";
      this.tasksList.replaceChildren(h("div", { class: "sb-empty" }, h("p", {}, "Ouvrez un dossier pour voir les tâches de toutes vos notes."), h("button", { class: "kn-btn primary", onclick: () => app.openFolder() }, "Ouvrir un dossier")));
      return;
    }
    const suffix = app.settings.archive_suffix;
    const files = app.workspaceFiles.filter((p) => app.isNoteFile(p) && !isDoneFile(p, suffix)).slice(0, 3000);
    const missing = full ? files : files.filter((f) => !this.taskTexts.has(f));
    const read = await app.readFiles(missing);
    if (token !== this.tasksToken) return;
    if (full) this.taskTexts.clear();
    missing.forEach((f, i) => this.taskTexts.set(f, read[i]));
    // Les notes ouvertes font foi (contenu en mémoire, le plus récent).
    for (const d of app.docs) if (d.path && this.taskTexts.has(d.path)) this.taskTexts.set(d.path, d.state.doc.toString());
    const texts = files.map((f) => this.taskTexts.get(f) ?? null);
    const cfg = app.taskCfg;
    let ongoingTotal = 0;
    const groups: { path: string; tasks: FoundTask[]; ongoing: number }[] = [];
    files.forEach((path, i) => {
      const text = texts[i];
      if (!text) return;
      const all = findTasks(text, cfg);
      const ongoing = all.filter((t) => t.task.key === "ongoing").length;
      ongoingTotal += ongoing;
      const tasks = all.filter((t) => {
        if (this.taskFilter === "all") return true;
        if (this.taskFilter === "ongoing") return t.task.key === "ongoing";
        return !isDoneStatus(t.task.key, cfg);
      });
      if (tasks.length) groups.push({ path, tasks, ongoing });
    });
    this.taskBadge.textContent = ongoingTotal ? String(ongoingTotal) : "";
    this.taskBadge.title = `${ongoingTotal} tâche(s) en cours`;
    groups.sort((a, b) => b.ongoing - a.ongoing || basename(a.path).localeCompare(basename(b.path)));
    const order = cfg.cycle;
    const rank = (k: string) => (k === "ongoing" ? -1 : order.indexOf(k) < 0 ? 99 : order.indexOf(k));

    const frag = document.createDocumentFragment();
    if (!groups.length) {
      frag.append(h("div", { class: "sb-empty" }, h("p", {}, this.taskFilter === "ongoing" ? "Aucune tâche en cours." : "Aucune tâche trouvée."), h("p", { class: "sb-hint" }, "Écrivez « - ma tâche - todo » ou appuyez sur Ctrl+Entrée sur une ligne.")));
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
      g.tasks.sort((a, b) => rank(a.task.key) - rank(b.task.key) || a.line - b.line);
      for (const t of g.tasks) {
        const color = resolveColor(cfg.statuses[t.task.key]);
        const row = h(
          "div",
          { class: `sb-task${isDoneStatus(t.task.key, cfg) ? " done" : ""}`, title: `${t.raw.trim()}\nLigne ${t.line}` },
          h("span", { class: "sb-task-status", style: { "--c": color } }, t.task.status),
          h("span", { class: "sb-task-text" }, t.task.text.replace(/(\*\*|\*|`)(\S(?:.*?\S)?)\1/g, "$2")),
          h("span", { class: "sb-task-actions" },
            h("button", { class: "kn-icon-btn", title: "Statut suivant", onclick: (e: Event) => { e.stopPropagation(); void this.taskAction(g.path, t, "cycle"); } }, icon("cycle")),
            h("button", { class: "kn-icon-btn", title: "Archiver dans _done", onclick: (e: Event) => { e.stopPropagation(); void this.taskAction(g.path, t, "archive"); } }, icon("archive"))),
        );
        row.addEventListener("click", () => void app.openFile(g.path, { line: t.line, select: [t.task.textFrom, t.task.textTo] }));
        frag.append(row);
      }
    }
    this.tasksList.replaceChildren(frag);
  }

  /** Action rapide depuis la liste, sans forcément ouvrir d'onglet. */
  private async taskAction(path: string, t: FoundTask, action: "cycle" | "archive") {
    const app = this.app;
    const wasOpen = !!app.findDoc(path);
    const doc = await app.openFile(path, { activate: false });
    if (!doc) return;
    const line = doc.state.doc.lines >= t.line ? doc.state.doc.line(t.line) : null;
    if (!line || line.text !== t.raw) {
      toast("La note a changé entre-temps : liste actualisée.");
      void this.renderTasks();
      return;
    }
    if (action === "cycle") app.cycleTasks(undefined, doc, [t.line]);
    else await app.archiveLines(doc, [t.line]);
    await app.save(doc);
    this.taskTexts.set(path, doc.state.doc.toString());
    if (!wasOpen && doc !== app.active) await app.closeDoc(doc, { force: true });
    void this.renderTasks(false);
  }

  // ---------------------------------------------------------------------------
  // Recherche dans les fichiers

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
      this.searchResults.replaceChildren(h("div", { class: "sb-empty" }, h("p", {}, "Ouvrez un dossier pour y rechercher.")));
      return;
    }
    let re: RegExp;
    try {
      re = new RegExp(this.searchRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), this.searchCase ? "g" : "gi");
    } catch (e) {
      this.searchResults.replaceChildren(h("div", { class: "sb-empty error" }, `Expression invalide : ${(e as Error).message}`));
      return;
    }
    const files = app.workspaceFiles.filter((p) => app.isNoteFile(p)).slice(0, 5000);
    const texts = await app.readFiles(files);
    if (token !== this.searchToken) return;
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
        // Peu de contexte avant la correspondance pour qu'elle reste visible.
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
        const rel = relative(app.workspace, dirname(files[i]));
        frag.append(
          h("div", { class: "sb-group-title", title: files[i] }, icon("file", "sb-file-icon"), h("span", { class: "sb-name" }, basename(files[i])), rel ? h("span", { class: "sb-dim" }, rel) : null, h("span", { class: "kn-spacer" }), h("span", { class: "sb-count" }, String(hits.length))),
          ...hits,
        );
      }
    }
    const summary = h("div", { class: "sb-summary" }, total ? `${total}${total >= LIMIT ? "+" : ""} résultat${total > 1 ? "s" : ""} dans ${fileCount} fichier${fileCount > 1 ? "s" : ""}` : "Aucun résultat");
    this.searchResults.replaceChildren(summary, frag);
  }
}
