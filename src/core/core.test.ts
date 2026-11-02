import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "./fuzzy";
import { parseJsonc } from "./jsonc";
import { basename, dirname, doneFileFor, isDoneFile, join, projectName, relative } from "./path";
import { DEFAULT_SETTINGS, mergeSettings, setSettingInText, SETTINGS_TEMPLATE } from "./settings";

describe("chemins", () => {
  it("unix et windows", () => {
    expect(basename("/a/b/mc.txt")).toBe("mc.txt");
    expect(basename("C:\\notes\\mc.txt")).toBe("mc.txt");
    expect(dirname("C:\\notes\\mc.txt")).toBe("C:\\notes");
    expect(join("C:\\notes", "mc.txt")).toBe("C:\\notes\\mc.txt");
    expect(join("/notes/", "mc.txt")).toBe("/notes/mc.txt");
    expect(relative("C:\\notes", "C:\\Notes\\pro\\mc.txt")).toBe("pro\\mc.txt");
  });

  it("fichier d'archive", () => {
    expect(doneFileFor("/n/mc.txt", "_done")).toBe("/n/mc_done.txt");
    expect(doneFileFor("C:\\n\\Projet.MD", "_done")).toBe("C:\\n\\Projet_done.MD");
    expect(doneFileFor("/n/sans-extension", "_done")).toBe("/n/sans-extension_done");
    expect(isDoneFile("/n/mc_done.txt", "_done")).toBe(true);
    expect(isDoneFile("/n/mc.txt", "_done")).toBe(false);
    expect(projectName("/n/mc_done.txt", "_done")).toBe("mc");
  });
});

describe("paramètres", () => {
  it("le modèle commenté est valide", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("minuit");
    expect(DEFAULT_SETTINGS.task_cycle).toEqual(["todo", "ongoing", "done"]);
  });

  it("fusion tolérante", () => {
    const s = mergeSettings({ font_size: 200, theme: 3 as unknown as string, keybindings: { "Ctrl+K": "x" } });
    expect(s.font_size).toBe(40);
    expect(s.theme).toBe("minuit");
    expect(s.keybindings["Ctrl+K"]).toBe("x");
  });

  it("JSONC : commentaires, virgules finales, // dans les chaînes", () => {
    expect(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }')).toEqual({ a: "http://x", b: [1, 2] });
  });

  it("modifie une valeur sans perdre les commentaires", () => {
    const out = setSettingInText(SETTINGS_TEMPLATE, "theme", "papier");
    expect(out).toContain('"theme": "papier"');
    expect(out).toContain("// Paramètres KiloNote");
    const added = setSettingInText('{\n  "a": 1\n}', "font_size", 16);
    expect(parseJsonc(added)).toEqual({ a: 1, font_size: 16 });
  });
});

describe("recherche floue", () => {
  it("trouve les sous-séquences et favorise le nom de fichier", () => {
    expect(fuzzyMatch("mcd", "projets/mc_done.txt")).not.toBeNull();
    expect(fuzzyMatch("xyz", "mc.txt")).toBeNull();
    const a = fuzzyMatch("mc", "clients/mc.txt")!.score;
    const b = fuzzyMatch("mc", "mes-clients/notes.txt")!.score;
    expect(a).toBeGreaterThan(b);
    expect(fuzzyMatch("ete", "Été.txt")).not.toBeNull();
  });
});

describe("chemins relatifs", () => {
  it("ne confond pas /Notes et /Notes2", () => {
    expect(relative("/Notes", "/Notes")).toBe("");
    expect(relative("/Notes/", "/Notes/a/b.txt")).toBe("a/b.txt");
    expect(relative("/Notes", "/Notes2/b.txt")).toBe("/Notes2/b.txt");
  });
});

describe("raccourcis", () => {
  it("normalise les combinaisons, y compris en français", async () => {
    const { normalizeCombo, setPlatform } = await import("./commands");
    setPlatform("windows");
    expect(normalizeCombo("mod+shift+p")).toBe("Ctrl+Shift+P");
    expect(normalizeCombo("Ctrl+Maj+Entrée")).toBe("Ctrl+Shift+Enter");
    expect(normalizeCombo("Mod++")).toBe("Ctrl++");
    setPlatform("macos");
    expect(normalizeCombo("Mod+,")).toBe("Meta+,");
  });
});
