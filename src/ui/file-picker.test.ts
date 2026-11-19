// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { Entry } from "../core/backend";
import { pickPath, placeOf } from "./file-picker";

const TREE: Record<string, Entry[]> = {
  "/storage/emulated/0": [
    { name: "Documents", path: "/storage/emulated/0/Documents", isDir: true },
    { name: "todo.txt", path: "/storage/emulated/0/todo.txt", isDir: false },
  ],
  "/storage/emulated/0/Documents": [{ name: "work.md", path: "/storage/emulated/0/Documents/work.md", isDir: false }],
  "/data/app/Notes": [],
};
const listDir = async (p: string) => {
  if (!(p in TREE)) throw new Error("permission denied");
  return TREE[p];
};
const places = [
  { label: "Phone", path: "/storage/emulated/0" },
  { label: "KiloNote", path: "/data/app/Notes" },
];
const tick = () => new Promise((r) => setTimeout(r, 0));
const rows = () => [...document.querySelectorAll<HTMLElement>(".kn-picker-row")].map((r) => r.textContent);
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!;

beforeEach(() => {
  document.body.innerHTML = `<div id="overlay-root"></div>`;
});

describe("folder chooser (Android)", () => {
  it("finds the place that holds a path", () => {
    expect(placeOf(places, "/storage/emulated/0/Documents/x")?.label).toBe("Phone");
    expect(placeOf(places, "/data/app/Notes")?.label).toBe("KiloNote");
    expect(placeOf(places, "/etc")).toBeUndefined();
  });

  it("goes into folders, not above its place, and opens the folder shown", async () => {
    const result = pickPath({ mode: "folder", places, listDir });
    await tick();
    expect(rows()).toEqual(["Documents", "todo.txt"]);
    // Files are shown, but cannot be chosen when a folder is asked for.
    expect(document.querySelector(".kn-picker-row.file")?.tagName).toBe("DIV");
    expect(button("Up").disabled).toBe(true);
    document.querySelector<HTMLElement>(".kn-picker-row.dir")!.click();
    await tick();
    expect(rows()).toEqual(["work.md"]);
    expect(document.querySelector(".kn-picker-path")!.textContent).toBe("Phone / Documents");
    expect(button("Up").disabled).toBe(false);
    button('Open "Documents"').click();
    expect(await result).toBe("/storage/emulated/0/Documents");
  });

  it("chooses a file, switches places, and says when a folder cannot be read", async () => {
    const result = pickPath({ mode: "file", places: [...places, { label: "Locked", path: "/locked" }], start: "/storage/emulated/0/Documents", listDir });
    await tick();
    expect(rows()).toEqual(["work.md"]);
    button("Locked").click();
    await tick();
    expect(document.querySelector(".kn-picker-empty")!.textContent).toMatch(/Cannot read this folder/);
    button("KiloNote").click();
    await tick();
    expect(document.querySelector(".kn-picker-empty")!.textContent).toBe("Empty folder");
    button("Phone").click();
    await tick();
    document.querySelectorAll<HTMLElement>(".kn-picker-row")[1].click();
    expect(await result).toBe("/storage/emulated/0/todo.txt");
  });

  it("starts in the first place when the start is elsewhere, and Cancel or Escape give nothing", async () => {
    const first = pickPath({ mode: "folder", places, start: "/elsewhere", listDir });
    await tick();
    expect(document.querySelector(".kn-picker-place.active")!.textContent).toBe("Phone");
    button("Cancel").click();
    expect(await first).toBeNull();
    const second = pickPath({ mode: "file", places, listDir });
    await tick();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await second).toBeNull();
    expect(await pickPath({ mode: "folder", places: [], listDir })).toBeNull();
  });
});
