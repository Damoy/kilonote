import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import { contextHints, type HintContext } from "./hints";
import { makeTaskConfig } from "./tasks";

const cfg = makeTaskConfig({
  statuses: DEFAULT_SETTINGS.task_statuses, cycle: DEFAULT_SETTINGS.task_cycle, done: DEFAULT_SETTINGS.task_done_statuses,
  archiveStatus: "done", archiveDate: true,
});
const ctx = (over: Partial<HintContext>): HintContext => ({
  lang: "text", path: "/notes/work.txt", archive: false, text: "", line: "", lineNumber: 1, selection: null, occurrences: null,
  notes: [], tabs: 3, previewOpen: false, cfg, today: "2026-11-11", key: (id) => `<${id}>`, ...over,
});
const ids = (c: HintContext) => contextHints(c).map((h) => h.id);

describe("Kilo's hints", () => {
  it("offer to encrypt a private line, and only that", () => {
    for (const line of ["ssh root@10.1.2.3 password: hunter2", "mdp = Azerty123", "api_key: abcd1234efgh", "Authorization: Bearer abcdefghijklmnop1234"]) {
      expect(ids(ctx({ line, text: line })), line).toContain("secret-line");
    }
    for (const line of ["Change the password policy next week", "token ring network", "-----BEGIN KILONOTE SECRET-----"]) {
      expect(ids(ctx({ line, text: line })), line).not.toContain("secret-line");
    }
    const hint = contextHints(ctx({ line: "pwd: s3cret!" }))[0];
    expect(hint.action).toEqual({ label: "Encrypt this line", command: "edit.encrypt", selectLine: true });
  });

  it("see a list item that could be a task, and a date that could be its due date", () => {
    expect(ids(ctx({ line: "- call the bank" }))).toContain("make-task");
    expect(ids(ctx({ line: "- call the bank - todo" }))).not.toContain("make-task");
    expect(ids(ctx({ line: "- see https://example.com" }))).not.toContain("make-task");
    const due = contextHints(ctx({ line: "- send the report on 14/11/2026 - todo" })).find((h) => h.id === "date-as-due");
    expect(due?.action).toEqual({ label: "Due on 2026-11-14", due: "2026-11-14" });
    expect(ids(ctx({ line: "- send the report @2026-11-14 - todo" }))).not.toContain("date-as-due");
    // Not in a _done archive, nor in code.
    expect(ids(ctx({ line: "- call the bank", archive: true }))).not.toContain("make-task");
    expect(ids(ctx({ line: "- call the bank", lang: "python" }))).not.toContain("make-task");
  });

  it("suggest a link to another note named on the line", () => {
    expect(contextHints(ctx({ line: "see the notes_dev file", notes: ["notes_dev", "dev"] })).find((h) => h.id === "link-note")?.text).toContain("[[notes_dev]]");
    expect(ids(ctx({ line: "see [[notes_dev]]", notes: ["notes_dev"] }))).not.toContain("link-note");
    expect(ids(ctx({ line: "developer notes_devices", notes: ["notes_dev"] }))).not.toContain("link-note");
  });

  it("read the note: late tasks, done tasks to archive, a long note without headings", () => {
    const tasks = ["- a @2026-11-01 - todo", ...Array.from({ length: 5 }, (_, i) => `- d${i} - done`)].join("\n");
    expect(ids(ctx({ text: tasks }))).toEqual(expect.arrayContaining(["overdue", "archive-done"]));
    expect(ids(ctx({ text: tasks, path: null }))).not.toContain("archive-done");
    expect(ids(ctx({ text: Array.from({ length: 90 }, (_, i) => `line ${i}`).join("\n") }))).toContain("add-headings");
    expect(ids(ctx({ text: "# Title\n" + Array.from({ length: 90 }, (_, i) => `line ${i}`).join("\n") }))).not.toContain("add-headings");
  });

  it("know the other kinds of documents and the app around", () => {
    expect(ids(ctx({ lang: "markdown", text: "# A\n".repeat(100) }))).toContain("md-preview");
    expect(ids(ctx({ lang: "markdown", text: "# A\n".repeat(100), previewOpen: true }))).not.toContain("md-preview");
    expect(ids(ctx({ lang: "json", line: `{"a":"${"x".repeat(250)}"}` }))).toContain("format-json");
    expect(ids(ctx({ path: null, text: "x\n".repeat(20) }))).toContain("save-draft");
    expect(ids(ctx({ tabs: 20 }))).toContain("many-tabs");
    expect(ids(ctx({ selection: "abc", occurrences: 3 }))).toContain("occurrences");
    expect(ids(ctx({ selection: "abc", occurrences: 1 }))).not.toContain("occurrences");
  });
});
