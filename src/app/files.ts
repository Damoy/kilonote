// File and folder operations of the explorer and the tabs: create, rename,
// move to the trash, copy a path.

import { basename, dirname, extname, isInside, join, relative, samePath } from "../core/path";
import { langForPath } from "../editor/setup";
import { confirm, prompt, toast } from "../ui/overlay";
import type { App } from "./app";

export async function createFileIn(app: App, dir: string) {
  const r = await prompt({ title: "New note", value: "note.txt", selectStem: true, okLabel: "Create", message: relative(app.workspace, dir) || undefined });
  if (!r?.value) return;
  const name = extname(r.value) ? r.value : `${r.value}.txt`;
  const path = join(dir, name);
  try {
    await app.backend.createFile(path);
  } catch (e) {
    toast(`Could not create: ${e}`, { kind: "error" });
    return;
  }
  await app.refreshWorkspaceFiles();
  app.sidebar.refreshTree();
  await app.openFile(path);
}

export async function createFolderIn(app: App, dir: string) {
  const r = await prompt({ title: "New folder", placeholder: "Folder name", okLabel: "Create" });
  if (!r?.value) return;
  try {
    await app.backend.createDir(join(dir, r.value));
    app.sidebar.expand(dir);
    app.sidebar.refreshTree();
  } catch (e) {
    toast(`Could not create: ${e}`, { kind: "error" });
  }
}

export async function renamePath(app: App, path: string) {
  const r = await prompt({ title: "Rename", value: basename(path), selectStem: true, okLabel: "Rename" });
  if (!r?.value || r.value === basename(path)) return;
  const target = join(dirname(path), r.value);
  for (const d of app.docs) if (d.dirty && d.path && (samePath(d.path, path) || isInside(d.path, path))) await app.save(d);
  try {
    await app.backend.rename(path, target);
  } catch (e) {
    toast(`Could not rename: ${e}`, { kind: "error" });
    return;
  }
  for (const d of app.docs) {
    if (!d.path) continue;
    if (samePath(d.path, path)) d.path = target;
    else if (isInside(d.path, path)) d.path = target + d.path.slice(path.length);
    else continue;
    d.title = basename(d.path);
    // "notes.txt" renamed "notes.md": the coloring follows.
    const lang = langForPath(d.path);
    if (lang !== d.lang) app.setLang(d, lang);
    const st = await app.backend.stat(d.path);
    if (st) d.mtime = st.mtime;
  }
  if (app.workspace && samePath(app.workspace, path)) app.workspace = target;
  app.emit("docs");
  await app.refreshWorkspaceFiles();
  app.sidebar.refreshTree();
}

export async function trashPath(app: App, path: string) {
  const r = await confirm({
    title: `Move "${basename(path)}" to the trash?`,
    message: "You can restore it from the system trash.",
    okLabel: "Move to trash",
    danger: true,
  });
  if (r !== "ok") return;
  try {
    await app.backend.trash(path);
  } catch (e) {
    toast(`Could not delete: ${e}`, { kind: "error" });
    return;
  }
  for (const d of [...app.docs]) if (d.path && (samePath(d.path, path) || isInside(d.path, path))) await app.closeDoc(d, { force: true });
  await app.refreshWorkspaceFiles();
  app.sidebar.refreshTree();
}

export async function copyText(text: string, what = "Path copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what, { timeout: 1500 });
  } catch {
    toast("Could not copy", { kind: "error" });
  }
}
