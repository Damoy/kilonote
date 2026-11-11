// What the editor calls for the features loaded on first use (links between
// notes, secrets, templates): their code stays out of the start-up bundle.

import type { EditorState, TransactionSpec } from "@codemirror/state";
import { stem } from "../core/path";
import { editorHooks } from "../editor/decorations";
import { setSecretHost } from "../editor/secrets";
import { setSlashHost, type SlashItem } from "../editor/slash";
import { parseTask } from "../text/tasks";
import { BUILTIN_TEMPLATES, fillTemplate, type Template } from "../text/templates";
import { toast } from "../ui/overlay";
import type { App } from "./app";
import { setDueDate } from "./tasks";

const links = () => import("./links");
const secrets = () => import("./secrets");
const templates = () => import("./templates");

/** The templates offered after "/": the built-in ones until the user's are read (again after a while). */
let knownTemplates: readonly Template[] = BUILTIN_TEMPLATES;
let templatesRead = 0;

/** A template's text in the note: on the line of "/name" when it is empty, otherwise below it. */
function insertTemplate(app: App, t: Template) {
  return (state: EditorState, from: number, to: number): TransactionSpec => {
    const { text, cursor } = fillTemplate(t.text, new Date(), app.active ? stem(app.docName(app.active)) : "");
    const line = state.doc.lineAt(from);
    const rest = line.text.slice(0, from - line.from) + line.text.slice(to - line.from);
    if (!rest.trim()) return { changes: { from: line.from, to: line.to, insert: text }, selection: { anchor: line.from + cursor } };
    return { changes: [{ from, to, insert: "" }, { from: line.to, insert: `\n${text}` }], selection: { anchor: line.to - (to - from) + 1 + cursor } };
  };
}

/** The app's quick inserts: a link, a secret, a due date, the templates. */
function appSlashItems(app: App, state: EditorState): SlashItem[] {
  if (Date.now() - templatesRead > 10_000) {
    templatesRead = Date.now();
    void templates().then((m) => m.loadTemplates(app)).then((list) => (knownTemplates = list), () => {});
  }
  const line = state.doc.lineAt(state.selection.main.head);
  const items: SlashItem[] = [
    { name: "link", label: "Link to a note…", detail: "[[ ]]", keywords: "note wiki", run: () => void links().then((m) => m.insertNoteLink(app)) },
    {
      name: "secret",
      label: "Encrypt this line…",
      keywords: "password private lock",
      wholeLine: true,
      run: (view) => {
        const l = view.state.doc.lineAt(view.state.selection.main.head);
        if (!l.text.trim()) {
          toast("Write the private text first, then /secret on its line.");
          return;
        }
        // (Without the space left before "/secret".)
        view.dispatch({ selection: { anchor: l.from, head: l.from + l.text.trimEnd().length } });
        void secrets().then((m) => m.encryptSelection(app));
      },
    },
  ];
  // (The line as it will be once "/due" is removed: a task already.)
  if (parseTask(line.text.replace(/\s*\/\S*$/, "").replace(/\s\/\S*(?=\s)/, ""), app.taskCfg)) {
    items.push({ name: "due", label: "Due date…", detail: "@date", keywords: "deadline task", wholeLine: true, run: () => setDueDate(app) });
  }
  for (const t of knownTemplates) {
    items.push({ name: t.name.toLowerCase().replace(/\s+/g, "-"), label: `Template · ${t.name}`, keywords: "template", edit: insertTemplate(app, t) });
  }
  return items;
}

export function installEditorHooks(app: App) {
  editorHooks.openNote = (target) => void links().then((m) => m.openNoteLink(app, target));
  editorHooks.linkNote = () => void links().then((m) => m.completeNoteLink(app));
  setSlashHost((state) => appSlashItems(app, state));
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
