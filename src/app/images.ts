// Images in notes, on the app side: a pasted image is saved next to the note
// (in the images folder of the settings) and its reference is written at the
// cursor; the images a note shows are read from the disk as data URLs (the
// page loads nothing else: see the content security policy).

import type { EditorView } from "@codemirror/view";
import { dirname, isInside, join, stem } from "../core/path";
import { setImageHost } from "../editor/images";
import { extForMime, IMAGE_TYPES, imageMarkup, MAX_IMAGE_SIZE, pastedImageName, resolveImage } from "../text/images";
import { toast } from "../ui/overlay";
import type { App } from "./app";

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

/** An image referenced by the active note, as a data URL (null if it cannot be shown). */
export function loadNoteImage(app: App, ref: string): Promise<string | null> {
  const path = resolveImage(ref, app.active?.path ? dirname(app.active.path) : null);
  if (!path) return Promise.resolve(null);
  const known = cache.get(path);
  if (known) return known;
  const mime = IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
  const url = app.backend.readImage(path).then((bytes) => dataUrl(bytes, mime)).catch(() => null);
  remember(path, url);
  // A missing image may appear later (copied in): not remembered as missing.
  void url.then((u) => u === null && cache.get(path) === url && cache.delete(path));
  return url;
}

/**
 * Saves a pasted image next to the note (`images/<note>-<date>-<time>.png`) and
 * writes its reference at the cursor, on a line of its own.
 */
export async function pasteImage(app: App, view: EditorView, image: Blob): Promise<void> {
  const doc = app.active;
  if (!doc || view !== app.view) return;
  if (!doc.path) {
    toast("Save the note first: a pasted image is stored next to it.", { action: { label: "Save…", run: () => void app.saveAs(doc) } });
    return;
  }
  const ext = extForMime(image.type);
  if (!ext) {
    toast(`This kind of image (${image.type || "unknown"}) cannot be pasted: PNG, JPEG, GIF, WebP and BMP can.`, { kind: "error" });
    return;
  }
  if (image.size > MAX_IMAGE_SIZE) {
    toast("This image is too large to be pasted (50 MB at most).", { kind: "error" });
    return;
  }
  const bytes = new Uint8Array(await image.arrayBuffer());
  const folder = app.settings.images_folder;
  const dir = join(dirname(doc.path), ...folder.split(/[\\/]+/).filter(Boolean));
  const now = new Date();
  let name = "";
  for (let n = 1; ; n++) {
    name = pastedImageName(stem(doc.path), now, ext, n);
    try {
      await app.backend.writeImage(join(dir, name), bytes);
      break;
    } catch (e) {
      if (String(e).includes("exists") && n < 100) continue;
      toast(`Could not save the image: ${e}`, { kind: "error" });
      return;
    }
  }
  remember(join(dir, name), dataUrl(bytes, IMAGE_TYPES[ext]).catch(() => null));
  // The new image (and its folder) in the file tree.
  if (app.workspace && isInside(dir, app.workspace)) void app.refreshWorkspaceFiles().then(() => app.sidebar.refreshTree());
  // On a line of its own, where the cursor is now (the note may have changed meanwhile).
  const state = doc.state;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  const endLine = state.doc.lineAt(sel.to);
  const before = sel.from > line.from ? "\n" : "";
  const after = sel.to < endLine.to ? "\n" : "";
  const markup = imageMarkup(folder, name);
  app.applyToDoc(doc, {
    changes: { from: sel.from, to: sel.to, insert: before + markup + after },
    selection: { anchor: sel.from + before.length + markup.length },
    scrollIntoView: true,
    userEvent: "input.paste",
  });
}

export function installImages(app: App) {
  setImageHost({
    load: (ref) => loadNoteImage(app, ref),
    paste: (view, image) => void pasteImage(app, view, image),
  });
}
