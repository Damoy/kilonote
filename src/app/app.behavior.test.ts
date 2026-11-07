// @vitest-environment happy-dom
// Behavioral tests of the whole controller against an in-memory disk:
// what reaches the files when saving, reloading, restoring a session…

import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";
import { historyName, parseHistoryName, pathHash, replaceInFiles, showLocalHistory } from "./history";
import type { Backend, Entry, Meta } from "../core/backend";
import { basename, dirname, isInside } from "../core/path";
import { formatDocument } from "./editing";
import { renamePath } from "./files";
import { saveSessionNow } from "./session";
import { archiveLines, cycleTasks } from "./tasks";

interface Disk {
  files: Map<string, { text: string; mtime: number }>;
  dirs: Set<string>;
  /** Writes to these paths fail (locked file, read-only folder…). */
  failWrites: Set<string>;
  /** Appends take a while, like a real disk behind IPC. */
  appendDelay: number;
  /** Reported size of some files (to simulate huge files). */
  sizes: Map<string, number>;
  /** Encoding of the last write of each file. */
  encodings: Map<string, string>;
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
    sizes: new Map(),
    encodings: new Map(),
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
    if (f) return { mtime: f.mtime, size: disk.sizes.get(p) ?? f.text.length, isDir: false };
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
      return { text: bom ? f.text.slice(1) : f.text, encoding: disk.encodings.get(p) ?? (bom ? "UTF-8 BOM" : f.text.includes("\u00e9") ? "Windows-1252" : "UTF-8"), mtime: f.mtime };
    },
    async writeText(p, text, encoding) {
      // Like the native backend: Windows-1252 cannot hold every character.
      const used = encoding === "Windows-1252" && /[^\u0000-\u00ff\u20ac]/.test(text) ? "UTF-8" : (encoding ?? "UTF-8");
      disk.encodings.set(p, used);
      return { mtime: write(p, (used === "UTF-8 BOM" ? "\uFEFF" : "") + text).mtime, encoding: used };
    },
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
    windowAt: async () => null,
    sendPaths: async () => {},
    deleteSession: async () => {},
    pruneHistory: async () => {},
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

  it("a file keeps its encoding when saved, unless it cannot hold a new character", async () => {
    const { app, disk } = await start({ "/notes/old.txt": "caf\u00e9" });
    const doc = (await app.openFile("/notes/old.txt"))!;
    expect(doc.encoding).toBe("Windows-1252");
    type(app, "!");
    await app.save(doc);
    expect(disk.encodings.get("/notes/old.txt")).toBe("Windows-1252");
    type(app, " \u2713");
    await app.save(doc);
    expect(doc.encoding).toBe("UTF-8");
    expect(document.querySelector(".kn-toast-msg")?.textContent).toContain("saved as UTF-8");
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

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const clickButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".kn-modal button")].find((b) => b.textContent === label)!.click();

describe("opening", () => {
  it("a large file asks first, a huge one is refused", async () => {
    const { app, disk } = await start({ "/notes/big.log": "x", "/notes/huge.log": "y" });
    disk.sizes.set("/notes/big.log", 50 * 1024 * 1024);
    disk.sizes.set("/notes/huge.log", 900 * 1024 * 1024);
    const pending = app.openFile("/notes/big.log");
    await tick();
    expect(document.querySelector(".kn-modal-message")?.textContent).toContain("50 MB");
    clickButton("Cancel");
    expect(await pending).toBeNull();
    const again = app.openFile("/notes/big.log");
    await tick();
    clickButton("Open anyway");
    expect((await again)?.path).toBe("/notes/big.log");
    expect(await app.openFile("/notes/huge.log")).toBeNull();
    expect(app.docs).toHaveLength(1);
  });

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

describe("local history", () => {
  it("names sort by time and keep the kind; Windows paths hash case-insensitively", () => {
    const name = historyName("C:\\Notes\\work_v2.txt", "disk", new Date(2026, 10, 7, 9, 5, 3, 7));
    expect(name).toMatch(/^20261107-090503-007_[0-9a-f]{8}_disk_work_v2\.txt$/);
    expect(parseHistoryName(name)).toEqual({ hash: pathHash("c:/notes/WORK_V2.TXT"), kind: "disk", when: "2026-11-07 09:05:03" });
    expect(pathHash("/a/b")).not.toBe(pathHash("/a/B"));
  });

  it("keeping my version saves the disk version first; reloading saves my edits first", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "v1" });
    const doc = (await app.openFile("/notes/a.txt"))!;
    type(app, " mine");
    disk.external("/notes/a.txt", "v2 from elsewhere");
    await app.checkExternalChanges();
    expect(doc.conflict).toBe(true);
    await app.resolveConflict(doc, "mine");
    expect(disk.text("/notes/a.txt")).toBe("v1 mine");
    type(app, " again");
    await app.reloadDoc(doc, true);
    const kept = [...disk.files.keys()].filter((p) => p.startsWith("/config/history/")).sort();
    expect(kept.map((p) => disk.text(p))).toEqual(["v2 from elsewhere", "v1 mine again"]);
    // The history picker opens a version in a new tab.
    await showLocalHistory(app);
    const rows = document.querySelectorAll(".kn-palette-row");
    expect(rows).toHaveLength(2);
    rows[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await tick(5);
    expect(app.active?.state.doc.toString()).toBe("v2 from elsewhere");
    expect(app.active?.path).toBeNull();
  });
});

describe("replace in files", () => {
  it("rewrites open and closed files in their encoding, keeps copies, and can be undone", async () => {
    const { app, disk } = await start({
      "/notes/a.txt": "call Bob\r\nBob again\r\n",
      "/notes/b.txt": "caf\u00e9 with bob\n",
      "/notes/c.txt": "nothing here\n",
    });
    const a = (await app.openFile("/notes/a.txt"))!;
    const r = await replaceInFiles(app, ["/notes/a.txt", "/notes/b.txt", "/notes/c.txt"], /(b)ob/gi, "$1ill", false);
    expect(r).toEqual({ files: 2, count: 3 });
    expect(disk.text("/notes/a.txt")).toBe("call Bill\r\nBill again\r\n");
    expect(a.dirty).toBe(false);
    expect(disk.text("/notes/b.txt")).toBe("caf\u00e9 with bill\n");
    expect(disk.encodings.get("/notes/b.txt")).toBe("Windows-1252");
    const copies = [...disk.files.keys()].filter((p) => p.includes("/history/") && p.includes("_replace_"));
    expect(copies.map((p) => disk.text(p))).toEqual(["caf\u00e9 with bob\n"]);
    // Undo, from the notification.
    [...document.querySelectorAll<HTMLButtonElement>(".kn-toast-action")].find((b) => b.textContent === "Undo")!.click();
    await tick(10);
    expect(disk.text("/notes/a.txt")).toBe("call Bob\r\nBob again\r\n");
    expect(disk.text("/notes/b.txt")).toBe("caf\u00e9 with bob\n");
  });

  it("a literal replacement never expands $ patterns", async () => {
    const { app, disk } = await start({ "/notes/p.txt": "price: 10\n" });
    await replaceInFiles(app, ["/notes/p.txt"], /10/g, "$&0 $1", true);
    expect(disk.text("/notes/p.txt")).toBe("price: $&0 $1\n");
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
    await cycleTasks(app, undefined, doc, [1]);
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
    await cycleTasks(app, undefined, doc, [1]);
    await app.save(doc);
    await app.closeDoc(doc, { force: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(disk.text("/notes/work.txt")).toBe("- call X - done\n- other - todo\n");
  });

  it("the archive is written first; a failure leaves the note untouched", async () => {
    const { app, disk } = await start({ "/notes/work.txt": "- a - done\n- b - todo\n" });
    disk.failWrites.add("/notes/work_done.txt");
    const doc = (await app.openFile("/notes/work.txt"))!;
    await archiveLines(app, doc, [1]);
    expect(app.view.state.doc.toString()).toBe("- a - done\n- b - todo\n");
    expect(doc.dirty).toBe(false);
  });

  it("lines edited while the archive is written stay; the others leave the note where they now are", async () => {
    const { app, disk } = await start({ "/notes/work.txt": "- a - done\n- b - todo\n- c - done\n" });
    disk.appendDelay = 5;
    const doc = (await app.openFile("/notes/work.txt"))!;
    const archiving = archiveLines(app, doc, [1, 3]);
    // Meanwhile: a new line on top, and the "c" task is edited. (Unfocused: happy-dom
    // fires selectionchange synchronously, which real browsers never do.)
    app.view.contentDOM.blur();
    app.view.dispatch({ changes: { from: 0, insert: "# Top\n" } });
    const c = app.view.state.doc.line(4);
    app.view.dispatch({ changes: { from: c.to, insert: "!" } });
    await archiving;
    expect(app.view.state.doc.toString()).toBe("# Top\n- b - todo\n- c - done!\n");
    expect(disk.text("/notes/work_done.txt")).toMatch(/^- a - done \[[\d-]+\]\n- c - done \[[\d-]+\]\n$/);
  });

  it("archiving needs a non-empty suffix (never appends a note to itself)", async () => {
    const { app } = await start({ "/config/settings.json": SETTINGS(`, "archive_suffix": ""`) });
    expect(app.settings.archive_suffix).toBe("_done");
  });
});

describe("cheat sheet", () => {
  it("shows at startup until 'Don't show at startup' is ticked", async () => {
    const { app, disk } = await start({});
    await vi.waitFor(() => expect(document.querySelector(".kn-cheatsheet")).not.toBeNull()); // loaded on first use
    const sheet = document.querySelector(".kn-cheatsheet");
    expect(sheet).not.toBeNull();
    const box = sheet!.querySelector<HTMLInputElement>(".cs-check input")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 0));
    expect(app.settings.show_shortcuts_at_startup).toBe(false);
    expect(disk.text("/config/settings.json")).toContain('"show_shortcuts_at_startup": false');

    document.getElementById("overlay-root")!.replaceChildren();
    const again = new App(app.backend);
    await again.init();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(".kn-cheatsheet")).toBeNull();
  });
});

describe("tab groups", () => {
  it("a collapsed group keeps showing the tab being edited, and never switches tab", async () => {
    const { app } = await start({ "/notes/a.txt": "a", "/notes/b.txt": "b", "/notes/c.txt": "c" });
    for (const p of ["/notes/a.txt", "/notes/b.txt", "/notes/c.txt"]) await app.openFile(p);
    const group = { id: "g", name: "Work", color: "blue", collapsed: false };
    app.groups.push(group);
    app.docs[0].groupId = app.docs[1].groupId = "g";
    app.activate(app.docs[1]);
    app.toggleGroup(group);
    expect(group.collapsed).toBe(true);
    expect(app.active?.path).toBe("/notes/b.txt");
    expect([...document.querySelectorAll(".kn-tab-name")].map((e) => e.textContent)).toEqual(["b.txt", "c.txt"]);
    // Going to another tab of the group keeps it collapsed.
    app.activate(app.docs[0]);
    expect(group.collapsed).toBe(true);
    expect([...document.querySelectorAll(".kn-tab-name")].map((e) => e.textContent)).toEqual(["a.txt", "c.txt"]);
    app.setAllGroupsCollapsed(false);
    expect(document.querySelectorAll(".kn-tab").length).toBe(3);
  });
});

describe("document types and formatting", () => {
  it("code files get their language, and renaming a note follows the new extension", async () => {
    const { app } = await start({ "/notes/run.py": "print(1)\n", "/notes/notes.txt": "- x - todo\n" });
    expect((await app.openFile("/notes/run.py"))?.lang).toBe("python");
    const doc = (await app.openFile("/notes/notes.txt"))!;
    expect(doc.lang).toBe("text");
    const renaming = renamePath(app, "/notes/notes.txt");
    const input = document.querySelector<HTMLInputElement>(".kn-modal input")!;
    input.value = "notes.md";
    document.querySelector<HTMLButtonElement>(".kn-modal .kn-btn.primary")!.click();
    await renaming;
    expect(doc.path).toBe("/notes/notes.md");
    expect(doc.lang).toBe("markdown");
  });

  it("Format document rewrites JSON in one undoable step; invalid JSON is left alone", async () => {
    const { app } = await start({ "/notes/data.json": '{"a":[1,2],"b":{"c":true}}' });
    await app.openFile("/notes/data.json");
    await formatDocument(app);
    expect(app.view.state.doc.toString()).toBe('{\n    "a": [1, 2],\n    "b": {\n        "c": true\n    }\n}\n');
    const { undo } = await import("@codemirror/commands");
    undo(app.view);
    expect(app.view.state.doc.toString()).toBe('{"a":[1,2],"b":{"c":true}}');
    app.view.dispatch({ changes: { from: 0, to: app.view.state.doc.length, insert: '{"a": 1 "b": 2}' } });
    await formatDocument(app);
    expect(app.view.state.doc.toString()).toBe('{"a": 1 "b": 2}');
    expect(document.querySelector(".kn-toast.error")?.textContent).toContain("line 1, column 9");
  });
});

describe("untitled notes", () => {
  it("a new draft takes the smallest free number", async () => {
    const { app } = await start({});
    const a = app.newDoc();
    expect(a.title).toBe("Untitled 1");
    await app.closeDoc(a);
    expect(app.newDoc().title).toBe("Untitled 1");
    const b = app.newDoc();
    expect(b.title).toBe("Untitled 2");
    app.newDoc();
    await app.closeDoc(b);
    expect(app.newDoc().title).toBe("Untitled 2");
    expect(app.newDoc().title).toBe("Untitled 4");
  });
});

describe("side views", () => {
  it("each kind of view is turned on on its own and kept with the session", async () => {
    const { app, disk } = await start({ "/notes/a.json": '{"a": 1}', "/notes/b.md": "# B", "/notes/c.txt": "c" });
    await app.openFile("/notes/a.json");
    app.preview.toggle();
    expect(app.preview.visible).toBe(true);
    await app.openFile("/notes/b.md");
    expect(app.preview.visible).toBe(false); // the Markdown preview was not turned on
    await app.openFile("/notes/c.txt");
    app.preview.toggle(); // nothing to show: a message, nothing turned on
    expect([...app.preview.open]).toEqual(["tree"]);
    await saveSessionNow(app);
    const session = [...disk.files.keys()].find((k) => k.startsWith("/config/session"))!;
    expect(JSON.parse(disk.text(session)!).preview).toEqual(["tree"]);
  });
});

describe("tasks stay in notes", () => {
  it("Ctrl+Enter never turns a line of a code or data file into a task", async () => {
    const { app } = await start({ "/notes/flow.mmd": "flowchart LR\n  A --> B\n", "/notes/a.json": '{"a": 1}\n', "/notes/n.txt": "call Bob\n" });
    for (const p of ["/notes/flow.mmd", "/notes/a.json"]) {
      const doc = (await app.openFile(p))!;
      const before = doc.state.doc.toString();
      app.view.contentDOM.blur(); // (happy-dom: see the archive test above)
      await cycleTasks(app);
      expect(app.view.state.doc.toString(), p).toBe(before);
    }
    await app.openFile("/notes/n.txt");
    app.view.contentDOM.blur();
    await cycleTasks(app);
    expect(app.view.state.doc.toString()).toBe("- call Bob - todo\n");
  });
});
