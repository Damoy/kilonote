// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { forgetRecent, isPinned, noteOpened, onPinsChanged, pathRemoved, pathRenamed, pinnedNotes, RECENT_MAX, recentNotes, setPinned } from "./pins";

beforeEach(() => localStorage.clear());

describe("pinned notes", () => {
  it("are kept in order, once each (any case on Windows)", () => {
    setPinned("C:\\Notes\\work.txt", true);
    setPinned("C:\\Notes\\ideas.md", true);
    setPinned("c:/notes/WORK.txt", true);
    expect(pinnedNotes()).toEqual(["C:\\Notes\\ideas.md", "c:/notes/WORK.txt"]);
    expect(isPinned("C:\\Notes\\work.txt")).toBe(true);
    setPinned("C:\\Notes\\work.txt", false);
    expect(pinnedNotes()).toEqual(["C:\\Notes\\ideas.md"]);
  });

  it("follow a rename, of the note or of its folder, and leave with the trash", () => {
    setPinned("/notes/a.txt", true);
    setPinned("/notes/sub/b.txt", true);
    noteOpened("/notes/sub/b.txt");
    pathRenamed("/notes/sub", "/notes/projects");
    expect(pinnedNotes()).toEqual(["/notes/a.txt", "/notes/projects/b.txt"]);
    expect(recentNotes()).toEqual(["/notes/projects/b.txt"]);
    pathRenamed("/notes/a.txt", "/notes/z.txt");
    expect(pinnedNotes()[0]).toBe("/notes/z.txt");
    pathRemoved("/notes/projects");
    expect(pinnedNotes()).toEqual(["/notes/z.txt"]);
    expect(recentNotes()).toEqual([]);
  });

  it("tell who listens, pins and recent notes apart", () => {
    const seen: string[] = [];
    const stop = onPinsChanged((c) => seen.push(c));
    setPinned("/a.txt", true);
    noteOpened("/a.txt");
    noteOpened("/a.txt"); // already the first: nothing changes
    stop();
    setPinned("/b.txt", true);
    expect(seen).toEqual(["pins", "recent"]);
  });

  it("survive a broken storage", () => {
    localStorage.setItem("kilonote-pinned-notes", "{not json");
    expect(pinnedNotes()).toEqual([]);
    localStorage.setItem("kilonote-pinned-notes", JSON.stringify(["/a.txt", 3, null, ""]));
    expect(pinnedNotes()).toEqual(["/a.txt"]);
  });
});

describe("recent notes", () => {
  it("the last opened first, a limited number, the missing ones forgotten", () => {
    for (let i = 0; i < RECENT_MAX + 5; i++) noteOpened(`/notes/${i}.txt`);
    noteOpened("/notes/3.txt");
    const list = recentNotes();
    expect(list).toHaveLength(RECENT_MAX);
    expect(list.slice(0, 2)).toEqual(["/notes/3.txt", `/notes/${RECENT_MAX + 4}.txt`]);
    forgetRecent("/notes/3.txt");
    expect(recentNotes()[0]).toBe(`/notes/${RECENT_MAX + 4}.txt`);
  });
});
