// Task board: the tasks of every note of the folder, in one column per status.
// Dragging a card to another column changes the status in its note (which
// stays the only source: the board is only a view of the notes). Click a card
// to open its note on that line; right-click for the status menu; with the
// keyboard, ←/→ moves the focused card to the previous/next status.

import type { App } from "../app/app";
import { changeTaskInNote, folderTasks } from "../app/tasks";
import { basename, dirname, projectName, relative } from "../core/path";
import { resolveColor } from "../core/themes";
import { dueState, findTags, isDoneStatus, todayISO, type FoundTask } from "../text/tasks";
import { debounce, h, icon } from "./dom";
import { showMenu, toast } from "./overlay";

/** Cards shown per column (the others are counted). */
const MAX_CARDS = 300;

interface Card {
  path: string;
  task: FoundTask;
}

let open: Board | null = null;

export function showBoard(app: App) {
  if (open) open.refresh();
  else open = new Board(app);
}

/** The statuses as columns: the cycle first (todo → ongoing → done), then the others. */
export function boardColumns(statuses: string[], cycle: string[]): string[] {
  return [...cycle.filter((s) => statuses.includes(s)), ...statuses.filter((s) => !cycle.includes(s))];
}

/** The text of a card: the task without its markup and its due date. */
export function cardText(t: FoundTask): string {
  return t.task.text.replace(/(\*\*|\*|`)(\S(?:.*?\S)?)\1/g, "$2").replace(/(^|\s)@\d{4}-\d{2}-\d{2}/, "").trim();
}

class Board {
  private backdrop: HTMLElement;
  private columns = h("div", { class: "kn-board-columns" });
  private filter = h("input", { class: "kn-input kn-board-filter", type: "search", placeholder: "Filter: words, #tag, note…", spellcheck: "false" });
  private summary = h("span", { class: "kn-board-summary" });
  private cards: Card[] = [];
  private token = 0;
  private refreshSoon = debounce(() => this.refresh(), 300);
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector(".kn-menu, .kn-modal")) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  constructor(private app: App) {
    const panel = h(
      "div",
      { class: "kn-board", role: "dialog", "aria-label": "Task board" },
      h("div", { class: "kn-board-head" },
        icon("board"),
        h("div", { class: "kn-modal-title" }, "Task board"),
        this.summary,
        h("span", { class: "kn-spacer" }),
        this.filter,
        h("button", { class: "kn-icon-btn", title: "Refresh", onclick: () => this.refresh() }, icon("refresh")),
        h("button", { class: "kn-icon-btn", title: "Close (Esc)", onclick: () => this.close() }, icon("x"))),
      this.columns,
      h("div", { class: "kn-board-hint" }, "Drag a card to change its status in its note · click to open the note · right-click for more · ←/→ on a focused card"),
    );
    // "kn-modal-backdrop": global shortcuts stay off while the board is open.
    this.backdrop = h("div", { class: "kn-modal-backdrop kn-board-backdrop" }, panel);
    this.backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.backdrop) this.close();
    });
    this.filter.addEventListener("input", () => this.render());
    document.getElementById("overlay-root")!.append(this.backdrop);
    document.addEventListener("keydown", this.onKey, true);
    app.on("saved", this.refreshSoon);
    app.on("workspace", this.refreshSoon);
    this.refresh();
    this.filter.focus();
  }

  async refresh() {
    const token = ++this.token;
    if (!this.app.workspace) {
      this.columns.replaceChildren(h("div", { class: "kn-board-empty" },
        h("p", {}, "Open a folder to see the tasks of all its notes on a board."),
        h("button", { class: "kn-btn primary", onclick: () => { this.close(); void this.app.openFolder(); } }, "Open folder")));
      return;
    }
    const notes = await folderTasks(this.app);
    if (token !== this.token) return;
    this.cards = notes.flatMap((n) => n.tasks.map((task) => ({ path: n.path, task })));
    this.render();
  }

  private matches(c: Card, words: string[]): boolean {
    const hay = `${c.task.raw} ${relative(this.app.workspace, c.path)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  private render() {
    const cfg = this.app.taskCfg;
    const words = this.filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = this.cards.filter((c) => this.matches(c, words));
    const today = todayISO();
    this.summary.textContent = `${shown.length} task${shown.length === 1 ? "" : "s"}${shown.length !== this.cards.length ? ` of ${this.cards.length}` : ""}`;
    const statuses = boardColumns(Object.keys(cfg.statuses), cfg.cycle);
    // Earliest due date first, then by note and line.
    const order = (a: Card, b: Card) =>
      (a.task.task.due ?? "9999").localeCompare(b.task.task.due ?? "9999") || basename(a.path).localeCompare(basename(b.path)) || a.task.line - b.task.line;
    const cols = statuses.map((status) => {
      const cards = shown.filter((c) => c.task.task.key === status).sort(order);
      const color = resolveColor(cfg.statuses[status]);
      const list = h("div", { class: "kn-board-cards" },
        ...cards.slice(0, MAX_CARDS).map((c) => this.cardEl(c, statuses, today)),
        cards.length > MAX_CARDS ? h("div", { class: "kn-board-more" }, `…and ${cards.length - MAX_CARDS} more (filter to see them)`) : null,
        cards.length ? null : h("div", { class: "kn-board-none" }, "No task"));
      // A status outside the cycle with no task gets a narrow column (still a place to drop a card).
      const narrow = !cards.length && !cfg.cycle.includes(status);
      return h("section", { class: `kn-board-col${narrow ? " narrow" : ""}`, "data-status": status, style: { "--c": color } },
        h("header", { class: "kn-board-col-head" }, h("i", {}), h("span", {}, status), h("span", { class: "kn-board-count" }, String(cards.length))),
        list);
    });
    this.columns.replaceChildren(...cols);
  }

  private cardEl(c: Card, statuses: string[], today: string): HTMLElement {
    const cfg = this.app.taskCfg;
    const t = c.task.task;
    const done = isDoneStatus(t.key, cfg);
    const folder = relative(this.app.workspace, dirname(c.path)).replace(/\\/g, "/");
    const card = h("div", { class: `kn-card${done ? " done" : ""}`, tabindex: "0", title: `${c.task.raw.trim()}\n${relative(this.app.workspace, c.path)}:${c.task.line}` },
      h("div", { class: "kn-card-text" }, cardText(c.task) || c.task.raw.trim()),
      h("div", { class: "kn-card-meta" },
        h("span", { class: "kn-card-note" }, icon("file"), projectName(c.path, this.app.settings.archive_suffix), folder ? h("span", { class: "kn-card-folder" }, folder) : null),
        ...findTags(c.task.raw).slice(0, 3).map((tag) => h("span", { class: "kn-card-tag" }, tag)),
        t.due ? h("span", { class: `kn-card-due ${done ? "" : dueState(t.due, today)}` }, t.due) : null));
    card.addEventListener("pointerdown", (e) => this.drag(e, card, c));
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.menu(c, e.clientX, e.clientY);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.openCard(c);
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const i = statuses.indexOf(t.key) + (e.key === "ArrowRight" ? 1 : -1);
        if (i >= 0 && i < statuses.length) void this.move(c, statuses[i]);
      } else return;
      e.preventDefault();
    });
    return card;
  }

  /** A click opens the card's note; a drag moves the card to another column. */
  private drag(e: PointerEvent, card: HTMLElement, c: Card) {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let ghost: HTMLElement | null = null;
    let over: HTMLElement | null = null;
    const columnAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>(".kn-board-col") ?? null;
    const move = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        const box = card.getBoundingClientRect();
        ghost = card.cloneNode(true) as HTMLElement;
        ghost.classList.add("kn-card-ghost");
        ghost.style.width = `${box.width}px`;
        document.body.append(ghost);
        card.classList.add("dragging");
      }
      ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY + 8}px)`;
      const col = columnAt(ev.clientX, ev.clientY);
      if (col !== over) {
        over?.classList.remove("drop");
        over = col && col.dataset.status !== c.task.task.key ? col : null;
        over?.classList.add("drop");
      }
    };
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      over?.classList.remove("drop");
      card.classList.remove("dragging");
      if (!ghost) {
        void this.openCard(c);
        return;
      }
      ghost.remove();
      const status = columnAt(ev.clientX, ev.clientY)?.dataset.status;
      if (status && status !== c.task.task.key) void this.move(c, status);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  private menu(c: Card, x: number, y: number) {
    const cfg = this.app.taskCfg;
    showMenu(
      [
        { header: "Status" },
        ...Object.entries(cfg.statuses).map(([name, color]) => ({ label: name, color, checked: c.task.task.key === name, action: () => this.move(c, name) })),
        { separator: true },
        { label: "Open the note", icon: "file", action: () => this.openCard(c) },
        { label: "Archive to _done", icon: "archive", action: () => this.change(c, { archive: true }) },
      ],
      x,
      y,
    );
  }

  private move(c: Card, status: string) {
    if (status === c.task.task.key) return;
    return this.change(c, { status });
  }

  private async change(c: Card, change: { status?: string; archive?: boolean }) {
    const text = await changeTaskInNote(this.app, c.path, c.task, change);
    if (text == null) toast("The note changed in the meantime: board refreshed.");
    await this.refresh();
  }

  private async openCard(c: Card) {
    this.close();
    await this.app.openFile(c.path, { line: c.task.line, select: [c.task.task.textFrom, c.task.task.textTo] });
  }

  close() {
    this.backdrop.remove();
    document.removeEventListener("keydown", this.onKey, true);
    this.app.off("saved", this.refreshSoon);
    this.app.off("workspace", this.refreshSoon);
    open = null;
    this.app.focusEditor();
  }
}
