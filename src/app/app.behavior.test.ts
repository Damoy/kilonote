// @vitest-environment happy-dom
// Behavioral tests of the whole controller against an in-memory disk:
// what reaches the files when saving, reloading, restoring a session…

import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";
import { historyName, parseHistoryName, pathHash, replaceInFiles, showLocalHistory } from "./history";
import type { Backend, Entry, Meta } from "../core/backend";
import { basename, dirname, isInside } from "../core/path";
import { formatDocument } from "./editing";
import { findTasks } from "../text/tasks";
import { renamePath } from "./files";
import { deleteUnusedImages, dropImages, pasteImage, loadNoteImage } from "./images";
import { openDailyNote } from "./templates";
import { openNoteLink } from "./links";
import { provideCommands, provideFiles } from "./pickers";
import { copyRich, exportHtml, printNote } from "./export";
import { pinnedNotes, setPinned } from "./pins";
import { slashMenu } from "../editor/slash";
import { SECRET_BEGIN, SECRET_END } from "../text/secrets";
import { encryptSelection, revealSecret } from "./secrets";
import { secretsField } from "../editor/secrets";
import { saveSessionNow } from "./session";
import { archiveLines, changeTaskInNote, cycleTasks } from "./tasks";

interface Disk {
  files: Map<string, { text: string; mtime: number }>;
  images: Map<string, Uint8Array>;
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
  /** Files read by the batch read (unchanged ones are not). */
  reads: number;
  /** Print dialogs opened. */
  prints: number;
  /** Simulates another program changing a file. */
  external(path: string, text: string): void;
  text(path: string): string | undefined;
}

function memoryBackend(init: Record<string, string> = {}, opts: { savePath?: string | null } = {}): { backend: Backend; disk: Disk } {
  const disk: Disk = {
    files: new Map(),
    images: new Map(),
    dirs: new Set(["/", "/notes", "/config"]),
    failWrites: new Set(),
    appendDelay: 0,
    sizes: new Map(),
    encodings: new Map(),
    clock: 1_000,
    reads: 0,
    prints: 0,
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
      for (const f of [...disk.files.keys(), ...disk.images.keys()]) if (dirname(f) === p) out.push({ name: basename(f), path: f, isDir: false });
      return out;
    },
    walk: async (root) => [...disk.files.keys(), ...disk.images.keys()].filter((f) => isInside(f, root)),
    readChanged: async (paths, known) =>
      paths.map((p, i) => {
        const f = disk.files.get(p);
        if (!f) return null;
        const same = known[i]?.[0] === f.mtime && known[i]?.[1] === f.text.length;
        if (!same) disk.reads++;
        return { mtime: f.mtime, size: f.text.length, text: same ? null : f.text, same };
      }),
    createDir: async (p) => void disk.dirs.add(p),
    createFile: async (p) => void write(p, ""),
    rename: async () => {},
    trash: async (p) => void (disk.files.delete(p) || disk.images.delete(p)),
    async readImage(p) {
      const img = disk.images.get(p);
      if (!img) throw new Error(`not found: ${p}`);
      return img;
    },
    async writeImage(p, bytes) {
      if (disk.images.has(p) || disk.files.has(p)) throw new Error("exists");
      disk.images.set(p, bytes);
    },
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
    print: async () => void disk.prints++,
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

describe("images in notes", () => {
  const png = (n = 1) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, n])], { type: "image/png" });

  it("a pasted image is saved next to the note and its reference written on a line of its own", async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 9, 15, 30, 12), toFake: ["Date"] });
    try {
      const { app, disk } = await start({ "/notes/Meeting notes.txt": "Before the shot after" });
      await app.openFile("/notes/Meeting notes.txt");
      app.view.contentDOM.blur(); // (happy-dom: see the archive test)
      app.view.dispatch({ selection: { anchor: "Before the shot".length } });
      await pasteImage(app, app.view, png(1));
      const first = "/notes/images/Meeting-notes-2026-11-09-153012.png";
      expect([...disk.images.keys()]).toEqual([first]);
      expect(app.view.state.doc.toString()).toBe("Before the shot\n![image](images/Meeting-notes-2026-11-09-153012.png)\n after");
      // The same second: another name, never over the first image.
      app.view.dispatch({ selection: { anchor: app.view.state.doc.length } });
      await pasteImage(app, app.view, png(2));
      expect(disk.images.get(first)![4]).toBe(1);
      expect(disk.images.has("/notes/images/Meeting-notes-2026-11-09-153012-2.png")).toBe(true);
      expect(app.view.state.doc.toString().endsWith(" after\n![image](images/Meeting-notes-2026-11-09-153012-2.png)")).toBe(true);
      // And it is shown from the disk.
      expect(await loadNoteImage(app, "images/Meeting-notes-2026-11-09-153012-2.png")).toMatch(/^data:image\/png;base64,/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unsaved note asks to be saved first, and only images a note can show are pasted", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "text" });
    app.newDoc();
    await pasteImage(app, app.view, png());
    expect(disk.images.size).toBe(0);
    expect(app.view.state.doc.toString()).toBe("");
    await app.openFile("/notes/a.txt");
    await pasteImage(app, app.view, new Blob(["x"], { type: "image/tiff" }));
    expect(disk.images.size).toBe(0);
    expect(app.view.state.doc.toString()).toBe("text");
  });

  it("the images folder of the settings is used, and cannot point outside the note's folder", async () => {
    const { app, disk } = await start({
      "/config/settings.json": SETTINGS(`, "images_folder": "attachments/shots"`),
      "/notes/a.md": "",
    });
    await app.openFile("/notes/a.md");
    app.view.contentDOM.blur();
    await pasteImage(app, app.view, png());
    expect([...disk.images.keys()][0]).toMatch(/^\/notes\/attachments\/shots\/a-.*\.png$/);
    expect(app.view.state.doc.toString()).toMatch(/^!\[image\]\(attachments\/shots\/a-.*\.png\)$/);
    for (const bad of ["../elsewhere", "C:\\\\Windows", "/etc", "a/../../b", ""]) {
      const { app: other } = await start({ "/config/settings.json": SETTINGS(`, "images_folder": ${JSON.stringify(bad)}`) });
      expect(other.settings.images_folder, bad).toBe("images");
    }
  });

  it("image files dropped on a note are saved under their own name, after the line", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "first line\nsecond line" });
    await app.openFile("/notes/a.txt");
    app.view.contentDOM.blur();
    const file = (name: string, type = "image/png") => new File([new Uint8Array([1, 2, 3])], name, { type });
    await dropImages(app, app.view, [file("My diagram.PNG"), file("notes.txt", "text/plain"), file("photo.jpg", "image/jpeg")], 3);
    expect([...disk.images.keys()]).toEqual(["/notes/images/My-diagram.png", "/notes/images/photo.jpg"]);
    expect(app.view.state.doc.toString()).toBe("first line\n![image](images/My-diagram.png)\n![image](images/photo.jpg)\nsecond line");
    // The same name again: a free one.
    await dropImages(app, app.view, [file("My diagram.PNG")], app.view.state.doc.length);
    expect(disk.images.has("/notes/images/My-diagram-2.png")).toBe(true);
  });

  it("the images no note uses are moved to the trash, after a confirmation", async () => {
    const { app, disk } = await start({
      "/notes/a.txt": "![image](images/used.png)\nsee also <img src=\"images/named.png\">",
      "/notes/sub/b.md": "![x](../images/up.png)",
    });
    for (const p of ["/notes/images/used.png", "/notes/images/named.png", "/notes/images/up.png", "/notes/images/old.png", "/notes/sub/images/old 2.png", "/notes/photos/trip.png"]) {
      disk.images.set(p, new Uint8Array([1]));
    }
    await app.openFile("/notes/a.txt");
    const done = deleteUnusedImages(app);
    await tick(10);
    expect(document.querySelector(".kn-modal-message")?.textContent).toContain("images/old.png");
    clickButton("Move to trash");
    await done;
    // Only the images of the images folders that no note shows or names.
    expect([...disk.images.keys()].sort()).toEqual(["/notes/images/named.png", "/notes/images/up.png", "/notes/images/used.png", "/notes/photos/trip.png"]);
  });
});

describe("templates", () => {
  it("today's note is made from the Daily note template of the user, once", async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 11, 9, 5), toFake: ["Date"] });
    try {
      const { app, disk } = await start({
        "/config/templates/Daily note.md": "# {{date}}\n- {{cursor}}\n",
        "/notes/work.txt": "",
      });
      disk.dirs.add("/notes");
      await app.openFolder("/notes");
      // (happy-dom: see the archive test; the editor is not focused here.)
      app.view.contentDOM.blur();
      app.view.focus = () => {};
      await openDailyNote(app);
      expect(disk.text("/notes/daily/2026-11-11.md")).toBe("# 2026-11-11\n- \n");
      expect(app.active?.path).toBe("/notes/daily/2026-11-11.md");
      expect(app.view.state.selection.main.head).toBe("# 2026-11-11\n- ".length);
      // Already there: opened as it is.
      app.view.dispatch({ changes: { from: app.view.state.doc.length, insert: "edited" } });
      await app.save(app.active!);
      await openDailyNote(app);
      expect(disk.text("/notes/daily/2026-11-11.md")).toBe("# 2026-11-11\n- \nedited");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("links between notes", () => {
  it("Ctrl+click opens the linked note, or creates it next to the note once confirmed", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "see [[b]] and [[ideas/new one]]", "/notes/sub/b.txt": "B" });
    disk.dirs.add("/notes");
    await app.openFolder("/notes");
    await app.openFile("/notes/a.txt");
    await openNoteLink(app, "b");
    expect(app.active?.path).toBe("/notes/sub/b.txt");
    await app.openFile("/notes/a.txt");
    const creating = openNoteLink(app, "ideas/new one");
    await tick(10);
    clickButton("Create");
    await creating;
    expect(disk.files.has("/notes/ideas/new one.txt")).toBe(true);
    expect(app.active?.path).toBe("/notes/ideas/new one.txt");
    // Never outside the folder.
    await openNoteLink(app, "../../etc/x");
    expect(document.querySelector(".kn-modal")).toBeNull();
  });
});

describe("tasks changed from a list (sidebar, board)", () => {
  it("are changed in their note, saved, and the note is not left open", async () => {
    const { app, disk } = await start({ "/notes/work.txt": "- call the bank - todo\n- write - ongoing\n" });
    const [t] = findTasks(disk.text("/notes/work.txt")!, app.taskCfg);
    expect(await changeTaskInNote(app, "/notes/work.txt", t, { status: "ongoing" })).toBe("- call the bank - ongoing\n- write - ongoing\n");
    expect(disk.text("/notes/work.txt")).toBe("- call the bank - ongoing\n- write - ongoing\n");
    expect(app.findDoc("/notes/work.txt")).toBeFalsy();
    // The line changed meanwhile: nothing is done.
    expect(await changeTaskInNote(app, "/notes/work.txt", t, { status: "done" })).toBeNull();
    expect(disk.text("/notes/work.txt")).toBe("- call the bank - ongoing\n- write - ongoing\n");
  });
});

describe("secrets", () => {
  const fill = (values: string[], button: string) => {
    const inputs = [...document.querySelectorAll<HTMLInputElement>(".kn-modal input[type=password]")];
    values.forEach((v, i) => (inputs[i].value = v));
    clickButton(button);
  };
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 200 && !fn(); i++) await tick(20);
  };

  it("the selection is encrypted in the note, and shown again with its password only", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "server: db1\nuser: admin password: hunter2\nend" });
    await app.openFile("/notes/a.txt");
    // (happy-dom: see the archive test; the dialogs give the focus back to the editor.)
    app.view.contentDOM.blur();
    app.view.focus = () => {};
    app.focusEditor = () => {};
    const line = app.view.state.doc.line(2);
    app.view.dispatch({ selection: { anchor: line.from + 12, head: line.to } });
    const encrypting = encryptSelection(app);
    await tick(10);
    fill(["short", "short"], "Encrypt");
    expect(document.querySelector(".kn-modal-error")?.textContent).toContain("At least 8");
    fill(["a good password", "a good password"], "Encrypt");
    await encrypting;
    const text = app.view.state.doc.toString();
    expect(text).not.toContain("hunter2");
    expect(text).toMatch(/^server: db1\nuser: admin \n-----BEGIN KILONOTE SECRET-----\n[\s\S]+\n-----END KILONOTE SECRET-----\nend$/);
    const [block] = app.view.state.field(secretsField).blocks;
    await app.save(app.active!);
    expect(disk.text("/notes/a.txt")).not.toContain("hunter2");

    const revealing = revealSecret(app, block);
    await tick(10);
    fill(["wrong password"], "Reveal");
    await until(() => !!document.querySelector(".kn-modal-error")?.textContent);
    expect(document.querySelector(".kn-modal-error")?.textContent).toContain("Wrong password");
    fill(["a good password"], "Reveal");
    await revealing;
    await until(() => !!document.querySelector(".kn-secret-text"));
    expect(document.querySelector<HTMLTextAreaElement>(".kn-secret-text")?.value).toBe("password: hunter2");
    // Changed, then saved: encrypted again, with the same password.
    const area = document.querySelector<HTMLTextAreaElement>(".kn-secret-text")!;
    area.value = "password: hunter3";
    area.dispatchEvent(new Event("input"));
    clickButton("Save");
    await until(() => !document.querySelector(".kn-secret-text"));
    const [again] = app.view.state.field(secretsField).blocks;
    const { decryptSecret } = await import("../text/secrets");
    expect(await decryptSecret(app.view.state.sliceDoc(again.from, again.to), "a good password")).toBe("password: hunter3");
  });
});

describe("secrets and Replace in files", () => {
  it("the lines of a secret are never changed", async () => {
    const block = "-----BEGIN KILONOTE SECRET-----\nAAAA10AA\n-----END KILONOTE SECRET-----";
    const { app, disk } = await start({ "/notes/s.txt": `price 10\n${block}\nend 10\n` });
    await replaceInFiles(app, ["/notes/s.txt"], /10/g, "20", true);
    expect(disk.text("/notes/s.txt")).toBe(`price 20\n${block}\nend 20\n`);
  });
});

describe("command palette", () => {
  it("lists the commands run lately first, until something is typed", async () => {
    const { app } = await start({});
    localStorage.setItem("kilonote-recent-commands", JSON.stringify(["view.board", "file.dailyNote"]));
    const ids = (q: string) => provideCommands(app, q).items.map((i) => i.value);
    expect(ids("").slice(0, 2)).toEqual(["view.board", "file.dailyNote"]);
    expect(ids("save")[0]).not.toBe("view.board");
    localStorage.setItem("kilonote-recent-commands", "not json");
    expect(ids("").length).toBeGreaterThan(10);
    localStorage.removeItem("kilonote-recent-commands");
  });
});

describe("reading the notes of the folder", () => {
  it("reads again only the files that changed", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "A", "/notes/b.txt": "B", "/notes/c.txt": "C" });
    const paths = ["/notes/a.txt", "/notes/b.txt", "/notes/c.txt", "/notes/gone.txt"];
    expect(await app.readFiles(paths)).toEqual(["A", "B", "C", null]);
    expect(disk.reads).toBe(3);
    expect(await app.readFiles(paths)).toEqual(["A", "B", "C", null]);
    expect(disk.reads).toBe(3); // nothing changed: nothing read
    disk.external("/notes/b.txt", "B changed");
    expect(await app.readFiles(paths)).toEqual(["A", "B changed", "C", null]);
    expect(disk.reads).toBe(4);
    // An open note: its text in the editor, unsaved edits included.
    await app.openFile("/notes/c.txt");
    app.view.contentDOM.blur();
    app.view.dispatch({ changes: { from: 1, insert: "!" } });
    expect((await app.readFiles(paths))[2]).toBe("C!");
  });
});

describe("tabs restored from the session", () => {
  const tab = (path: string | null, extra: Record<string, unknown> = {}) => ({ path, title: path ?? "Untitled 1", color: null, group: null, eol: "\n", cursor: 0, scrollTop: 0, ...extra });
  const session = (tabs: unknown[], active: number) =>
    JSON.stringify({ version: 1, workspace: null, recent: [], tabs, active, groups: [], sidebar: { visible: false, width: 260, panel: "files", expanded: [] } });

  it("get their editor only when they are first needed", async () => {
    const { app, disk } = await start({
      "/notes/a.txt": "- call the bank - todo\n",
      "/notes/b.txt": "b on disk",
      "/notes/c.md": "# C",
      "/config/session.json": session([tab("/notes/a.txt"), tab("/notes/b.txt", { content: "b draft", mtime: 1000 }), tab("/notes/c.md", { cursor: 2 }), tab(null, { content: "a new idea" })], 2),
    });
    const [a, b, c, draft] = app.docs;
    expect(app.active).toBe(c);
    expect(app.docs.map((d) => app.stateMade(d))).toEqual([false, false, true, false]);
    // Their text, their state of saving, the session: without making their editor.
    expect([app.docText(a), app.docText(b), app.docText(draft)]).toEqual(["- call the bank - todo\n", "b draft", "a new idea"]);
    expect([a.dirty, b.dirty, draft.dirty]).toEqual([false, true, true]);
    expect(await app.readFiles(["/notes/a.txt", "/notes/b.txt"])).toEqual(["- call the bank - todo\n", "b draft"]);
    await saveSessionNow(app);
    const saved = JSON.parse(disk.text("/config/session.json")!);
    expect(saved.tabs.map((t: { content?: string }) => t.content ?? null)).toEqual([null, "b draft", null, "a new idea"]);
    // A change of settings does not make them either.
    await app.updateSetting("tab_size", 2);
    expect(app.docs.map((d) => app.stateMade(d))).toEqual([false, false, true, false]);
    // Shown: made, with its text and the settings of the moment.
    app.activate(a);
    expect(app.stateMade(a)).toBe(true);
    expect(app.view.state.doc.toString()).toBe("- call the bank - todo\n");
    expect(app.view.state.tabSize).toBe(2);
    // Edited in the background (a task from the board): made, changed, saved.
    const { changeTaskInNote } = await import("./tasks");
    const { findTasks } = await import("../text/tasks");
    app.activate(c);
    const [t] = findTasks(app.docText(a), app.taskCfg);
    expect(await changeTaskInNote(app, "/notes/a.txt", t, { status: "done" })).toContain("- call the bank - done");
    expect(disk.text("/notes/a.txt")).toContain("- call the bank - done");
    expect(a.dirty).toBe(false);
  });
});

describe("Kilo, the assistant", () => {
  it("is in a corner of the editor, and leaves when the setting is turned off", async () => {
    const { app } = await start({ "/notes/a.txt": "text" });
    await app.openFile("/notes/a.txt");
    await vi.waitFor(() => expect(document.querySelector("#editor-host .kn-kilo .kn-kilo-body svg")).not.toBeNull());
    await app.updateSetting("assistant", false);
    await vi.waitFor(() => expect(document.querySelector(".kn-kilo")).toBeNull());
    await app.updateSetting("assistant", true);
    await vi.waitFor(() => expect(document.querySelectorAll(".kn-kilo")).toHaveLength(1));
    await app.updateSetting("assistant", false);
  });
});


describe("notes out of KiloNote: copy, export, print", () => {
  it("Copy as rich text puts the note, styled, and its plain text on the clipboard", async () => {
    const { app } = await start({ "/notes/a.txt": `# Week\n- call the bank - todo\n${SECRET_BEGIN}\nQUJD\n${SECRET_END}\n` });
    await app.openFile("/notes/a.txt");
    const written: Record<string, string>[] = [];
    vi.stubGlobal("ClipboardItem", class {
      constructor(public data: Record<string, Blob>) {}
    });
    const write = async (items: { data: Record<string, Blob> }[]) => {
      for (const it of items) written.push(Object.fromEntries(await Promise.all(Object.entries(it.data).map(async ([k, b]) => [k, await b.text()]))));
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    try {
      await copyRich(app);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(written).toHaveLength(1);
    expect(written[0]["text/html"]).toMatch(/^<div style="[^"]+">/);
    expect(written[0]["text/html"]).toContain("call the bank");
    // The secret stays hidden, in both.
    expect(written[0]["text/html"]).not.toContain("QUJD");
    expect(written[0]["text/plain"]).not.toContain("QUJD");
    expect(written[0]["text/plain"]).toContain("- call the bank - todo");
  });

  it("Export as HTML writes a whole page, never over an open note", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "# Plan\n- write - ongoing\n" }, { savePath: "/notes/a.html" });
    await app.openFile("/notes/a.txt");
    await exportHtml(app);
    expect(disk.text("/notes/a.html")).toMatch(/^<!DOCTYPE html>[\s\S]*<title>a<\/title>[\s\S]*Plan[\s\S]*ongoing/);
    const other = await start({ "/notes/a.txt": "A", "/notes/b.txt": "B" }, { savePath: "/notes/b.txt" });
    await other.app.openFile("/notes/b.txt");
    await other.app.openFile("/notes/a.txt");
    await exportHtml(other.app);
    expect(other.disk.text("/notes/b.txt")).toBe("B");
    expect([...document.querySelectorAll(".kn-toast")].some((t) => t.textContent?.includes("is open in a tab"))).toBe(true);
  });

  it("Print shows only the note to the printer, and takes it away after", async () => {
    const { app, disk } = await start({ "/notes/a.txt": `printed text\n${SECRET_BEGIN}\nQUJD\n${SECRET_END}\n` });
    await app.openFile("/notes/a.txt");
    await printNote(app);
    expect(disk.prints).toBe(1);
    const page = document.getElementById("kn-print")!;
    expect(page.textContent).toContain("printed text");
    expect(page.textContent).not.toContain("QUJD");
    window.dispatchEvent(new Event("afterprint"));
    expect(document.getElementById("kn-print")).toBeNull();
  });
});

describe("pinned and recent notes", () => {
  beforeEach(() => localStorage.clear());

  it("Go to file shows the pinned notes first, then the ones opened lately", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "", "/notes/b.txt": "", "/notes/c.txt": "", "/notes/d.txt": "" });
    disk.dirs.add("/notes");
    await app.openFolder("/notes");
    await app.openFile("/notes/c.txt");
    await app.openFile("/notes/b.txt");
    setPinned("/notes/d.txt", true);
    const list = (q: string) => provideFiles(app, q).items.map((i) => `${i.label}${i.hint ? ` (${i.hint})` : ""}`);
    expect(list("")).toEqual(["d.txt (pinned)", "b.txt (open)", "c.txt (open)", "a.txt"]);
    // An equally good match: the pinned one first.
    expect(list("txt")[0]).toBe("d.txt (pinned)");
    // The explorer: a section above the tree, and a mark in it.
    await vi.waitFor(() => expect(document.querySelector(".sb-pins .sb-name")?.textContent).toBe("d.txt"));
    await vi.waitFor(() => expect(document.querySelector('.sb-tree .sb-row[data-path="/notes/d.txt"] .sb-pin-mark')).not.toBeNull());
  });

  it("a pinned note keeps its pin when it is renamed", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "" });
    disk.dirs.add("/notes");
    await app.openFolder("/notes");
    setPinned("/notes/a.txt", true);
    const renaming = renamePath(app, "/notes/a.txt");
    await tick(10);
    const input = document.querySelector<HTMLInputElement>(".kn-modal input")!;
    input.value = "z.txt";
    clickButton("Rename");
    await renaming;
    expect(pinnedNotes()).toEqual(["/notes/z.txt"]);
  });
});

describe("quick inserts after /", () => {
  it("the menu does not come back when the note is shown again", async () => {
    const { app } = await start({ "/notes/a.txt": "", "/notes/b.txt": "" });
    // (happy-dom: see the archive test; the editor is not focused here.)
    app.view.contentDOM.blur();
    app.view.focus = () => {};
    const a = (await app.openFile("/notes/a.txt"))!;
    app.view.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 }, userEvent: "input.type" });
    expect(slashMenu(app.view.state)).not.toBeNull();
    await app.openFile("/notes/b.txt");
    app.activate(a);
    expect(slashMenu(app.view.state)).toBeNull();
    expect(app.view.state.doc.toString()).toBe("/");
  });

  it("are not offered in code files, nor when turned off", async () => {
    const { app } = await start({ "/notes/a.json": "", "/notes/b.txt": "" });
    app.view.contentDOM.blur();
    app.view.focus = () => {};
    await app.openFile("/notes/a.json");
    app.view.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 }, userEvent: "input.type" });
    expect(slashMenu(app.view.state)).toBeNull();
    await app.updateSetting("slash_commands", false);
    await app.openFile("/notes/b.txt");
    app.view.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 }, userEvent: "input.type" });
    expect(slashMenu(app.view.state)).toBeNull();
  });
});

describe("image files", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("open in the image viewer, which goes through the images of their folder", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "text" });
    disk.images.set("/notes/shot-1.png", PNG);
    disk.images.set("/notes/shot-2.jpg", PNG);
    expect(await app.openFile("/notes/shot-1.png")).toBeNull();
    expect(app.docs).toHaveLength(0);
    expect(document.querySelector(".kn-viewer-name")?.textContent).toBe("shot-1.png");
    expect(document.querySelector<HTMLImageElement>(".kn-viewer-img")?.src).toMatch(/^data:image\/png/);
    expect(document.querySelector(".kn-viewer-count")?.textContent).toBe("1 / 2");
    // (Not refused: no "not a text file".)
    expect([...document.querySelectorAll(".kn-toast")].some((t) => t.textContent?.includes("not a text file"))).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector(".kn-viewer-name")?.textContent).toBe("shot-2.jpg"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".kn-viewer")).toBeNull();
  });

  it("dropped outside a note: the viewer goes through them; text files open as notes", async () => {
    const { app, disk } = await start({ "/notes/a.txt": "text" });
    disk.images.set("/x/b.png", PNG);
    disk.images.set("/y/c.png", PNG);
    const stat = app.backend.stat;
    app.backend.stat = async (p) => (disk.images.has(p) ? { mtime: 1, size: 8, isDir: false } : stat(p));
    await app.openPaths(["/x/b.png", "/notes/a.txt", "/y/c.png"]);
    expect(app.docs.map((d) => d.path)).toEqual(["/notes/a.txt"]);
    expect(document.querySelector(".kn-viewer-name")?.textContent).toBe("b.png");
    expect(document.querySelector(".kn-viewer-count")?.textContent).toBe("1 / 2");
  });

  it("an image that cannot be read says so in the viewer", async () => {
    const { app } = await start({});
    await app.openFile("/notes/gone.png");
    expect(document.querySelector(".kn-viewer-error")?.textContent).toContain("cannot be shown");
  });
});

describe("crafted Markdown", () => {
  it("a note nested thousands of levels deep opens as plain text, a real one as Markdown", async () => {
    const { app } = await start({ "/notes/bomb.md": " - ".repeat(1_000) + "x", "/notes/real.md": "# Real\n\n- **a**\n  - b\n" });
    const { loadLanguage } = await import("../editor/setup");
    await loadLanguage("markdown");
    const bomb = (await app.openFile("/notes/bomb.md"))!;
    expect(bomb.lang).toBe("text");
    expect([...document.querySelectorAll(".kn-toast")].some((t) => t.textContent?.includes("nested unusually deep"))).toBe(true);
    const real = (await app.openFile("/notes/real.md"))!;
    expect(real.lang).toBe("markdown");
    // Asked for by hand: still refused.
    app.setLang(bomb, "markdown");
    expect(bomb.lang).toBe("text");
  });
});
