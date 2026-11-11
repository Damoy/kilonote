// @vitest-environment happy-dom
// Behavioral security test with a simulated backend: whatever a note folder
// contains, opening, dropping or passing a file on the command line only ever
// reads text. A recording backend proves that nothing is launched.

import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../app/app";
import type { Backend, Meta } from "../core/backend";

type Call = { method: string; args: unknown[] };

/** A backend that records every call; files are a small in-memory map. */
function recordingBackend(files: Record<string, string>): { backend: Backend; calls: Call[] } {
  const calls: Call[] = [];
  const meta = (p: string): Meta | null => (p in files ? { mtime: 1, size: files[p].length, isDir: false } : null);
  const impl: Record<string, (...args: never[]) => unknown> = {
    readText: async (p: string) => ({ text: files[p], encoding: "UTF-8", mtime: 1 }),
    stat: async (p: string) => meta(p),
    reveal: async () => {},
  };
  const backend = new Proxy({ kind: "tauri", platform: "windows", windowLabel: "main" } as unknown as Backend, {
    get(target, prop: string) {
      if (prop in target) return (target as unknown as Record<string, unknown>)[prop];
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return (impl[prop] as ((...a: unknown[]) => unknown) | undefined)?.(...args) ?? Promise.resolve(null);
      };
    },
  });
  return { backend, calls };
}

const READ_ONLY = new Set(["readText", "stat"]);

describe("opening files never runs a program", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="overlay-root"></div>';
  });

  it("executables are refused, from any entry point", async () => {
    const programs = ["C:\\notes\\tool.exe", "C:\\notes\\setup.msi", "C:\\notes\\app.jar"];
    const { backend, calls } = recordingBackend(Object.fromEntries(programs.map((p) => [p, "MZ"])));
    const app = new App(backend);
    for (const p of programs) expect(await app.openFile(p)).toBeNull(); // click in the explorer, Ctrl+O
    await app.openPaths(programs); // drag and drop, command line, second instance
    expect(app.docs).toHaveLength(0);
    expect(calls.every((c) => READ_ONLY.has(c.method))).toBe(true);
    expect(document.querySelectorAll(".kn-toast").length).toBeGreaterThan(0);
  });

  it("an image file is only read, as an image, to be shown", async () => {
    const { backend, calls } = recordingBackend({});
    const app = new App(backend);
    await app.openFile("C:\\notes\\shot.png");
    await app.openPaths(["C:\\notes\\a.jpg", "C:\\notes\\b.gif"]);
    expect(app.docs).toHaveLength(0);
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(["readImage", "stat", "listDir"]));
  });

  it("the only action offered is revealing the file in the file manager", async () => {
    const { backend, calls } = recordingBackend({ "C:\\notes\\tool.exe": "MZ" });
    const app = new App(backend);
    await app.openFile("C:\\notes\\tool.exe");
    const action = document.querySelector<HTMLButtonElement>(".kn-toast-action")!;
    expect(action.textContent).toBe("Reveal in file manager");
    action.click();
    expect(calls.map((c) => c.method)).toEqual(["reveal"]);
  });

  it("scripts are only ever opened as text", async () => {
    const { backend, calls } = recordingBackend({ "C:\\notes\\run.bat": "@echo off\r\ndel *.*" });
    const app = new App(backend);
    // Only check what reaches the backend: reads (and the window's title, the note's name).
    await app.openFile("C:\\notes\\run.bat").catch(() => null);
    expect(calls.some((c) => c.method === "readText")).toBe(true);
    expect(calls.every((c) => READ_ONLY.has(c.method) || c.method === "setTitle")).toBe(true);
  });
});
