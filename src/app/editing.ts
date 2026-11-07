// Format document: JSON, XML, HTML, CSS, SQL and Markdown tables, on the
// whole text or the selection.

import { languageLabel } from "../editor/languages";
import { FormatError, formatKindFor, formatText, minifyJson } from "../text/format";
import { toast } from "../ui/overlay";
import type { App } from "./app";

/**
 * Formats the selection, or the whole document: JSON (comments kept), XML,
 * HTML, CSS, SQL, Markdown tables. One undo step; the cursor stays close.
 */
export function formatDocument(app: App, mode: "format" | "minify" = "format") {
  const doc = app.active;
  if (!doc) return;
  const st = app.view.state;
  const sel = st.selection.main;
  const whole = sel.empty;
  const from = whole ? 0 : sel.from;
  const to = whole ? st.doc.length : sel.to;
  const text = st.sliceDoc(from, to);
  if (!text.trim()) return;
  // A selection is recognized by its content first (some JSON in a note).
  const kind = mode === "minify" ? "json" : whole ? formatKindFor(doc.lang, text) : (formatKindFor("text", text) ?? formatKindFor(doc.lang, text));
  if (!kind) {
    app.toastInfo(`Nothing to format in ${languageLabel(doc.lang)}: KiloNote formats JSON, XML, HTML, CSS, SQL and Markdown tables (select some JSON or XML to format just that).`);
    return;
  }
  let out: string;
  try {
    const indent = app.settings.indent_with_tabs ? "\t" : " ".repeat(app.settings.tab_size);
    out = mode === "minify" ? minifyJson(text) : formatText(kind, text, indent);
  } catch (e) {
    if (!(e instanceof FormatError)) {
      toast(`Could not format: ${(e as Error).message}`, { kind: "error" });
      return;
    }
    const pos = from + Math.min(e.pos, text.length);
    const goto = () => {
      if (doc !== app.active) app.activate(doc);
      const line = app.view.state.doc.lineAt(Math.min(pos, app.view.state.doc.length));
      app.reveal(doc, line.number, [pos - line.from, pos - line.from]);
    };
    toast(e.message, { kind: "error", action: { label: "Go to the error", run: goto } });
    return;
  }
  if (!whole && !text.endsWith("\n")) out = out.replace(/\n$/, "");
  if (whole && mode === "minify" && text.endsWith("\n")) out += "\n";
  if (out === text) {
    app.toastInfo(mode === "minify" ? "Already minified." : "Already formatted.");
    return;
  }
  // Only the part that differs is replaced: the cursor and the scroll stay put.
  let a = 0;
  while (a < text.length && a < out.length && text[a] === out[a]) a++;
  let b = 0;
  while (b < text.length - a && b < out.length - a && text[text.length - 1 - b] === out[out.length - 1 - b]) b++;
  app.view.dispatch({
    changes: { from: from + a, to: to - b, insert: out.slice(a, out.length - b) },
    userEvent: "input.format",
    ...(whole ? {} : { selection: { anchor: from, head: from + out.length } }),
  });
  app.focusEditor();
}
