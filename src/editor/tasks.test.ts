import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import {
  applyLineEdit, archivedLine, cycleLine, findDateInLine, findTasks, makeTaskConfig, nextStatus, parseTask,
} from "./tasks";

const cfg = makeTaskConfig({
  statuses: DEFAULT_SETTINGS.task_statuses,
  cycle: DEFAULT_SETTINGS.task_cycle,
  done: DEFAULT_SETTINGS.task_done_statuses,
  archiveStatus: "done",
  archiveDate: true,
});

const cycle = (line: string, target?: string) => {
  const edit = cycleLine(line, cfg, target);
  return edit ? applyLineEdit(line, edit) : null;
};

describe("parseTask", () => {
  it("recognizes the basic format", () => {
    const t = parseTask("- call colleague X - todo", cfg)!;
    expect(t.text).toBe("call colleague X");
    expect(t.key).toBe("todo");
    expect(t.bullet).toBe("- ");
  });

  it("handles dashes in the text, case, indentation and the date stamp", () => {
    const t = parseTask("    * review A - B - ONGOING [2026-03-04] ", cfg)!;
    expect(t.text).toBe("review A - B");
    expect(t.key).toBe("ongoing");
    expect(t.indent).toBe("    ");
    expect(t.date).toBe("2026-03-04");
  });

  it("accepts a line without bullet and a long dash", () => {
    expect(parseTask("Call Paul — ok", cfg)?.key).toBe("ok");
  });

  it("ignores lines that are not tasks", () => {
    expect(parseTask("- call X", cfg)).toBeNull();
    expect(parseTask("- todo", cfg)).toBeNull();
    expect(parseTask("- call X - todos", cfg)).toBeNull();
    expect(parseTask("todo", cfg)).toBeNull();
  });
});

describe("cycleLine", () => {
  it("cycles through the statuses", () => {
    expect(cycle("- call X - todo")).toBe("- call X - ongoing");
    expect(cycle("- call X - ongoing")).toBe("- call X - done");
    expect(cycle("- call X - done")).toBe("- call X - todo");
    expect(cycle("- call X - blocked")).toBe("- call X - todo");
  });

  it("turns a line into a task", () => {
    expect(cycle("- call X")).toBe("- call X - todo");
    expect(cycle("call X  ")).toBe("- call X - todo");
    expect(cycle("  1. call X")).toBe("  1. call X - todo");
  });

  it("prepares an empty task on an empty line", () => {
    const edit = cycleLine("", cfg)!;
    expect(applyLineEdit("", edit)).toBe("-  - todo");
    expect(edit.cursor).toBe(2);
  });

  it("leaves headings alone", () => {
    expect(cycle("# Project MC")).toBeNull();
  });

  it("forces a given status", () => {
    expect(cycle("- call X - todo", "done")).toBe("- call X - done");
    expect(cycle("- call X", "ongoing")).toBe("- call X - ongoing");
  });

  it("nextStatus follows the configured cycle", () => {
    expect(nextStatus(null, cfg)).toBe("todo");
    expect(nextStatus("TODO", cfg)).toBe("ongoing");
  });
});

describe("archivedLine", () => {
  it("marks the task done and appends the date", () => {
    expect(archivedLine("  - call X - ongoing", cfg, "2026-11-02")).toBe("- call X - done [2026-11-02]");
  });

  it("keeps a status that is already completed (ok) and an existing stamp", () => {
    expect(archivedLine("- call X - ok", cfg, "2026-11-02")).toBe("- call X - ok [2026-11-02]");
    expect(archivedLine("- call X - done [2025-01-01]", cfg, "2026-11-02")).toBe("- call X - done [2025-01-01]");
  });

  it("archives a plain line too", () => {
    expect(archivedLine("call X", cfg, "2026-11-02")).toBe("- call X - done [2026-11-02]");
  });

  it("omits the date when disabled", () => {
    const noDate = { ...cfg, archiveDate: false };
    expect(archivedLine("- call X - todo", noDate)).toBe("- call X - done");
  });
});

describe("findTasks / dates", () => {
  it("lists the tasks of a text", () => {
    const found = findTasks("# MC\r\n- a - todo\r\nnote\r\n- b - ongoing\n", cfg);
    expect(found.map((f) => [f.line, f.task.key])).toEqual([[2, "todo"], [4, "ongoing"]]);
  });

  it("finds ISO and day/month/year dates", () => {
    expect(findDateInLine("- x - done [2026-02-03]")).toBe("2026-02-03");
    expect(findDateInLine("meeting on 4/11/2026")).toBe("2026-11-04");
    expect(findDateInLine("nothing")).toBeNull();
  });
});
