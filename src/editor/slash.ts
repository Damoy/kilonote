// Quick inserts: "/" typed at the start of a line or after a space, in a note,
// opens a small menu at the cursor: /today, /todo, /h1, /table, /link,
// /secret, a template… The letters typed after "/" filter it; Enter or Tab
// picks, ↑ ↓ choose, Escape closes it, and a space (or a second "/") makes it
// go away: typing a path or "and/or" is never in the way.

import { Prec, StateEffect, StateField, type EditorState, type Extension, type Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip, type TooltipView, type ViewUpdate } from "@codemirror/view";
import { fuzzyFilter } from "../core/fuzzy";
import { applyLineEdit, cycleLine, parseTask } from "../text/tasks";
import { isoDate } from "../text/templates";
import { codeDocFacet, plainNotesFacet, taskConfigFacet } from "./decorations";

export interface SlashItem {
  /** What is typed after "/" ("today", "h1"). */
  name: string;
  label: string;
  /** Shown on the right (what it inserts: "2026-11-11"). */
  detail?: string;
  /** Other words that find it. */
  keywords?: string;
  /** The change it makes: `from`–`to` is the "/name" typed, which the change removes. */
  edit?: (state: EditorState, from: number, to: number) => TransactionSpec;
  /** Run once "/name" is removed (or after `edit`). */
  run?: (view: EditorView) => void;
}

/** The items the app adds (links, secrets, due date, templates). */
let hostItems: (state: EditorState) => SlashItem[] = () => [];
export function setSlashHost(items: (state: EditorState) => SlashItem[]) {
  hostItems = items;
}

interface SlashState {
  /** Where the "/" is. */
  from: number;
  /** The item chosen with the arrows (0: the first). */
  selected: number;
  /** The user moved in the menu: Enter picks even with nothing typed. */
  moved: boolean;
  tooltip: Tooltip;
}

const openMenu = StateEffect.define<number>();
const closeMenu = StateEffect.define<null>();
const selectItem = StateEffect.define<number>();

const p2 = (n: number) => String(n).padStart(2, "0");

/** Replaces "/name" with `insert`, the cursor `cursor` characters into it (at its end by default). */
function insertText(insert: string, cursor = insert.length) {
  return (_s: EditorState, from: number, to: number): TransactionSpec => ({
    changes: { from, to, insert },
    selection: { anchor: from + cursor },
  });
}

/** The text of the line of "/name", without it. */
function lineWithout(state: EditorState, from: number, to: number) {
  const line = state.doc.lineAt(from);
  return { line, before: line.text.slice(0, from - line.from), after: line.text.slice(to - line.from) };
}

/** The line of "/name", without it, starting with `prefix` ("# ", "> "), the cursor at its end. */
function linePrefix(prefix: string, old: RegExp) {
  return (state: EditorState, from: number, to: number): TransactionSpec => {
    const { line, before, after } = lineWithout(state, from, to);
    const insert = prefix + `${before.trimEnd()}${before.trim() && after.trim() ? " " : ""}${after.trimStart()}`.replace(old, "").trimStart();
    return { changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length } };
  };
}
const heading = (level: number) => linePrefix(`${"#".repeat(level)} `, /^#{1,6}\s+/);

/** The line of "/name", without it, made a task with this status (the cursor where the text goes). */
function taskStatus(status: string) {
  return (state: EditorState, from: number, to: number): TransactionSpec => {
    const { line, before, after } = lineWithout(state, from, to);
    const rest = before.trimEnd() + after;
    const cfg = state.facet(taskConfigFacet);
    const edit = cycleLine(rest, cfg, status);
    if (!edit) return { changes: { from, to, insert: "" } };
    const text = applyLineEdit(rest, edit);
    // The cursor at the end of the task's text, ready to go on writing it.
    const cursor = edit.cursor ?? parseTask(text, cfg)?.textTo ?? text.length;
    return { changes: { from: line.from, to: line.to, insert: text }, selection: { anchor: line.from + cursor } };
  };
}

/** A block on lines of its own: on the line of "/name" when it is empty, otherwise on the next one. */
function block(text: string, cursor: number) {
  return (state: EditorState, from: number, to: number): TransactionSpec => {
    const { line, before, after } = lineWithout(state, from, to);
    if (!(before + after).trim()) return { changes: { from: line.from, to: line.to, insert: text }, selection: { anchor: line.from + cursor } };
    const insert = `\n${text}`;
    return {
      changes: [{ from, to, insert: "" }, { from: line.to, insert }],
      selection: { anchor: line.to - (to - from) + 1 + cursor },
    };
  };
}

/** The items for this note: the editor's, then the app's. */
export function slashItems(state: EditorState, now = new Date()): SlashItem[] {
  const markdown = !state.facet(plainNotesFacet);
  const today = isoDate(now);
  const tomorrow = isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const time = `${p2(now.getHours())}:${p2(now.getMinutes())}`;
  const cfg = state.facet(taskConfigFacet);
  const items: SlashItem[] = [
    { name: "today", label: "Today's date", detail: today, keywords: "date day", edit: insertText(today) },
    { name: "tomorrow", label: "Tomorrow's date", detail: tomorrow, keywords: "date day", edit: insertText(tomorrow) },
    { name: "now", label: "Time", detail: time, keywords: "time hour clock", edit: insertText(time) },
    ...cfg.cycle.map((s) => ({ name: s, label: `Task · ${s}`, detail: `- … - ${s}`, keywords: "task status", edit: taskStatus(s) })),
    { name: "h1", label: "Heading 1", detail: "# ", keywords: "title heading", edit: heading(1) },
    { name: "h2", label: "Heading 2", detail: "## ", keywords: "title heading", edit: heading(2) },
    { name: "h3", label: "Heading 3", detail: "### ", keywords: "title heading", edit: heading(3) },
    { name: "code", label: "Code block", detail: "```", keywords: "fence snippet", edit: block("```\n\n```", 4) },
    { name: "divider", label: "Divider line", detail: "---", keywords: "separator rule hr line", edit: block("---\n", 4) },
  ];
  if (markdown) {
    const table = "| Column | Column |\n| --- | --- |\n|  |  |";
    items.push({ name: "table", label: "Table", detail: "| a | b |", keywords: "grid columns", edit: block(table, 2) });
    items.push({ name: "quote", label: "Quote", detail: "> ", keywords: "citation blockquote", edit: linePrefix("> ", /^>\s?/) });
  }
  return [...items, ...hostItems(state)];
}

/** The items matching what is typed after "/". */
function matching(state: EditorState, s: SlashState): SlashItem[] {
  const query = state.sliceDoc(s.from + 1, state.selection.main.head);
  return fuzzyFilter(query, slashItems(state), (it) => `${it.name} ${it.label} ${it.keywords ?? ""}`, 50).map((r) => r.item);
}

/** The menu, when it is open: where its "/" is, what is typed after it, the items offered and the chosen one. */
export function slashMenu(state: EditorState): { from: number; query: string; items: SlashItem[]; selected: number } | null {
  const s = state.field(slashField, false);
  if (!s) return null;
  const items = matching(state, s);
  return { from: s.from, query: state.sliceDoc(s.from + 1, state.selection.main.head), items, selected: Math.min(s.selected, items.length - 1) };
}

/** "/" just typed where a quick insert can start: at the start of a line or after a space, in a note. */
function typedSlash(tr: Transaction): number | null {
  if (!tr.docChanged || !tr.isUserEvent("input.type") || tr.state.selection.ranges.length > 1) return null;
  if (tr.state.facet(codeDocFacet)) return null;
  let at: number | null = null;
  let count = 0;
  tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    count++;
    if (fromA === toA && inserted.toString() === "/") at = fromB;
  });
  if (count !== 1 || at == null) return null;
  const before = tr.state.sliceDoc(Math.max(0, at - 1), at);
  return at === tr.state.doc.lineAt(at).from || /[\s(]/.test(before) ? at : null;
}

const slashField = StateField.define<SlashState | null>({
  create: () => null,
  update(value, tr) {
    let opened: number | null = null;
    for (const e of tr.effects) {
      if (e.is(closeMenu)) return null;
      if (e.is(openMenu)) opened = e.value;
      if (e.is(selectItem) && value) value = { ...value, selected: e.value, moved: true };
    }
    if (opened == null && !value) opened = typedSlash(tr);
    if (opened != null) return { from: opened, selected: 0, moved: false, tooltip: tooltipAt(opened) };
    if (!value) return null;
    if (tr.docChanged) {
      const from = tr.changes.mapPos(value.from, 1);
      if (from !== value.from) value = { ...value, from, tooltip: tooltipAt(from) };
      if (tr.state.sliceDoc(from, from + 1) !== "/") return null;
      value = { ...value, selected: 0, moved: false };
    }
    const head = tr.state.selection.main.head;
    const query = tr.state.sliceDoc(value.from + 1, Math.max(value.from + 1, head));
    if (head <= value.from || head > tr.state.doc.lineAt(value.from).to || /[\s/]/.test(query) || query.length > 30) return null;
    return value;
  },
  provide: (f) => showTooltip.from(f, (v) => v?.tooltip ?? null),
});

function tooltipAt(pos: number): Tooltip {
  return { pos, above: false, create: (view) => new SlashMenu(view) };
}

/** Picks an item: "/name" goes, the item does its job. */
function pick(view: EditorView, item: SlashItem) {
  const s = view.state.field(slashField, false);
  if (!s) return;
  const from = s.from;
  const to = view.state.selection.main.head;
  const spec = item.edit ? item.edit(view.state, from, to) : { changes: { from, to, insert: "" }, selection: { anchor: from } };
  view.dispatch({ ...spec, effects: closeMenu.of(null), userEvent: "input.complete", scrollIntoView: true });
  item.run?.(view);
}

class SlashMenu implements TooltipView {
  readonly dom = document.createElement("div");
  private shown = "";

  constructor(private view: EditorView) {
    this.dom.className = "kn-slash";
    this.dom.setAttribute("role", "listbox");
    // The editor keeps the focus: a click picks without moving the cursor.
    this.dom.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
      if (!row) return;
      const s = this.view.state.field(slashField, false);
      const item = s && matching(this.view.state, s)[Number(row.dataset.index)];
      if (item) pick(this.view, item);
    });
    this.render();
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.startState.field(slashField, false) !== u.state.field(slashField, false)) this.render();
  }

  private render() {
    const s = this.view.state.field(slashField, false);
    if (!s) return;
    const items = matching(this.view.state, s);
    const selected = Math.min(s.selected, items.length - 1);
    const key = `${selected}|${items.map((i) => `${i.name}:${i.detail ?? ""}`).join(",")}`;
    if (key === this.shown) return;
    this.shown = key;
    // Nothing matches: the menu stays out of the way (typing goes on as usual).
    this.dom.hidden = !items.length;
    this.dom.replaceChildren(
      ...items.map((it, i) => {
        const row = document.createElement("div");
        row.className = i === selected ? "kn-slash-item selected" : "kn-slash-item";
        row.dataset.index = String(i);
        row.setAttribute("role", "option");
        const name = row.appendChild(document.createElement("span"));
        name.className = "kn-slash-name";
        name.textContent = `/${it.name}`;
        const label = row.appendChild(document.createElement("span"));
        label.className = "kn-slash-label";
        label.textContent = it.label;
        if (it.detail) {
          const detail = row.appendChild(document.createElement("span"));
          detail.className = "kn-slash-detail";
          detail.textContent = it.detail;
        }
        return row;
      }),
    );
    this.dom.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }
}

function moveSelection(by: number) {
  return (view: EditorView): boolean => {
    const s = view.state.field(slashField, false);
    if (!s) return false;
    const n = matching(view.state, s).length;
    if (!n) return false;
    view.dispatch({ effects: selectItem.of((Math.min(s.selected, n - 1) + by + n) % n) });
    return true;
  };
}

function pickSelected(requireChoice: boolean) {
  return (view: EditorView): boolean => {
    const s = view.state.field(slashField, false);
    if (!s) return false;
    const items = matching(view.state, s);
    const typed = view.state.selection.main.head > s.from + 1;
    if (!items.length || (requireChoice && !typed && !s.moved)) {
      // "/" alone and Enter: a new line, as usual.
      view.dispatch({ effects: closeMenu.of(null) });
      return false;
    }
    pick(view, items[Math.min(s.selected, items.length - 1)]);
    return true;
  };
}

const slashKeys = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: moveSelection(1) },
    { key: "ArrowUp", run: moveSelection(-1) },
    { key: "Enter", run: pickSelected(true) },
    { key: "Tab", run: pickSelected(false) },
    {
      key: "Escape",
      run: (view) => {
        if (!view.state.field(slashField, false)) return false;
        view.dispatch({ effects: closeMenu.of(null) });
        return true;
      },
    },
  ]),
);

/** The editor lost the focus (another window, a dialog): the menu closes. */
const closeOnBlur = EditorView.domEventHandlers({
  blur(_e, view) {
    if (!view.state.field(slashField, false)) return;
    setTimeout(() => {
      if (view.state.field(slashField, false) && !view.hasFocus) view.dispatch({ effects: closeMenu.of(null) });
    });
  },
});

/** Quick inserts after "/" (the `slash_commands` setting), in notes only. */
export function slashCommands(on: boolean): Extension {
  return on ? [slashField, slashKeys, closeOnBlur] : [];
}

/** Opens the menu at the cursor, as if "/" had been typed (tests, and the command). */
export function openSlashMenu(view: EditorView): boolean {
  const head = view.state.selection.main.head;
  view.dispatch({ changes: { from: head, insert: "/" }, selection: { anchor: head + 1 }, effects: openMenu.of(head) });
  return true;
}
