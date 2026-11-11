// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import { findTasks, makeTaskConfig } from "../text/tasks";
import { boardColumns, cardText } from "./board";

describe("the task board", () => {
  it("has one column per status, the cycle first", () => {
    expect(boardColumns(["done", "blocked", "todo", "ongoing"], ["todo", "ongoing", "done"])).toEqual(["todo", "ongoing", "done", "blocked"]);
  });

  it("shows the text of a task, without its markup and due date", () => {
    const cfg = makeTaskConfig({
      statuses: DEFAULT_SETTINGS.task_statuses, cycle: DEFAULT_SETTINGS.task_cycle, done: DEFAULT_SETTINGS.task_done_statuses,
      archiveStatus: "done", archiveDate: true,
    });
    const [t] = findTasks("- call **the bank** about `x` @2026-11-20 - todo", cfg);
    expect(cardText(t)).toBe("call the bank about x");
  });
});
