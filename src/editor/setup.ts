// Construction de l'éditeur CodeMirror 6 : une seule vue, un état par onglet
// (historique d'annulation conservé par onglet).

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection, scrollPastEnd, type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { defineLanguageFacet, HighlightStyle, indentUnit, Language, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { GFM, parser as markdownParser } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";
import type { Settings } from "../core/settings";
import { extname } from "../core/path";
import { notesClickHandler, notesHighlighter, plainNotesFacet, taskConfigFacet } from "./decorations";
import type { TaskConfig } from "./tasks";

export type LangId = "text" | "markdown" | "jsonc";

export const settingsCompartment = new Compartment();
export const languageCompartment = new Compartment();

export function langForPath(path: string | null, fallback: LangId = "text"): LangId {
  if (!path) return fallback;
  const ext = extname(path);
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "json" || ext === "jsonc" || ext === "sublime-settings") return "jsonc";
  return "text";
}

export const LANG_LABELS: Record<LangId, string> = { text: "Texte", markdown: "Markdown", jsonc: "JSON" };

const jsonc = StreamLanguage.define<{ inComment: boolean }>({
  name: "jsonc",
  startState: () => ({ inComment: false }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.inComment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.inComment = true;
      return "comment";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return /^\s*:/.test(stream.string.slice(stream.pos)) ? "propertyName" : "string";
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^(?:true|false)\b/)) return "bool";
    if (stream.match(/^null\b/)) return "null";
    stream.next();
    return "punctuation";
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
});

// Markdown sans les langages embarqués (HTML/CSS/JS) : bien plus léger.
const markdownLanguage = new Language(
  defineLanguageFacet({ commentTokens: { block: { open: "<!--", close: "-->" } } }),
  markdownParser.configure(GFM),
  [],
  "markdown",
);

function languageExtension(lang: LangId): Extension {
  if (lang === "markdown") return markdownLanguage;
  if (lang === "jsonc") return jsonc;
  return [];
}

const highlight = HighlightStyle.define([
  { tag: t.heading1, color: "var(--kn-accent)", fontWeight: "700" },
  { tag: [t.heading2, t.heading3], color: "var(--kn-blue)", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], color: "var(--kn-cyan)", fontWeight: "600" },
  { tag: t.strong, fontWeight: "700", color: "var(--kn-fg)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--kn-fg-muted)" },
  { tag: [t.link, t.url], color: "var(--kn-cyan)" },
  { tag: t.monospace, color: "var(--kn-orange)" },
  { tag: t.quote, color: "var(--kn-fg-muted)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName], color: "var(--kn-fg-faint)" },
  { tag: t.comment, color: "var(--kn-fg-faint)", fontStyle: "italic" },
  { tag: t.propertyName, color: "var(--kn-blue)" },
  { tag: t.string, color: "var(--kn-green)" },
  { tag: t.number, color: "var(--kn-orange)" },
  { tag: [t.bool, t.null, t.keyword], color: "var(--kn-purple)" },
  { tag: t.punctuation, color: "var(--kn-fg-muted)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--kn-fg)", backgroundColor: "var(--kn-bg)", fontSize: "var(--kn-font-size)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--kn-font)", lineHeight: "var(--kn-line-height)", overflowX: "auto" },
  ".cm-content": { caretColor: "var(--kn-cursor)", padding: "14px 0" },
  ".cm-line": { padding: "0 28px 0 6px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--kn-cursor)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--kn-selection) !important" },
  ".cm-activeLine": { backgroundColor: "var(--kn-line)" },
  ".cm-gutters": { backgroundColor: "var(--kn-bg)", color: "var(--kn-fg-faint)", border: "none", paddingLeft: "10px" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 6px", minWidth: "32px", fontSize: "0.86em" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--kn-fg-muted)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--kn-accent) 16%, transparent)", borderRadius: "2px" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--kn-yellow) 28%, transparent)", outline: "1px solid color-mix(in srgb, var(--kn-yellow) 55%, transparent)", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--kn-orange) 45%, transparent)" },
  ".cm-specialChar": { color: "var(--kn-red)" },
  ".cm-tooltip": { backgroundColor: "var(--kn-bg-alt)", border: "1px solid var(--kn-border)", color: "var(--kn-fg)" },
});

const frenchPhrases = EditorState.phrases.of({
  Find: "Rechercher",
  Replace: "Remplacer",
  next: "suivant",
  previous: "précédent",
  all: "tout",
  "match case": "casse",
  regexp: "regex",
  "by word": "mot entier",
  replace: "remplacer",
  "replace all": "tout remplacer",
  close: "fermer",
  "current match": "occurrence courante",
  "on line": "à la ligne",
  "replaced $ matches": "$ occurrences remplacées",
  "replaced match on line $": "occurrence remplacée à la ligne $",
  "Go to line": "Aller à la ligne",
  go: "OK",
  "Control character": "Caractère de contrôle",
  "Selection deleted": "Sélection supprimée",
});

/** Entrée sur une ligne à puce : la puce continue (et disparaît sur une puce vide). */
function continueList(view: EditorView): boolean {
  const { state } = view;
  if (state.selection.ranges.length > 1) return false;
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
  const m = /^(\s*)([-*+•]|\d{1,3}[.)])(\s+)/.exec(line.text);
  if (!m || range.head < line.from + m[0].length) return false;
  if (!line.text.slice(m[0].length).trim()) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "" }, userEvent: "delete" });
    return true;
  }
  let bullet = m[2];
  const num = /^(\d+)([.)])$/.exec(bullet);
  if (num) bullet = `${Number(num[1]) + 1}${num[2]}`;
  const insert = "\n" + m[1] + bullet + m[3];
  view.dispatch({
    changes: { from: range.head, insert },
    selection: { anchor: range.head + insert.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

export function settingsExtensions(s: Settings, taskCfg: TaskConfig, lang: LangId): Extension {
  return [
    s.line_numbers ? [lineNumbers(), highlightActiveLineGutter()] : [],
    s.highlight_active_line ? highlightActiveLine() : [],
    s.word_wrap ? EditorView.lineWrapping : [],
    EditorState.tabSize.of(s.tab_size),
    indentUnit.of(s.indent_with_tabs ? "\t" : " ".repeat(s.tab_size)),
    taskConfigFacet.of(taskCfg),
    plainNotesFacet.of(lang === "text"),
  ];
}

export function createEditorState(
  doc: string,
  lang: LangId,
  s: Settings,
  taskCfg: TaskConfig,
  onUpdate: (u: ViewUpdate) => void,
): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      EditorState.allowMultipleSelections.of(true),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      search({ top: true }),
      scrollPastEnd(),
      keymap.of([{ key: "Enter", run: continueList }, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
      languageCompartment.of(languageExtension(lang)),
      settingsCompartment.of(settingsExtensions(s, taskCfg, lang)),
      notesHighlighter,
      notesClickHandler,
      syntaxHighlighting(highlight),
      theme,
      frenchPhrases,
      EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
      EditorView.updateListener.of(onUpdate),
    ],
  });
}

export function reconfigureLanguage(lang: LangId) {
  return languageCompartment.reconfigure(languageExtension(lang));
}
