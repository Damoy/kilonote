import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../core/settings";
import {
  applyLineEdit, archivedLine, cycleLine, dueState, findDateInLine, findTags, findTasks, makeTaskConfig, nextStatus, parseDateInput,
  parseTask, setDueInLine,
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
    expect(cycle("# Work")).toBeNull();
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
    const found = findTasks("# Work\r\n- a - todo\r\nnote\r\n- b - ongoing\n", cfg);
    expect(found.map((f) => [f.line, f.task.key])).toEqual([[2, "todo"], [4, "ongoing"]]);
  });

  it("finds ISO and day/month/year dates", () => {
    expect(findDateInLine("- x - done [2026-02-03]")).toBe("2026-02-03");
    expect(findDateInLine("meeting on 4/11/2026")).toBe("2026-11-04");
    expect(findDateInLine("nothing")).toBeNull();
  });
});

describe("due dates", () => {
  const setDue = (line: string, due: string | null) => {
    const edit = setDueInLine(line, cfg, due);
    return edit ? applyLineEdit(line, edit) : null;
  };

  it("are read from the task text", () => {
    expect(parseTask("- send the report @2026-11-14 - todo", cfg)?.due).toBe("2026-11-14");
    expect(parseTask("- send the report - todo", cfg)?.due).toBeNull();
    expect(parseTask("- mail bob@2026-11-14.com - todo", cfg)?.due).toBeNull();
  });

  it("are set, changed and removed", () => {
    expect(setDue("- send the report - todo", "2026-11-14")).toBe("- send the report @2026-11-14 - todo");
    expect(setDue("- send @2026-11-14 the report - todo", "2026-12-01")).toBe("- send @2026-12-01 the report - todo");
    expect(setDue("- send the report @2026-11-14 - todo", null)).toBe("- send the report - todo");
    expect(setDue("- @2026-11-14 send - todo", null)).toBe("- send - todo");
    expect(setDue("not a task", "2026-11-14")).toBeNull();
  });

  it("know when they are overdue", () => {
    expect(dueState("2026-11-01", "2026-11-07")).toBe("overdue");
    expect(dueState("2026-11-07", "2026-11-07")).toBe("today");
    expect(dueState("2026-11-10", "2026-11-07")).toBe("soon");
    expect(dueState("2026-11-20", "2026-11-07")).toBe("later");
  });

  it("are typed in several ways", () => {
    const today = new Date(2026, 10, 7);
    expect(parseDateInput("2026-12-01", today)).toBe("2026-12-01");
    expect(parseDateInput("1/12/2026", today)).toBe("2026-12-01");
    expect(parseDateInput("14/11", today)).toBe("2026-11-14");
    expect(parseDateInput("3/1", today)).toBe("2027-01-03");
    expect(parseDateInput("+3", today)).toBe("2026-11-10");
    expect(parseDateInput("2w", today)).toBe("2026-11-21");
    expect(parseDateInput("31/02/2026", today)).toBeNull();
    expect(parseDateInput("soon", today)).toBeNull();
  });
});

describe("tags", () => {
  it("are found in lowercase, once", () => {
    expect(findTags("fix #Bug for #acme and #bug (#v2/api)")).toEqual(["#bug", "#acme", "#v2/api"]);
    expect(findTags("issue#3 is not a tag")).toEqual([]);
  });
});
