// @vitest-environment happy-dom
// Random sequences of pane and tab operations: after each one, the window must
// be in a coherent state (every tab in a pane that exists, every pane showing
// one of its tabs, the layout and the page holding the same panes), and the
// session must bring the same panes back.

import { beforeEach, describe, expect, it } from "vitest";
import type { Backend, Meta } from "../core/backend";
import { App } from "./app";
import { panesInOrder, type Side, type Zone } from "./layout";
import { saveSessionNow } from "./session";
import { dropOn } from "../ui/panes";

const DOM = `
  <div id="app"><aside id="sidebar"></aside><div id="sb-resizer"></div>
    <main id="main"><div id="editor-area"><div id="editor-host"></div><div id="preview" hidden></div></div><div id="welcome" hidden></div></main>
    <footer id="statusbar"></footer></div>
  <div id="overlay-root"></div>`;

/** A small in-memory disk: enough for opening, saving and the session. */
function diskBackend(files: Record<string, string>): Backend {
  const disk = new Map(Object.entries(files).map(([p, t]) => [p, { text: t, mtime: 1000 }]));
  const meta = (p: string): Meta | null => {
    const f = disk.get(p);
    if (f) return { mtime: f.mtime, size: f.text.length, isDir: false };
    return ["/", "/notes", "/config"].includes(p) ? { mtime: 0, size: 0, isDir: true } : null;
  };
  const noop = async () => {};
  return new Proxy({} as Backend, {
    get(_, key: string) {
      switch (key) {
        case "kind": return "web";
        case "platform": return "linux";
        case "windowLabel": return "main";
        case "configDir": return async () => "/config";
        case "readText": return async (p: string) => {
          const f = disk.get(p);
          if (!f) throw new Error("not found");
          return { text: f.text, encoding: "UTF-8", mtime: f.mtime };
        };
        case "writeText": return async (p: string, text: string) => {
          disk.set(p, { text, mtime: 2000 });
          return { mtime: 2000, encoding: "UTF-8" };
        };
        case "stat": return async (p: string) => meta(p);
        case "listDir": return async () => [];
        case "walk": return async () => [...disk.keys()].filter((p) => p.startsWith("/notes/"));
        case "readChanged": return async (paths: string[]) => paths.map(() => null);
        case "windowPaths": return async () => [];
        case "windowCount": return async () => 1;
        case "onFileDrop": case "onOpenRequest": case "onCloseRequested": case "onSettingsChanged": case "setTitle": case "setDark":
        case "broadcastSettingsChanged":
          return () => {};
        default: return noop;
      }
    },
  });
}

/** A seeded random generator (mulberry32): a failure can be replayed. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILES = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((n) => [`/notes/${n}.txt`, `${n}\n`]));
const SIDES: Side[] = ["left", "right", "top", "bottom"];
const ZONES: Zone[] = [...SIDES, "center"];

function check(app: App, step: string) {
  const ids = app.panes.map((p) => p.id);
  const where = `after ${step}`;
  expect([...panesInOrder(app.layout)].sort(), where).toEqual([...ids].sort());
  expect(app.panes.includes(app.pane), where).toBe(true);
  expect(new Set(app.docs).size, where).toBe(app.docs.length);
  expect(app.active, where).toBe(app.pane.active);
  for (const d of app.docs) expect(ids, `${where}: the pane of ${d.title}`).toContain(d.pane);
  for (const d of app.docs) if (d.groupId) expect(app.groups.map((g) => g.id), `${where}: the group of ${d.title}`).toContain(d.groupId);
  for (const g of app.groups) expect(app.docs.some((d) => d.groupId === g.id), `${where}: group ${g.id} has tabs`).toBe(true);
  const root = document.querySelector(".kn-split-root")!;
  expect(root.querySelectorAll(".kn-pane").length, where).toBe(app.panes.length);
  for (const p of app.panes) {
    const mine = app.docsOf(p);
    expect(root.contains(p.el), where).toBe(true);
    expect(p.el.classList.contains("focused"), where).toBe(p === app.pane);
    if (mine.length) expect(p.active, `${where}: pane ${p.id} shows a tab`).not.toBeNull();
    expect(p.el.classList.contains("empty"), where).toBe(!p.active);
    if (p.active) {
      expect(mine, where).toContain(p.active);
      // The editor shows the tab's own text.
      expect(p.view.state.doc.toString(), `${where}: text of ${p.active.title}`).toBe(p.active.state.doc.toString());
    }
    // (A collapsed group shows only the pane's tab among its tabs.)
    const collapsed = (d: (typeof mine)[number]) => !!d.groupId && !!app.groups.find((g) => g.id === d.groupId)?.collapsed;
    const shown = mine.filter((d) => !collapsed(d) || d === p.active);
    expect(p.tabbarEl.querySelectorAll(".kn-tab").length, `${where}: tabs of pane ${p.id}`).toBe(shown.length);
  }
  // No other pane without tabs than in a split (a single pane without tabs: the welcome screen).
  // (The welcome screen may sit in a pane closed since: out of the page, it shows nowhere.)
  const w = document.getElementById("welcome");
  const welcome = !!w && !w.hidden;
  expect(welcome, where).toBe(app.panes.length === 1 && !app.pane.active);
}

/** The tabs of each pane (that has some), in order, as the session keeps them. */
const shape = (app: App) =>
  panesInOrder(app.layout)
    .map((id) => app.docsOf(app.paneById(id)!).filter((d) => d.path || app.docText(d).length).map((d) => app.docName(d)))
    .filter((l) => l.length);

describe("panes under random operations", () => {
  beforeEach(() => {
    document.body.innerHTML = DOM;
    localStorage.clear();
  });

  // (FUZZ_SEEDS=100 for a longer hunt.)
  const seeds = Array.from({ length: Number(process.env.FUZZ_SEEDS ?? 6) }, (_, i) => i + Number(process.env.FUZZ_FIRST ?? 1));
  for (const seed of seeds) {
    it(`stay coherent (seed ${seed})`, async () => {
      const rnd = random(seed);
      const pick = <T>(list: T[]): T | undefined => list[Math.floor(rnd() * list.length)];
      const backend = diskBackend({ "/config/settings.json": '{ "autosave": false }', ...FILES });
      let app = new App(backend);
      await app.init();
      const paths = Object.keys(FILES);
      const ops: [string, () => unknown][] = [
        ["open", () => app.openFile(pick(paths)!)],
        ["new note", () => app.newDoc({ text: rnd() < 0.5 ? "draft" : "" })],
        ["type", () => app.active && app.view.dispatch({ changes: { from: 0, insert: "x" } })],
        ["split", () => app.splitActive(pick(SIDES)!)],
        ["split a tab", () => { const d = pick(app.docs); if (d) app.splitDoc(d, pick(SIDES)!); }],
        ["move to a pane", () => { const d = pick(app.docs); if (d) app.moveDocToPane(d, pick(app.panes)!); }],
        ["place", () => {
          const d = pick(app.docs);
          const p = pick(app.panes)!;
          if (d) app.placeDoc(d, p, pick([...app.docsOf(p), null]) ?? null);
        }],
        ["close a tab", () => { const d = pick(app.docs); if (d) return app.closeDoc(d, { force: true }); }],
        ["close a pane", () => app.closePane(pick(app.panes)!)],
        ["join", () => rnd() < 0.3 && app.joinPanes()],
        ["focus", () => app.focusPane(pick(app.panes)!)],
        ["next pane", () => app.focusNextPane(rnd() < 0.5 ? 1 : -1)],
        ["activate", () => { const d = pick(app.docs); if (d) app.activate(d); }],
        ["move to the next pane", () => { const d = pick(app.docs); if (d) app.moveToNextPane(d); }],
        ["open to the side", () => app.openToSide(pick(paths)!)],
        ["drop a tab", () => { const d = pick(app.docs); if (d) return dropOn(app, { kind: "zone", pane: pick(app.panes)!, zone: pick(ZONES)! }, { doc: d }); }],
        ["drop a file", () => dropOn(app, { kind: "zone", pane: pick(app.panes)!, zone: pick(ZONES)! }, { path: pick(paths)! })],
        ["drop on tabs", () => {
          const d = pick(app.docs);
          const p = pick(app.panes)!;
          if (d) return dropOn(app, { kind: "tabs", pane: p, before: pick([...app.docsOf(p), null]) ?? null }, { doc: d });
        }],
        ["cycle", () => app.cycleTab(rnd() < 0.5 ? 1 : -1)],
        ["group", () => {
          const d = pick(app.docs);
          if (!d) return;
          let g = pick(app.groups);
          if (!g || rnd() < 0.3) {
            g = { id: `g${i}`, name: "G", color: "blue", collapsed: false };
            app.groups.push(g);
          }
          app.addToGroup(d, g.id);
        }],
        ["collapse a group", () => { const g = pick(app.groups); if (g) app.toggleGroup(g); }],
      ];
      let i = 0;
      for (i = 0; i < Number(process.env.FUZZ_STEPS ?? 300); i++) {
        const [name, run] = pick(ops)!;
        // (happy-dom fires selectionchange synchronously, which no browser does: CodeMirror
        // then refuses an update inside an update. Without the focus, it does not happen.)
        (document.activeElement as HTMLElement | null)?.blur();
        await run();
        check(app, `#${i} ${name}`);
        // Now and then, the window is closed and opened again: the same panes come back.
        if (i % 60 === 59) {
          const before = shape(app);
          saveSessionNow(app);
          await new Promise((r) => setTimeout(r, 0));
          document.body.innerHTML = DOM;
          app = new App(backend);
          await app.init();
          check(app, `#${i} restore`);
          expect(shape(app), `#${i} restore`).toEqual(before);
        }
      }
    }, 60_000);
  }
});
