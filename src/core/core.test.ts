import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "./fuzzy";
import { parseJsonc } from "./jsonc";
import { basename, dirname, doneFileFor, isDoneFile, join, projectName, relative } from "./path";
import { DEFAULT_SETTINGS, mergeSettings, setSettingInText, SETTINGS_TEMPLATE } from "./settings";
import { findTheme } from "./themes";

describe("paths", () => {
  it("handles Unix and Windows paths", () => {
    expect(basename("/a/b/work.txt")).toBe("work.txt");
    expect(basename("C:\\notes\\work.txt")).toBe("work.txt");
    expect(dirname("C:\\notes\\work.txt")).toBe("C:\\notes");
    expect(join("C:\\notes", "work.txt")).toBe("C:\\notes\\work.txt");
    expect(join("/notes/", "work.txt")).toBe("/notes/work.txt");
    expect(relative("C:\\notes", "C:\\Notes\\pro\\work.txt")).toBe("pro\\work.txt");
  });

  it("computes the archive file", () => {
    expect(doneFileFor("/n/work.txt", "_done")).toBe("/n/work_done.txt");
    expect(doneFileFor("C:\\n\\Project.MD", "_done")).toBe("C:\\n\\Project_done.MD");
    expect(doneFileFor("/n/no-extension", "_done")).toBe("/n/no-extension_done");
    expect(isDoneFile("/n/work_done.txt", "_done")).toBe(true);
    expect(isDoneFile("/n/work.txt", "_done")).toBe(false);
    expect(projectName("/n/work_done.txt", "_done")).toBe("work");
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

  it("replaces arrays and objects, never a key in a comment or a nested object", () => {
    const text = [
      "// settings",
      "{",
      '  // "theme": "old" (commented out)',
      '  "keybindings": { "theme": "x" },',
      '  "theme": "midnight", // mine',
      '  "note_extensions": ["txt",',
      '    "md"], /* trailing */',
      '  "task_statuses": {',
      '    "todo": "blue"',
      "  }",
      "}",
    ].join("\n");
    let out = setSettingInText(text, "theme", "paper");
    expect(out).toContain('// "theme": "old" (commented out)');
    expect(out).toContain('"keybindings": { "theme": "x" }');
    expect(out).toContain('"theme": "paper", // mine');
    out = setSettingInText(out, "note_extensions", ["txt", "md", "org"]);
    expect(out).toContain('"note_extensions": ["txt", "md", "org"], /* trailing */');
    const statuses = { todo: "blue", ongoing: "orange", blocked: "red", wait: "purple", done: "green", ok: "green" };
    out = setSettingInText(out, "task_statuses", statuses);
    expect(out).toContain('  "task_statuses": {\n    "todo": "blue",');
    expect(parseJsonc(out)).toEqual({ keybindings: { theme: "x" }, theme: "paper", note_extensions: ["txt", "md", "org"], task_statuses: statuses });
    // Every template key round-trips.
    let tpl = SETTINGS_TEMPLATE;
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) tpl = setSettingInText(tpl, k, v);
    expect(parseJsonc(tpl)).toEqual(DEFAULT_SETTINGS);
    expect(setSettingInText(SETTINGS_TEMPLATE, "task_cycle", ["todo", "done"])).toContain('"task_cycle": ["todo", "done"],');
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
    expect(fuzzyMatch("wkd", "projects/work_done.txt")).not.toBeNull();
    expect(fuzzyMatch("xyz", "work.txt")).toBeNull();
    const a = fuzzyMatch("wo", "clients/work.txt")!.score;
    const b = fuzzyMatch("wo", "worlds/notes.txt")!.score;
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

describe("languages", () => {
  it("are found by file name, then by extension", async () => {
    const { languageForPath, isCodeLang, fileKindFor } = await import("../editor/languages");
    expect(languageForPath("/x/Dockerfile")).toBe("dockerfile");
    expect(languageForPath("C:\\work\\CMakeLists.txt")).toBe("cmake");
    expect(languageForPath("/x/.env")).toBe("ini");
    expect(languageForPath("/x/build.PS1")).toBe("powershell");
    expect(languageForPath("/x/notes.txt")).toBe("text");
    expect(languageForPath("/x/notes")).toBe("text");
    expect(isCodeLang("python")).toBe(true);
    expect(isCodeLang("markdown")).toBe(false);
    expect(fileKindFor("/x/a.png")).toBe("image");
    expect(fileKindFor("/x/a.exe")).toBe("binary");
    expect(fileKindFor("/x/a.yml")).toBe("config");
  });

  it("every language loads", async () => {
    const { LANGUAGES } = await import("../editor/languages");
    for (const l of LANGUAGES) if (l.load) expect(typeof (await l.load()).token, l.id).toBe("function");
  });
});

describe("icon pack setting", () => {
  it("falls back to the default for an unknown pack", () => {
    expect(mergeSettings({ icon_pack: "nope" }).icon_pack).toBe("line");
    expect(mergeSettings({ icon_pack: "pixel" }).icon_pack).toBe("pixel");
  });
});

describe("readable themes", () => {
  const lum = (hex: string) => {
    const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  it("every theme meets the contrast targets, on the editor and on the sidebar", async () => {
    const { THEMES } = await import("./themes");
    const targets: [string, number][] = [["fg", 7], ["fg_muted", 4.8], ["fg_faint", 3.2], ["accent", 4.5],
      ...["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "grey"].map((k) => [k, 4.5] as [string, number])];
    for (const t of THEMES) {
      const c = t.colors as Record<string, string>;
      for (const [k, min] of targets) {
        for (const bg of [c.bg, c.bg_alt]) expect(contrast(c[k], bg), `${t.id} ${k}`).toBeGreaterThanOrEqual(min);
      }
    }
  });
});
