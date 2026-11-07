// @vitest-environment happy-dom
// Behavioral tests of the whole controller against an in-memory disk:
// what reaches the files when saving, reloading, restoring a session…

import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./app";
import type { Backend, Entry, Meta } from "./core/backend";
import { basename, dirname, isInside } from "./core/path";

interface Disk {
  files: Map<string, { text: string; mtime: number }>;
  dirs: Set<string>;
  /** Writes to these paths fail (locked file, read-only folder…). */
  failWrites: Set<string>;
  /** Appends take a while, like a real disk behind IPC. */
  appendDelay: number;
  clock: number;
  /** Simulates another program changing a file. */
  external(path: string, text: string): void;
  text(path: string): string | undefined;
}

function memoryBackend(init: Record<string, string> = {}, opts: { savePath?: string | null } = {}): { backend: Backend; disk: Disk } {
  const disk: Disk = {
    files: new Map(),
    dirs: new Set(["/", "/notes", "/config"]),
    failWrites: new Set(),
    appendDelay: 0,
    clock: 1_000,
    external(path, text) {
      disk.clock += 5_000;
      disk.files.set(path, { text, mtime: disk.clock });
    },
    text: (path) => disk.files.get(path)?.text,
  };
  for (const [p, t] of Object.entries(init)) disk.files.set(p, { text: t, mtime: disk.clock });
  const meta = (p: string): Meta | null => {
    const f = disk.files.get(p);
    if (f) return { mtime: f.mtime, size: f.text.length, isDir: false };
    return disk.dirs.has(p) ? { mtime: 0, size: 0, isDir: true } : null;
  };
  const write = (p: string, text: string): Meta => {
    if (disk.failWrites.has(p)) throw new Error("access denied");
    disk.clock += 10;
    disk.files.set(p, { text, mtime: disk.clock });
    return meta(p)!;
  };
  const backend: Backend = {
    kind: "tauri",
    platform: "linux",
    windowLabel: "main",
    async readText(p) {
      const f = disk.files.get(p);
      if (!f) throw new Error(`not found: ${p}`);
      if (f.text.includes("\u0000")) throw new Error("not a text file"); // like the native backend
      const bom = f.text.startsWith("﻿");
      return { text: bom ? f.text.slice(1) : f.text, encoding: bom ? "UTF-8 BOM" : f.text.includes("é") ? "Windows-1252" : "UTF-8", mtime: f.mtime };
    },
    writeText: async (p, text, bom) => write(p, (bom ? "﻿" : "") + text),
    async appendLines(p, lines) {
      if (disk.appendDelay) await new Promise((r) => setTimeout(r, disk.appendDelay));
      const prev = disk.files.get(p)?.text ?? "";
      return write(p, prev + (prev && !prev.endsWith("\n") ? "\n" : "") + lines.map((l) => l + "\n").join(""));
    },
    stat: async (p) => meta(p),
    async listDir(p) {
      const out: Entry[] = [];
      for (const f of disk.files.keys()) if (dirname(f) === p) out.push({ name: basename(f), path: f, isDir: false });
      return out;
    },
    walk: async (root) => [...disk.files.keys()].filter((f) => isInside(f, root)),
    readMany: async (paths) => paths.map((p) => disk.files.get(p)?.text ?? null),
    createDir: async (p) => void disk.dirs.add(p),
    createFile: async (p) => void write(p, ""),
    rename: async () => {},
    trash: async (p) => void disk.files.delete(p),
    configDir: async () => "/config",
    windowPaths: async () => [],
    openWindow: async () => {},
    windowCount: async () => 1,
    deleteSession: async () => {},
    broadcastSettingsChanged: () => {},
    onSettingsChanged: () => {},
    pickFolder: async () => null,
    pickFiles: async () => [],
    pickSavePath: async () => opts.savePath ?? null,
    openUrl: async () => {},
    reveal: async () => {},
    setTitle: () => {},
    setDark: () => {},
    show: async () => {},
    toggleFullscreen: async () => {},
    onCloseRequested: () => {},
    onFileDrop: () => {},
    onOpenRequest: () => {},
  };
  return { backend, disk };
}

const SETTINGS = (extra = "") => `{ "autosave": false ${extra} }`;

async function start(files: Record<string, string>, opts: { savePath?: string | null } = {}) {
  const { backend, disk } = memoryBackend({ "/config/settings.json": SETTINGS(), ...files }, opts);
  const app = new App(backend);
  await app.init();
  return { app, disk, backend };
}

const type = (app: App, text: string) => app.view.dispatch({ changes: { from: app.view.state.doc.length, insert: text } });

beforeEach(() => {
  document.body.innerHTML = `
    <div id="app"><aside id="sidebar"></aside><div id="sb-resizer"></div>
      <main id="main"><div id="tabbar"></div><div id="editor-host"></div><div id="welcome" hidden></div></main>
      <footer id="statusbar"></footer></div>
    <div id="overlay-root"></div>`;
});

describe("saving", () => {
  it("a failed 'Save as' keeps the note on its original file", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "hello" }, { savePath: "/locked/b.txt" });
    disk.failWrites.add("/locked/b.txt");
    const doc = (await app.openFile("/notes/a.txt"))!;
    type(app, " world");
    expect(await app.saveAs(doc)).toBe(false);
    expect(doc.path).toBe("/notes/a.txt");
    expect(await app.save(doc)).toBe(true);
    expect(disk.text("/notes/a.txt")).toBe("hello world");
  });

  it("after saving, the status bar shows the encoding actually written", async () => {
    const { app } = await start({ "/notes/old.txt": "café" });
    const doc = (await app.openFile("/notes/old.txt"))!;
    expect(doc.encoding).toBe("Windows-1252");
    type(app, "!");
    await app.save(doc);
    expect(doc.encoding).toBe("UTF-8");
  });

  it("reloading a file follows its new line endings", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "one\r\ntwo\r\n" });
    const doc = (await app.openFile("/notes/a.txt"))!;
    expect(doc.eol).toBe("\r\n");
    disk.external("/notes/a.txt", "one\ntwo\nthree\n");
    await app.checkExternalChanges();
    expect(app.view.state.doc.toString()).toBe("one\ntwo\nthree\n");
    type(app, "four");
    await app.save(doc);
    expect(disk.text("/notes/a.txt")).toBe("one\ntwo\nthree\nfour");
  });
});

describe("opening", () => {
  it("binary content is refused whatever the extension", async () => {
    const { app, disk } = await start({ "/notes/tool": "MZ\u0090\u0000\u0003", "/notes/renamed.txt": "PK\u0003\u0004\u0000" });
    expect(await app.openFile("/notes/tool")).toBeNull();
    expect(await app.openFile("/notes/renamed.txt")).toBeNull();
    expect(app.docs).toHaveLength(0);
    expect(document.querySelector(".kn-toast-action")?.textContent).toBe("Reveal in file manager");
    expect(disk.text("/notes/tool")).toBe("MZ\u0090\u0000\u0003");
  });
});

describe("session", () => {
  it("a restored draft never silently overwrites a file changed on disk in the meantime", async () => {
    const session = {
      version: 1, workspace: null, recent: [], active: 0, groups: [], untitled: 0,
      sidebar: { visible: true, width: 260, panel: "files", expanded: [] },
      tabs: [{ path: "/notes/a.txt", title: "a.txt", color: null, group: null, content: "my draft", eol: "\n", cursor: 0, scrollTop: 0, mtime: 1_000 }],
    };
    const { backend, disk } = memoryBackend({
      "/config/settings.json": SETTINGS(),
      "/config/session.json": JSON.stringify(session),
      "/notes/a.txt": "original",
    });
    disk.external("/notes/a.txt", "changed elsewhere");
    const app = new App(backend);
    await app.init();
    const doc = app.active!;
    expect(doc.state.doc.toString()).toBe("my draft");
    expect(doc.conflict).toBe(true);
    app.flushAutosaves();
    await new Promise((r) => setTimeout(r, 10));
    expect(disk.text("/notes/a.txt")).toBe("changed elsewhere");
  });
});

describe("folders", () => {
  it("a recent folder that no longer exists is not opened, and leaves the list", async () => {
    const { app } = await start({});
    app.recent = ["/gone", "/notes"];
    await app.openFolder("/gone");
    expect(app.workspace).toBeNull();
    expect(app.recent).toEqual(["/notes"]);
  });
});

describe("tasks", () => {
  it("auto-archive from a status change can be awaited", async () => {
    const { app, disk } = await start({
      "/config/settings.json": SETTINGS(`, "auto_archive": true`),
      "/notes/work.txt": "- call X - ongoing\n- other - todo\n",
    });
    disk.appendDelay = 5;
    const doc = (await app.openFile("/notes/work.txt", { activate: false }))!;
    await app.cycleTasks(undefined, doc, [1]);
    expect(disk.text("/notes/work_done.txt")).toMatch(/^- call X - done \[\d{4}-\d{2}-\d{2}\]\n$/);
    await app.save(doc);
    expect(disk.text("/notes/work.txt")).toBe("- other - todo\n");
  });

  it("a failed auto-archive from the task list never loses the task", async () => {
    const { app, disk } = await start({
      "/config/settings.json": SETTINGS(`, "auto_archive": true`),
      "/notes/work.txt": "- call X - ongoing\n- other - todo\n",
    });
    disk.appendDelay = 5;
    disk.failWrites.add("/notes/work_done.txt");
    // What the "next status" button of the Tasks panel does on a note that is not open.
    const doc = (await app.openFile("/notes/work.txt", { activate: false }))!;
    await app.cycleTasks(undefined, doc, [1]);
    await app.save(doc);
    await app.closeDoc(doc, { force: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(disk.text("/notes/work.txt")).toBe("- call X - done\n- other - todo\n");
  });

  it("archiving needs a non-empty suffix (never appends a note to itself)", async () => {
    const { app } = await start({ "/config/settings.json": SETTINGS(`, "archive_suffix": ""`) });
    expect(app.settings.archive_suffix).toBe("_done");
  });
});
