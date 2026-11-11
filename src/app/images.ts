// Images in notes, on the app side: a pasted or dropped image is saved next to
// the note (in the images folder of the settings) and its reference is written
// in the note; the images a note shows are read from the disk as data URLs (the
// page loads nothing else: see the content security policy). The images no
// note uses any more can be moved to the trash.

import type { EditorView } from "@codemirror/view";
import { basename, dirname, isInside, join, pathKey, relative, stem } from "../core/path";
import { setImageHost } from "../editor/images";
import {
  droppedImageName, extForMime, IMAGE_TYPES, imageMarkup, imageRefs, isImageFile, MAX_IMAGE_SIZE, pastedImageName, resolveImage,
} from "../text/images";
import { confirm, toast } from "../ui/overlay";
import type { App, Doc } from "./app";

/** The images shown lately, by file (a few dozen at most). */
const cache = new Map<string, Promise<string | null>>();
const CACHE_SIZE = 40;

function remember(path: string, url: Promise<string | null>) {
  cache.delete(path);
  cache.set(path, url);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

function dataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }));
  });
}

const mimeOf = (path: string) => IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];

/** An image referenced by the active note, as a data URL (null if it cannot be shown). */
export function loadNoteImage(app: App, ref: string): Promise<string | null> {
  const path = resolveImage(ref, app.active?.path ? dirname(app.active.path) : null);
  if (!path) return Promise.resolve(null);
  const known = cache.get(path);
  if (known) return known;
  const url = app.backend.readImage(path).then((bytes) => dataUrl(bytes, mimeOf(path))).catch(() => null);
  remember(path, url);
  // A missing image may appear later (copied in): not remembered as missing.
  void url.then((u) => u === null && cache.get(path) === url && cache.delete(path));
  return url;
}

// --- Adding images to a note --------------------------------------------------

/** The note that receives an image: the active one, saved somewhere (an image is stored next to it). */
function receivingNote(app: App, view: EditorView): Doc | null {
  const doc = app.active;
  if (!doc || view !== app.view) return null;
  if (!doc.path) {
    toast("Save the note first: an image is stored next to it.", { action: { label: "Save…", run: () => void app.saveAs(doc) } });
    return null;
  }
  return doc;
}

/** The folder of the note's images (the `images_folder` setting, next to it). */
function imagesDir(app: App, notePath: string): string {
  return join(dirname(notePath), ...app.settings.images_folder.split(/[\\/]+/).filter(Boolean));
}

/**
 * Saves an image in the note's images folder, under the first free name
 * (`nameFor(1)`, `nameFor(2)`…: an existing file is never written over).
 * Returns the reference to write in the note, or null (a toast said why).
 */
async function saveImage(app: App, notePath: string, bytes: Uint8Array, nameFor: (n: number) => string): Promise<string | null> {
  const dir = imagesDir(app, notePath);
  for (let n = 1; n < 100; n++) {
    const name = nameFor(n);
    try {
      await app.backend.writeImage(join(dir, name), bytes);
      remember(join(dir, name), dataUrl(bytes, mimeOf(name)).catch(() => null));
      return imageMarkup(app.settings.images_folder, name);
    } catch (e) {
      if (String(e).includes("exists")) continue;
      toast(`Could not save the image: ${e}`, { kind: "error" });
      return null;
    }
  }
  toast("Could not save the image: too many images with this name.", { kind: "error" });
  return null;
}

/** The image is fine to add: a type a note can show, not too large (otherwise a toast says why). */
function acceptable(type: string, size: number): boolean {
  if (!extForMime(type)) {
    toast(`This kind of image (${type || "unknown"}) cannot be added: PNG, JPEG, GIF, WebP, BMP and SVG can.`, { kind: "error" });
    return false;
  }
  if (size > MAX_IMAGE_SIZE) {
    toast("This image is too large (50 MB at most).", { kind: "error" });
    return false;
  }
  return true;
}

/**
 * Writes image references in the note, each on a line of its own: at the cursor
 * (a paste), or after the line at `at` (a drop).
 */
function insertRefs(app: App, doc: Doc, refs: string[], at?: number) {
  // The new images (and their folder) in the file tree.
  if (app.workspace && doc.path && isInside(imagesDir(app, doc.path), app.workspace)) {
    void app.refreshWorkspaceFiles().then(() => app.sidebar.refreshTree());
  }
  const state = doc.state;
  const markup = refs.join("\n");
  let from: number;
  let to: number;
  if (at == null) ({ from, to } = state.selection.main);
  else from = to = state.doc.lineAt(Math.min(at, state.doc.length)).to;
  const before = from > state.doc.lineAt(from).from ? "\n" : "";
  const after = to < state.doc.lineAt(to).to ? "\n" : "";
  app.applyToDoc(doc, {
    changes: { from, to, insert: before + markup + after },
    selection: { anchor: from + before.length + markup.length },
    scrollIntoView: true,
    userEvent: at == null ? "input.paste" : "input.drop",
  });
}

/** Saves a pasted image next to the note (`images/<note>-<date>-<time>.png`) and writes its reference at the cursor. */
export async function pasteImage(app: App, view: EditorView, image: Blob): Promise<void> {
  const doc = receivingNote(app, view);
  if (!doc?.path || !acceptable(image.type, image.size)) return;
  const bytes = new Uint8Array(await image.arrayBuffer());
  const now = new Date();
  const ext = extForMime(image.type)!;
  const ref = await saveImage(app, doc.path, bytes, (n) => pastedImageName(stem(doc.path!), now, ext, n));
  if (ref) insertRefs(app, doc, [ref]);
}

/** Image files dropped on the note (from the page): saved next to it under their own name, written after the line at `pos`. */
export async function dropImages(app: App, view: EditorView, files: File[], pos: number): Promise<void> {
  const doc = receivingNote(app, view);
  if (!doc?.path) return;
  const refs: string[] = [];
  for (const file of files) {
    if (!acceptable(file.type, file.size)) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ref = await saveImage(app, doc.path, bytes, (n) => droppedImageName(file.name, n));
    if (ref) refs.push(ref);
  }
  if (refs.length) insertRefs(app, doc, refs, pos);
}

/**
 * Files dropped from the system on the window. The images dropped on a note are
 * added to it: one already in the note's folder is referenced where it is, any
 * other is copied into its images folder. Returns the other files (to open).
 */
export async function dropImageFiles(app: App, paths: string[], at: { x: number; y: number } | undefined): Promise<string[]> {
  const doc = app.active;
  const target = at && document.elementFromPoint(at.x, at.y);
  const onNote = !!target && app.view.contentDOM.contains(target) && (doc?.lang === "text" || doc?.lang === "markdown");
  const images = onNote ? paths.filter(isImageFile) : [];
  if (!images.length || !doc) return paths;
  const rest = paths.filter((p) => !images.includes(p));
  if (!receivingNote(app, app.view) || !doc.path) return rest;
  const noteDir = dirname(doc.path);
  const refs: string[] = [];
  for (const path of images) {
    if (isInside(path, noteDir)) {
      refs.push(imageMarkup("", relative(noteDir, path).replace(/\\/g, "/")));
      continue;
    }
    try {
      const bytes = await app.backend.readImage(path);
      const ref = await saveImage(app, doc.path, bytes, (n) => droppedImageName(basename(path), n));
      if (ref) refs.push(ref);
    } catch (e) {
      toast(`Could not add "${basename(path)}": ${e}`, { kind: "error" });
    }
  }
  const pos = app.view.posAtCoords(at!, false);
  if (refs.length) insertRefs(app, doc, refs, pos);
  return rest;
}

// --- Images no note uses -------------------------------------------------------

/**
 * The images of the images folders (`images/` by default) that no note of the
 * folder uses: neither referenced (`![…](images/a.png)`) nor even named in a note.
 * Images next to a note that could not be read are kept.
 */
export function unusedImages(files: string[], notes: { path: string; text: string | null }[], imagesFolder: string): string[] {
  const folderEnd = "/" + imagesFolder.split(/[\\/]+/).filter(Boolean).join("/").toLowerCase();
  const inImagesFolder = (p: string) => pathKey(dirname(p)).toLowerCase().endsWith(folderEnd);
  const used = new Set<string>();
  const unreadDirs: string[] = [];
  let allText = "";
  for (const note of notes) {
    if (note.text == null) {
      unreadDirs.push(dirname(note.path));
      continue;
    }
    allText += note.text.toLowerCase() + "\n";
    for (const line of note.text.split("\n")) {
      for (const ref of imageRefs(line)) {
        const p = resolveImage(ref, dirname(note.path));
        if (p) used.add(pathKey(p));
      }
    }
  }
  return files.filter((p) => {
    if (!isImageFile(p) || !inImagesFolder(p) || used.has(pathKey(p))) return false;
    if (unreadDirs.some((d) => isInside(p, d))) return false;
    const name = basename(p).toLowerCase();
    return !allText.includes(name) && !allText.includes(encodeURI(name));
  });
}

/** File: Delete unused images… (to the system trash, after a confirmation that lists them). */
export async function deleteUnusedImages(app: App): Promise<void> {
  const root = app.workspace ?? (app.active?.path ? dirname(app.active.path) : null);
  if (!root) {
    toast("Open a folder (or a saved note) first: its unused images are looked for there.");
    return;
  }
  let files: string[];
  if (app.workspace) {
    await app.refreshWorkspaceFiles();
    files = app.workspaceFiles;
  } else files = await app.backend.walk(root, app.settings.show_hidden_files, 20000);
  const notePaths = files.filter((p) => app.isNoteFile(p));
  const texts = await app.readFiles(notePaths);
  const unused = unusedImages(files, notePaths.map((path, i) => ({ path, text: texts[i] })), app.settings.images_folder);
  if (!unused.length) {
    toast(`No unused image: every image of the "${app.settings.images_folder}" folders is used by a note.`);
    return;
  }
  const shown = unused.slice(0, 8).map((p) => `• ${relative(root, p)}`);
  if (unused.length > shown.length) shown.push(`…and ${unused.length - shown.length} more`);
  const r = await confirm({
    title: `Move ${unused.length} unused image${unused.length > 1 ? "s" : ""} to the trash?`,
    message: `No note of this folder shows or names ${unused.length > 1 ? "them" : "it"}:\n${shown.join("\n")}\n\nYou can restore them from the system trash.`,
    okLabel: "Move to trash",
    danger: true,
  });
  if (r !== "ok") return;
  let failed = 0;
  for (const p of unused) await app.backend.trash(p).catch(() => failed++);
  await app.refreshWorkspaceFiles();
  app.sidebar.refreshTree();
  const moved = unused.length - failed;
  if (failed) toast(`${moved} image(s) moved to the trash, ${failed} could not be.`, { kind: "error" });
  else toast(`${moved} unused image${moved > 1 ? "s" : ""} moved to the trash.`);
}

export function installImages(app: App) {
  setImageHost({
    load: (ref) => loadNoteImage(app, ref),
    paste: (view, image) => void pasteImage(app, view, image),
    drop: (view, files, pos) => void dropImages(app, view, files, pos),
  });
}
