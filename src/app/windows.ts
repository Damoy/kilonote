// Moving a tab to another window, or to a new one.

import { toast } from "../ui/overlay";
import type { App, Doc } from "./app";

/**
 * A tab dropped outside the window: into the window under the pointer, or a
 * new window opened there (screen coordinates in CSS pixels).
 */
export async function dropTabOutside(app: App, doc: Doc, screenX: number, screenY: number) {
  if (!doc.path) {
    toast("Save app note first to move it to another window.", { action: { label: "Save", run: () => void app.saveAs(doc) } });
    return;
  }
  if (doc.dirty && !(await app.save(doc))) return;
  const target = await app.backend.windowAt(screenX, screenY).catch(() => null);
  if (target) await app.backend.sendPaths(target, [doc.path]);
  else await app.backend.openWindow([doc.path], undefined, { x: Math.max(0, screenX - 160), y: Math.max(0, screenY - 16) });
  await app.closeDoc(doc, { force: true });
}

/** Moves a saved note to a new window. */
export async function moveToNewWindow(app: App, doc: Doc) {
  if (!doc.path) {
    toast("Save app note first to move it to another window.", { action: { label: "Save", run: () => void app.saveAs(doc) } });
    return;
  }
  if (doc.dirty && !(await app.save(doc))) return;
  await app.backend.openWindow([doc.path]);
  await app.closeDoc(doc, { force: true });
}
