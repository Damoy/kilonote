import { describe, expect, it } from "vitest";
import { savePathIn } from "./backend";

describe("save as on Android", () => {
  it("saves in the folder, subfolders allowed, never outside it", () => {
    expect(savePathIn("/data/Notes", "ideas.txt")).toBe("/data/Notes/ideas.txt");
    expect(savePathIn("/data/Notes", " work/ideas.md ")).toBe("/data/Notes/work/ideas.md");
    expect(savePathIn("/data/Notes", "work\\ideas.md")).toBe("/data/Notes/work/ideas.md");
    for (const bad of ["", "  ", "../x.txt", "a/../../x.txt", "./x", "a:b.txt", "what?.txt", "/"]) {
      expect(savePathIn("/data/Notes", bad), bad).toBeNull();
    }
  });
});
