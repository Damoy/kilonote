// What the editor calls for the features loaded on first use (links between
// notes, secrets): their code stays out of the start-up bundle.

import { editorHooks } from "../editor/decorations";
import { setSecretHost } from "../editor/secrets";
import { toast } from "../ui/overlay";
import type { App } from "./app";

const links = () => import("./links");
const secrets = () => import("./secrets");

export function installEditorHooks(app: App) {
  editorHooks.openNote = (target) => void links().then((m) => m.openNoteLink(app, target));
  editorHooks.linkNote = () => void links().then((m) => m.completeNoteLink(app));
  let lastRefusal = 0;
  setSecretHost({
    reveal: (view, block) => view === app.view && void secrets().then((m) => m.revealSecret(app, block)),
    refused: () => {
      if (Date.now() - lastRefusal < 3000) return;
      lastRefusal = Date.now();
      setTimeout(() => toast("A secret only changes as a whole: click it to change its text."));
    },
  });
}
