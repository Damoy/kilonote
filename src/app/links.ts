// Links between notes, on the app side: Ctrl+click on `[[a note]]` opens it (or
// offers to create it), typing `[[` offers the notes of the folder, and
// "Notes linking here" lists the notes that link to the active one.

import { fuzzyFilter } from "../core/fuzzy";
import { dirname, extname, join, relative } from "../core/path";
import { isSafeTarget, linkName, linksTo, resolveNoteLink, splitLink } from "../text/links";
import { confirm, toast } from "../ui/overlay";
import { openPicker } from "../ui/palette";
import type { App } from "./app";

/** The notes a link can point to: those of the open folder, or next to the active note. */
async function linkableNotes(app: App): Promise<string[]> {
  if (app.workspace) return app.workspaceFiles.filter((p) => app.isNoteFile(p));
  const dir = app.active?.path ? dirname(app.active.path) : null;
  if (!dir) return [];
  const entries = await app.backend.listDir(dir, false).catch(() => []);
  return entries.filter((e) => !e.isDir && app.isNoteFile(e.path)).map((e) => e.path);
}

const isNote = (app: App) => (p: string) => app.isNoteFile(p);

/** Ctrl+click on `[[target]]`: opens the note, or offers to create it next to the active one. */
export async function openNoteLink(app: App, link: string): Promise<void> {
  const from = app.active?.path ?? null;
  const { note: target, heading } = splitLink(link);
  if (target && !isSafeTarget(target)) {
    toast(`"${target}" is not a note of this folder.`, { kind: "error" });
    return;
  }
  const found = resolveNoteLink(link, from, await linkableNotes(app), isNote(app));
  if (found) {
    const doc = await app.openFile(found);
    if (doc && heading) goToHeading(app, heading);
    return;
  }
  if (!target) return;
  const base = from ? dirname(from) : app.workspace;
  if (!base) {
    toast("Save this note first: a linked note is created next to it.");
    return;
  }
  const ext = extname(target) && app.isNoteFile(target) ? "" : `.${(from && extname(from)) || "txt"}`;
  const path = join(base, ...target.split(/[\\/]+/).filter(Boolean)) + ext;
  const r = await confirm({ title: `Create "${target}"?`, message: `No note of this folder is called so. A new note will be created:\n${relative(app.workspace, path)}`, okLabel: "Create" });
  if (r !== "ok") return;
  try {
    await app.backend.createDir(dirname(path));
    await app.backend.createFile(path); // never over an existing file
  } catch (e) {
    toast(`Could not create the note: ${e}`, { kind: "error" });
    return;
  }
  await app.refreshWorkspaceFiles();
  app.sidebar.refreshTree();
  await app.openFile(path);
}

/** Shows the heading `# text` of the active note (the first one with that text, in any case). */
function goToHeading(app: App, heading: string) {
  const doc = app.active;
  if (!doc) return;
  const wanted = heading.toLowerCase();
  const lines = app.view.state.doc.toString().split("\n");
  const i = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#{1,6}\s+/, "").trim().toLowerCase() === wanted);
  if (i >= 0) app.reveal(doc, i + 1);
  else toast(`No heading "${heading}" in this note.`);
}

/** Picks a note of the folder; `insert` receives how to write a link to it. */
async function pickNote(app: App, placeholder: string, insert: (name: string) => void, cancel?: () => void) {
  const notes = (await linkableNotes(app)).filter((p) => !app.active?.path || p !== app.active.path);
  if (!notes.length) {
    toast("No other note to link to: open a folder of notes.");
    cancel?.();
    return;
  }
  const rel = (p: string) => relative(app.workspace ?? (app.active?.path ? dirname(app.active.path) : null), p).replace(/\\/g, "/");
  openPicker({
    placeholder,
    provide: (q) => ({
      items: fuzzyFilter(q, notes, rel).map(({ item, result }) => ({ label: rel(item), positions: result.positions, icon: "file", value: item })),
      empty: "No such note",
    }),
    pick: (it) => insert(linkName(it.value as string, app.workspace, notes, isNote(app))),
    cancel,
  });
}

/** `[[` was just typed: the note picked is written after it, with the closing `]]`. */
export function completeNoteLink(app: App) {
  const doc = app.active;
  if (!doc) return;
  void pickNote(app, "Link to a note…", (name) => {
    const at = app.view.state.selection.main.head;
    const closed = app.view.state.sliceDoc(at, at + 2) === "]]";
    const insert = closed ? name : `${name}]]`;
    app.view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + name.length + 2 }, userEvent: "input.complete" });
    app.view.focus();
  });
}

/** Edit: Link to a note… (writes `[[name]]` at the cursor). */
export function insertNoteLink(app: App) {
  if (!app.active) return;
  void pickNote(app, "Link to a note…", (name) => {
    const { from, to } = app.view.state.selection.main;
    const insert = `[[${name}]]`;
    app.view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.complete" });
    app.view.focus();
  });
}

/** Go to: Notes linking here (the backlinks of the active note). */
export async function showBacklinks(app: App) {
  const note = app.active?.path;
  if (!note) {
    toast("Save this note first: other notes link to it by its name.");
    return;
  }
  if (app.workspace) await app.refreshWorkspaceFiles();
  const notes = await linkableNotes(app);
  const texts = await app.readFiles(notes);
  const found = linksTo(note, notes.map((path, i) => ({ path, text: texts[i] })), notes, isNote(app));
  if (!found.length) {
    toast(`No note links to this one yet: write [[${linkName(note, app.workspace, notes, isNote(app))}]] in another note.`);
    return;
  }
  const root = app.workspace ?? dirname(note);
  openPicker({
    placeholder: `${found.length} line${found.length > 1 ? "s" : ""} linking to this note`,
    provide: (q) => ({
      items: fuzzyFilter(q, found, (f) => `${relative(root, f.path)} ${f.text}`).map(({ item }) => ({
        label: item.text,
        detail: `${relative(root, item.path)}:${item.line}`,
        icon: "file",
        value: item,
      })),
      empty: "No such line",
    }),
    pick: (it) => {
      const f = it.value as (typeof found)[number];
      void app.openFile(f.path, { line: f.line });
    },
  });
}
