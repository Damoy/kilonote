// @vitest-environment happy-dom
import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import { makeTaskConfig } from "../text/tasks";
import { isoDate } from "../text/templates";
import { codeDocFacet, plainNotesFacet, taskConfigFacet } from "./decorations";
import { closeSlashMenu, setSlashHost, slashCommands, slashMenu } from "./slash";

const taskCfg = makeTaskConfig({
  statuses: DEFAULT_SETTINGS.task_statuses, cycle: DEFAULT_SETTINGS.task_cycle, done: DEFAULT_SETTINGS.task_done_statuses,
  archiveStatus: "done", archiveDate: true,
});

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  setSlashHost(() => []);
});

function editor(doc = "", opts: { markdown?: boolean; code?: boolean; on?: boolean; cfg?: typeof taskCfg } = {}) {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        taskConfigFacet.of(opts.cfg ?? taskCfg),
        plainNotesFacet.of(!opts.markdown),
        codeDocFacet.of(!!opts.code),
        slashCommands(opts.on ?? true),
        keymap.of(defaultKeymap),
      ],
    }),
  });
  return view;
}

/** Types like the keyboard does (one character at a time, at the cursor). */
function type(v: EditorView, text: string) {
  for (const ch of text) {
    const at = v.state.selection.main.head;
    v.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 }, userEvent: "input.type" });
  }
}

const press = (v: EditorView, key: string) => runScopeHandlers(v, new KeyboardEvent("keydown", { key }), "editor");
const text = (v: EditorView) => v.state.doc.toString();
const names = (v: EditorView) => slashMenu(v.state)?.items.map((i) => i.name) ?? null;

describe("quick inserts after /", () => {
  it("open at the start of a line or after a space, and filter as you type", () => {
    const v = editor("");
    type(v, "/");
    expect(names(v)).toContain("today");
    type(v, "tod");
    expect(names(v)![0]).toBe("today");
    type(v, "o");
    expect(names(v)![0]).toBe("todo");
    const w = editor("call ");
    type(w, "/");
    expect(slashMenu(w.state)).not.toBeNull();
  });

  it("never get in the way: inside a word, in a path, after a space, in code", () => {
    const v = editor("and");
    type(v, "/or");
    expect(slashMenu(v.state)).toBeNull();
    const path = editor("");
    type(path, "/home");
    expect(slashMenu(path.state)).not.toBeNull();
    type(path, "/user");
    expect(slashMenu(path.state)).toBeNull();
    expect(text(path)).toBe("/home/user");
    const spaced = editor("");
    type(spaced, "/to day");
    expect(slashMenu(spaced.state)).toBeNull();
    const code = editor("", { code: true });
    type(code, "/");
    expect(slashMenu(code.state)).toBeNull();
    const off = editor("", { on: false });
    type(off, "/");
    expect(slashMenu(off.state)).toBeNull();
  });

  it("Enter inserts the item in place of what was typed", () => {
    const v = editor("Due ");
    type(v, "/today");
    expect(press(v, "Enter")).toBe(true);
    expect(text(v)).toBe(`Due ${isoDate(new Date())}`);
    expect(slashMenu(v.state)).toBeNull();
  });

  it("makes the line a task, the cursor at the end of its text", () => {
    const v = editor("- buy milk ");
    type(v, "/todo");
    press(v, "Enter");
    expect(text(v)).toBe("- buy milk - todo");
    expect(v.state.selection.main.head).toBe("- buy milk".length);
    const empty = editor("");
    type(empty, "/ongoing");
    press(empty, "Tab");
    expect(text(empty)).toBe("-  - ongoing");
    expect(empty.state.selection.main.head).toBe(2);
  });

  it("makes headings, blocks and tables (tables in Markdown only)", () => {
    const v = editor("Plan ");
    type(v, "/h2");
    press(v, "Enter");
    expect(text(v)).toBe("## Plan");
    const code = editor("");
    type(code, "/code");
    press(code, "Enter");
    expect(text(code)).toBe("```\n\n```");
    expect(code.state.selection.main.head).toBe(4);
    const plain = editor("");
    type(plain, "/table");
    expect(names(plain)).not.toContain("table");
    const md = editor("", { markdown: true });
    type(md, "/table");
    press(md, "Enter");
    expect(text(md)).toBe("| Column | Column |\n| --- | --- |\n|  |  |");
  });

  it("arrows choose, Escape closes, Enter alone makes a new line", () => {
    const v = editor("");
    type(v, "/");
    const [, second] = slashMenu(v.state)!.items;
    press(v, "ArrowDown");
    expect(slashMenu(v.state)!.selected).toBe(1);
    press(v, "Enter");
    expect(text(v)).not.toBe("/");
    expect(second.name).toBe("tomorrow");
    const esc = editor("");
    type(esc, "/to");
    expect(press(esc, "Escape")).toBe(true);
    expect(slashMenu(esc.state)).toBeNull();
    expect(text(esc)).toBe("/to");
    const enter = editor("x ");
    type(enter, "/");
    press(enter, "Enter");
    expect(text(enter)).toBe("x /\n");
  });

  it("offers the app's items, which run once /name is gone", () => {
    const run = vi.fn();
    setSlashHost(() => [
      { name: "link", label: "Link to a note…", run },
      { name: "due", label: "Due date…", run, wholeLine: true },
    ]);
    const v = editor("see ");
    type(v, "/lin");
    press(v, "Enter");
    expect(text(v)).toBe("see ");
    expect(run).toHaveBeenCalledOnce();
    // An item for the whole line takes the space typed before "/" too.
    const due = editor("- send it - todo ");
    type(due, "/due");
    press(due, "Enter");
    expect(text(due)).toBe("- send it - todo");
  });

  it("a status with a space is typed with a dash", () => {
    const cfg = makeTaskConfig({ statuses: { todo: "blue", "in progress": "orange", done: "green" }, cycle: ["todo", "in progress", "done"], done: ["done"], archiveStatus: "done", archiveDate: false });
    const v = editor("write it ", { cfg });
    type(v, "/in-pro");
    expect(names(v)![0]).toBe("in-progress");
    press(v, "Enter");
    expect(text(v)).toBe("- write it - in progress");
  });

  it("a menu with nothing to offer lets Escape through, and closes", () => {
    const v = editor("");
    type(v, "/zzzz");
    expect(slashMenu(v.state)?.items).toEqual([]);
    expect(press(v, "Escape")).toBe(false);
    expect(slashMenu(v.state)).toBeNull();
  });

  it("closes for good when the note is left", () => {
    const v = editor("");
    type(v, "/to");
    closeSlashMenu(v);
    expect(slashMenu(v.state)).toBeNull();
    expect(text(v)).toBe("/to");
  });
});
