// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { markdownTooDeep } from "../editor/markdown-language";
import { DEFAULT_SETTINGS } from "../core/settings";
import { renderMarkdown } from "../ui/views/markdown-render";
import { MAX_MARKDOWN_DEPTH, markdownNestingBound } from "./markdown-guard";
import { makeTaskConfig } from "./tasks";

const BOMBS: Record<string, string> = {
  "lists on one line": " - ".repeat(20_000) + "x",
  "indented lists": Array.from({ length: 1_500 }, (_, i) => " ".repeat(i) + "- x").join("\n"),
  "quotes": ">".repeat(20_000) + " x",
  "emphasis": "*a ".repeat(10_000) + "x" + " a*".repeat(10_000),
  "emphasis over lines": "*a\n".repeat(10_000) + "x\n" + "a*\n".repeat(10_000),
};

describe("Markdown nested deeper than real notes", () => {
  it("crafted notes are caught", () => {
    for (const [name, text] of Object.entries(BOMBS)) expect(markdownTooDeep(text), name).toBe(true);
  });

  it("real notes pass, most of them without being parsed", () => {
    const note = "# Plan\n\n- **one** with `code` and [a link](https://x.com)\n  - nested *two*\n> quote\n\n| a | b |\n|---|---|\n";
    expect(markdownNestingBound(note)).toBeLessThan(20);
    expect(markdownTooDeep(note)).toBe(false);
    // A long list full of marks: parsed to make sure, and fine.
    const list = Array.from({ length: 3_000 }, (_, i) => `- **item ${i}** with [link](https://x.com) and \`code\` - todo`).join("\n");
    expect(markdownNestingBound(list)).toBeGreaterThan(MAX_MARKDOWN_DEPTH);
    expect(markdownTooDeep(list)).toBe(false);
    expect(markdownTooDeep("-".repeat(500))).toBe(false);
  });

  it("the preview never runs out of stack on what it can parse", () => {
    const taskCfg = makeTaskConfig({ statuses: DEFAULT_SETTINGS.task_statuses, cycle: DEFAULT_SETTINGS.task_cycle, done: DEFAULT_SETTINGS.task_done_statuses, archiveStatus: "done", archiveDate: true });
    const deep = Array.from({ length: 1_000 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n");
    expect(() => renderMarkdown(deep, { taskCfg })).not.toThrow();
    expect(() => renderMarkdown(">".repeat(3_000) + " x", { taskCfg })).not.toThrow();
  });
});
