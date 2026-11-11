// @vitest-environment happy-dom
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import { makeTaskConfig } from "../text/tasks";
import { codeDocFacet, taskConfigFacet } from "./decorations";
import { landmarks, scrollbarMarks } from "./ruler";

const cfg = makeTaskConfig({
  statuses: DEFAULT_SETTINGS.task_statuses, cycle: DEFAULT_SETTINGS.task_cycle, done: DEFAULT_SETTINGS.task_done_statuses,
  ongoing: DEFAULT_SETTINGS.task_ongoing_statuses, archiveStatus: "done", archiveDate: true,
});
const NOTE = "# Work\n- call the bank - todo\n- send the report - done\n```\n# not a heading\n- not a task - todo\n```\n## Later\nplain - ongoing\n";

describe("the marks along the scrollbar", () => {
  it("outline the headings and the tasks not done yet, outside code blocks", () => {
    const marks = landmarks(Text.of(NOTE.split("\n")), cfg).map((l) => [NOTE.slice(l.pos, NOTE.indexOf("\n", l.pos)), l.kind]);
    expect(marks).toEqual([
      ["# Work", "heading"],
      ["- call the bank - todo", "task"],
      ["## Later", "heading"],
      ["plain - ongoing", "task"],
    ]);
  });

  it("are drawn for notes, not for code", async () => {
    const view = (code: boolean) =>
      new EditorView({
        state: EditorState.create({ doc: NOTE, extensions: [taskConfigFacet.of(cfg), codeDocFacet.of(code), scrollbarMarks(true)] }),
        parent: document.body,
      });
    const note = view(false);
    const code = view(true);
    // (Read once the note is shown, drawn in the next frame. No layout here: every
    // mark is at the same height, one per kind and color.)
    await vi.waitFor(() => expect(new Set([...note.dom.querySelectorAll(".cm-ruler i")].map((i) => i.className))).toEqual(new Set(["heading", "task"])));
    expect(code.dom.querySelectorAll(".cm-ruler i")).toHaveLength(0);
    note.destroy();
    code.destroy();
  });
});
