import { describe, expect, it } from "vitest";
import { isSafeTarget, linkName, linksTo, noteLinks, resolveNoteLink } from "./links";

const isNote = (p: string) => /\.(txt|md)$/i.test(p) || !/\.[a-z0-9]+$/i.test(p.split("/").pop()!);
const NOTES = ["/n/work.txt", "/n/report.md", "/n/projects/report.txt", "/n/projects/alpha/plan.txt", "/n/archive/old/work.txt", "/n/homework.txt"];

describe("links between notes", () => {
  it("are found on a line", () => {
    expect(noteLinks("see [[work]] and [[projects/report|the report]], not [x] or [[]]")).toEqual([
      { target: "work", from: 4, to: 12 },
      { target: "projects/report", from: 17, to: 47 },
    ]);
    expect(noteLinks("plain")).toEqual([]);
  });

  it("point to the note next to the one that holds them first, then the shortest path", () => {
    const go = (t: string, from: string | null = "/n/work.txt") => resolveNoteLink(t, from, NOTES, isNote);
    expect(go("work")).toBe("/n/work.txt");
    expect(go("WORK", "/n/archive/old/x.txt")).toBe("/n/archive/old/work.txt");
    expect(go("report")).toBe("/n/report.md");
    expect(go("report", "/n/projects/alpha/plan.txt")).toBe("/n/report.md");
    expect(go("report", "/n/projects/x.txt")).toBe("/n/projects/report.txt");
    expect(go("report.txt")).toBe("/n/projects/report.txt");
    expect(go("projects/report")).toBe("/n/projects/report.txt");
    expect(go("plan")).toBe("/n/projects/alpha/plan.txt");
    expect(go("missing")).toBeNull();
    expect(go("ework")).toBeNull(); // not a part of "homework"
  });

  it("never point outside the folder", () => {
    for (const t of ["../secret", "/etc/passwd", "C:\\Windows\\x", "a/../../b", "a:b"]) expect(isSafeTarget(t), t).toBe(false);
    expect(resolveNoteLink("../work", "/n/projects/report.txt", NOTES, isNote)).toBeNull();
  });

  it("are listed for the note they point to (its backlinks)", () => {
    const notes = [
      { path: "/n/work.txt", text: "- call about [[projects/report]] - todo\nnothing" },
      { path: "/n/projects/alpha/plan.txt", text: "[[report]]\n[[report.txt]] again" },
      { path: "/n/report.md", text: "self [[report]]" },
      { path: "/n/homework.txt", text: null },
    ];
    expect(linksTo("/n/projects/report.txt", notes, NOTES, isNote)).toEqual([
      { path: "/n/work.txt", line: 1, text: "- call about [[projects/report]] - todo" },
      { path: "/n/projects/alpha/plan.txt", line: 2, text: "[[report.txt]] again" },
    ]);
  });

  it("are written with the note's name, or its path when the name is not unique", () => {
    expect(linkName("/n/work.txt", "/n", NOTES, isNote)).toBe("work");
    expect(linkName("/n/projects/report.txt", "/n", NOTES, isNote)).toBe("projects/report");
    expect(linkName("/n/projects/alpha/plan.txt", "/n", NOTES, isNote)).toBe("plan");
  });
});
