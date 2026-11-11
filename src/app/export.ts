// Notes out of KiloNote: copied as rich text (for an e-mail or a chat), saved as
// an HTML page, or printed (the print dialog also saves a PDF). The note is put
// "on paper" first (ui/views/paper.ts): light colors, styles inline, secrets
// hidden. Everything happens in the app: nothing is sent anywhere.

import { basename, dirname, join, samePath, stem } from "../core/path";
import { todayISO } from "../text/tasks";
import { toast } from "../ui/overlay";
import { paperDocument, renderPaper, type PaperOptions } from "../ui/views/paper";
import type { App, Doc } from "./app";
import { loadNoteImage } from "./images";

/** Images above this size (as a data URL) stay out of a copy: e-mail apps refuse them. */
const MAX_COPIED_IMAGE = 4 * 1024 * 1024;

function paperOptions(app: App, doc: Doc, opts: { diagrams: boolean; maxImage?: number }): PaperOptions {
  return {
    lang: doc.lang,
    taskCfg: app.taskCfg,
    today: todayISO(),
    image: async (ref) => {
      const url = await loadNoteImage(app, ref);
      return url && (!opts.maxImage || url.length <= opts.maxImage) ? url : null;
    },
    diagram: opts.diagrams
      ? async (code) => {
          const m = await import("../ui/views/mermaid");
          return m.svgDataUrl(m.fixSvgSize(await m.renderMermaid(code, false)));
        }
      : undefined,
  };
}

/** The note's name without its extension ("Meeting notes"). */
function noteTitle(app: App, doc: Doc): string {
  return stem(app.docName(doc)) || "Note";
}

/** Writes HTML (and its plain text) to the clipboard. */
export async function writeRichClipboard(html: string, plain: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([plain], { type: "text/plain" }) }),
      ]);
      return true;
    }
  } catch {
    /* refused: the copy event below */
  }
  let done = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData("text/html", html);
    e.clipboardData.setData("text/plain", plain);
    e.preventDefault();
    done = true;
  };
  document.addEventListener("copy", onCopy);
  try {
    document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy);
  }
  return done;
}

/** Edit: Copy as rich text — the selection (or the whole note), ready to paste into an e-mail or a chat. */
export async function copyRich(app: App) {
  const doc = app.active;
  if (!doc) return;
  const state = app.view.state;
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  const src = ranges.length ? ranges.map((r) => state.sliceDoc(r.from, r.to)).join("\n") : state.doc.toString();
  if (!src.trim()) {
    toast("Nothing to copy: this note is empty.");
    return;
  }
  const paper = await renderPaper(src, paperOptions(app, doc, { diagrams: false, maxImage: MAX_COPIED_IMAGE }));
  const { maskSecrets } = await import("../text/secrets");
  const ok = await writeRichClipboard(paper.outerHTML, maskSecrets(src));
  if (ok) toast(`${ranges.length ? "Selection" : "Note"} copied as rich text: paste it into an e-mail or a chat.`, { timeout: 2500 });
  else toast("Could not copy", { kind: "error" });
}

/** File: Export as HTML page… (next to the note, by default). */
export async function exportHtml(app: App) {
  const doc = app.active;
  if (!doc) return;
  const title = noteTitle(app, doc);
  const dir = doc.path ? dirname(doc.path) : app.workspace;
  const target = await app.backend.pickSavePath(dir ? join(dir, `${title}.html`) : `${title}.html`);
  if (!target) return;
  if (app.docs.some((d) => d.path && samePath(d.path, target))) {
    toast(`"${basename(target)}" is open in a tab: choose another name for the page.`, { kind: "error" });
    return;
  }
  const paper = await renderPaper(app.docText(doc), paperOptions(app, doc, { diagrams: true }));
  try {
    await app.backend.writeText(target, paperDocument(paper, title));
  } catch (e) {
    toast(`Could not export: ${e}`, { kind: "error" });
    return;
  }
  app.refreshWorkspaceFilesSoon();
  toast(`Exported to ${basename(target)}`, { action: { label: "Show in folder", run: () => void app.backend.reveal(target) } });
}

/** The note being printed (shown only by the printer). */
const PRINT_ID = "kn-print";

/** File: Print or save as PDF… (the system's print dialog: "Save as PDF" is one of its printers). */
export async function printNote(app: App) {
  const doc = app.active;
  if (!doc) return;
  document.getElementById(PRINT_ID)?.remove();
  const paper = await renderPaper(app.docText(doc), paperOptions(app, doc, { diagrams: true }));
  const holder = document.createElement("div");
  holder.id = PRINT_ID;
  holder.append(paper);
  document.body.append(holder);
  // Images ready before the page is laid out for printing.
  await Promise.all([...holder.querySelectorAll("img")].map((img) => (img.decode ? img.decode() : Promise.resolve()).catch(() => {})));
  // The PDF is named after the page's title.
  const before = document.title;
  document.title = noteTitle(app, doc);
  const done = () => {
    holder.remove();
    document.title = before;
  };
  window.addEventListener("afterprint", done, { once: true });
  try {
    await app.backend.print();
  } catch (e) {
    window.removeEventListener("afterprint", done);
    done();
    toast(`Could not print: ${e}`, { kind: "error" });
  }
}
