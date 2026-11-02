import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "./fuzzy";
import { parseJsonc } from "./jsonc";
import { basename, dirname, doneFileFor, isDoneFile, join, projectName, relative } from "./path";
import { DEFAULT_SETTINGS, mergeSettings, setSettingInText, SETTINGS_TEMPLATE } from "./settings";
import { findTheme } from "./themes";

describe("paths", () => {
  it("handles Unix and Windows paths", () => {
    expect(basename("/a/b/mc.txt")).toBe("mc.txt");
    expect(basename("C:\\notes\\mc.txt")).toBe("mc.txt");
    expect(dirname("C:\\notes\\mc.txt")).toBe("C:\\notes");
    expect(join("C:\\notes", "mc.txt")).toBe("C:\\notes\\mc.txt");
    expect(join("/notes/", "mc.txt")).toBe("/notes/mc.txt");
    expect(relative("C:\\notes", "C:\\Notes\\pro\\mc.txt")).toBe("pro\\mc.txt");
  });

  it("computes the archive file", () => {
    expect(doneFileFor("/n/mc.txt", "_done")).toBe("/n/mc_done.txt");
    expect(doneFileFor("C:\\n\\Project.MD", "_done")).toBe("C:\\n\\Project_done.MD");
    expect(doneFileFor("/n/no-extension", "_done")).toBe("/n/no-extension_done");
    expect(isDoneFile("/n/mc_done.txt", "_done")).toBe(true);
    expect(isDoneFile("/n/mc.txt", "_done")).toBe(false);
    expect(projectName("/n/mc_done.txt", "_done")).toBe("mc");
  });

  it("does not mix up /Notes and /Notes2", () => {
    expect(relative("/Notes", "/Notes")).toBe("");
    expect(relative("/Notes/", "/Notes/a/b.txt")).toBe("a/b.txt");
    expect(relative("/Notes", "/Notes2/b.txt")).toBe("/Notes2/b.txt");
  });
});

describe("settings", () => {
  it("the commented template is valid", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("midnight");
    expect(DEFAULT_SETTINGS.task_cycle).toEqual(["todo", "ongoing", "done"]);
  });

  it("merges leniently", () => {
    const s = mergeSettings({ font_size: 200, theme: 3 as unknown as string, keybindings: { "Ctrl+K": "x" } });
    expect(s.font_size).toBe(40);
    expect(s.theme).toBe("midnight");
    expect(s.keybindings["Ctrl+K"]).toBe("x");
  });

  it("JSONC: comments, trailing commas, // inside strings", () => {
    expect(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }')).toEqual({ a: "http://x", b: [1, 2] });
  });

  it("changes a value without losing the comments", () => {
    const out = setSettingInText(SETTINGS_TEMPLATE, "theme", "paper");
    expect(out).toContain('"theme": "paper"');
    expect(out).toContain("// KiloNote settings");
    const added = setSettingInText('{\n  "a": 1\n}', "font_size", 16);
    expect(parseJsonc(added)).toEqual({ a: 1, font_size: 16 });
  });
});

describe("themes", () => {
  it("still accepts the former theme ids", () => {
    expect(findTheme("minuit", true).id).toBe("midnight");
    expect(findTheme("papier", true).id).toBe("paper");
    expect(findTheme("auto", false).id).toBe("paper");
    expect(findTheme("unknown", false).id).toBe("midnight");
  });
});

describe("fuzzy search", () => {
  it("matches subsequences and favors the file name", () => {
    expect(fuzzyMatch("mcd", "projects/mc_done.txt")).not.toBeNull();
    expect(fuzzyMatch("xyz", "mc.txt")).toBeNull();
    const a = fuzzyMatch("mc", "clients/mc.txt")!.score;
    const b = fuzzyMatch("mc", "my-clients/notes.txt")!.score;
    expect(a).toBeGreaterThan(b);
    expect(fuzzyMatch("ete", "Été.txt")).not.toBeNull();
  });
});

describe("shortcuts", () => {
  it("normalizes key combinations (French key names too)", async () => {
    const { normalizeCombo, setPlatform } = await import("./commands");
    setPlatform("windows");
    expect(normalizeCombo("mod+shift+p")).toBe("Ctrl+Shift+P");
    expect(normalizeCombo("Ctrl+Maj+Entrée")).toBe("Ctrl+Shift+Enter");
    expect(normalizeCombo("Mod++")).toBe("Ctrl++");
    setPlatform("macos");
    expect(normalizeCombo("Mod+,")).toBe("Meta+,");
  });
});
