// CodeMirror 6 editor setup: a single view, one state per tab
// (each tab keeps its own undo history).

import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  type BlockInfo, crosshairCursor, Decoration, type DecorationSet, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection, scrollPastEnd, type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { defineLanguageFacet, HighlightStyle, indentUnit, Language, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { GFM, parser as markdownParser } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";
import type { Settings } from "../core/settings";
import { codeDocFacet, notesClickHandler, notesHighlighter, plainNotesFacet, taskConfigFacet } from "./decorations";
import { noteImages } from "./images";
import { isCodeLang, languageForPath, languageInfo } from "./languages";
import { matchesInNote } from "./matches";
import type { TaskConfig } from "../text/tasks";

/** A document type id of LANGUAGES ("text", "markdown", "jsonc", "python"…). */
export type LangId = string;

export const settingsCompartment = new Compartment();
export const languageCompartment = new Compartment();

export function langForPath(path: string | null, fallback: LangId = "text"): LangId {
  return path ? languageForPath(path) : fallback;
}

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

// Markdown without embedded languages (HTML/CSS/JS): much lighter.
const markdownLanguage = new Language(
  defineLanguageFacet({ commentTokens: { block: { open: "<!--", close: "-->" } } }),
  markdownParser.configure(GFM),
  [],
  "markdown",
);

/** Code languages already loaded (their module is fetched on first use). */
const loaded = new Map<string, Extension>();
const loading = new Map<string, Promise<boolean>>();

function languageExtension(lang: LangId): Extension {
  if (lang === "markdown") return markdownLanguage;
  if (lang === "jsonc") return jsonc;
  return loaded.get(lang) ?? [];
}

/** True once the coloring of `lang` is available (no loading needed). */
export function languageReady(lang: LangId): boolean {
  return !languageInfo(lang).load || loaded.has(lang);
}

/** Loads the coloring of a code language; resolves to false if it failed. */
export function loadLanguage(lang: LangId): Promise<boolean> {
  const info = languageInfo(lang);
  if (!info.load || loaded.has(lang)) return Promise.resolve(true);
  let p = loading.get(lang);
  if (!p) {
    p = info.load().then(
      (parser) => {
        loaded.set(lang, StreamLanguage.define(parser));
        return true;
      },
      (e) => {
        console.error(`Language ${lang}:`, e);
        loading.delete(lang);
        return false;
      },
    );
    loading.set(lang, p);
  }
  return p;
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
  { tag: [t.bool, t.null, t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: "var(--kn-purple)" },
  { tag: t.punctuation, color: "var(--kn-fg-muted)" },
  // Code languages
  { tag: [t.typeName, t.className, t.namespace], color: "var(--kn-yellow)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName), t.definition(t.propertyName)], color: "var(--kn-blue)" },
  { tag: [t.standard(t.variableName), t.special(t.variableName), t.self], color: "var(--kn-cyan)" },
  { tag: [t.atom, t.unit, t.color, t.constant(t.variableName)], color: "var(--kn-orange)" },
  { tag: [t.regexp, t.special(t.string), t.escape], color: "var(--kn-cyan)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--kn-red)" },
  { tag: t.attributeName, color: "var(--kn-orange)" },
  { tag: t.attributeValue, color: "var(--kn-green)" },
  { tag: [t.meta, t.annotation, t.macroName, t.processingInstruction], color: "var(--kn-pink)" },
  { tag: t.operator, color: "var(--kn-cyan)" },
  { tag: t.inserted, color: "var(--kn-green)" },
  { tag: t.deleted, color: "var(--kn-red)" },
  { tag: t.changed, color: "var(--kn-orange)" },
  { tag: t.invalid, color: "var(--kn-red)", textDecoration: "underline wavy" },
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
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--kn-accent) 20%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--kn-accent) 45%, transparent)",
    borderRadius: "2px",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--kn-yellow) 28%, transparent)", outline: "1px solid color-mix(in srgb, var(--kn-yellow) 55%, transparent)", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--kn-orange) 45%, transparent)" },
  ".cm-specialChar": { color: "var(--kn-red)" },
  ".cm-tooltip": { backgroundColor: "var(--kn-bg-alt)", border: "1px solid var(--kn-border)", color: "var(--kn-fg)" },
});

/** The text of the node hovered in the tree view (null: none). */
export const setTreeHighlight = StateEffect.define<{ from: number; to: number } | null>();
const treeMark = Decoration.mark({ class: "kn-tree-hl" });
const treeHighlight = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setTreeHighlight)) continue;
      const r = e.value;
      deco = r && r.to > r.from && r.to <= tr.state.doc.length ? Decoration.set([treeMark.range(r.from, r.to)]) : Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Enter on a bullet line continues the list (and removes an empty bullet). */
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

/** Whole lines from the line of `anchor` to the line of `head`, line breaks included. */
function wholeLines(state: EditorState, anchor: number, head: number) {
  const doc = state.doc;
  const a = doc.lineAt(anchor);
  const b = doc.lineAt(head);
  return b.number >= a.number
    ? EditorSelection.range(a.from, Math.min(b.to + 1, doc.length))
    : EditorSelection.range(Math.min(a.to + 1, doc.length), b.from);
}

/**
 * A click on a line number selects the whole line (ready to copy, cut, delete
 * or duplicate); dragging selects more lines, Shift+click extends the selection.
 */
function selectLinesFromGutter(view: EditorView, line: BlockInfo, event: Event): boolean {
  const e = event as MouseEvent;
  if (e.button !== 0) return false;
  e.preventDefault();
  const anchor = e.shiftKey ? view.state.selection.main.anchor : line.from;
  const select = (pos: number) => view.dispatch({ selection: wholeLines(view.state, anchor, pos), userEvent: "select.pointer" });
  select(line.from);
  view.focus();
  const move = (ev: MouseEvent) => {
    const box = view.contentDOM.getBoundingClientRect();
    select(view.posAtCoords({ x: box.left + 1, y: ev.clientY }, false));
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
  return true;
}

/**
 * Ctrl+Up/Down: the cursor moves one line and the text scrolls with it, so the
 * line stays at the same height on the screen (Shift extends the selection).
 */
function moveWithView(forward: boolean, extend: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const ranges = state.selection.ranges.map((r) => {
      const moved = view.moveVertically(r, forward);
      return extend ? EditorSelection.range(r.anchor, moved.head, moved.goalColumn) : moved;
    });
    const selection = EditorSelection.create(ranges, state.selection.mainIndex);
    const box = view.scrollDOM.getBoundingClientRect();
    const before = view.coordsAtPos(state.selection.main.head, 1);
    const onScreen = !!before && before.bottom > box.top && before.top < box.bottom;
    view.dispatch({ selection, userEvent: "select", scrollIntoView: !onScreen });
    const after = onScreen ? view.coordsAtPos(selection.main.head, 1) : null;
    if (before && after) view.scrollDOM.scrollTop += after.top - before.top;
    return true;
  };
}

const moveWithViewKeys = [
  { win: "Ctrl-ArrowUp", linux: "Ctrl-ArrowUp", run: moveWithView(false, false), shift: moveWithView(false, true), preventDefault: true },
  { win: "Ctrl-ArrowDown", linux: "Ctrl-ArrowDown", run: moveWithView(true, false), shift: moveWithView(true, true), preventDefault: true },
];

export function settingsExtensions(s: Settings, taskCfg: TaskConfig, lang: LangId): Extension {
  return [
    s.line_numbers ? [lineNumbers({ domEventHandlers: { mousedown: selectLinesFromGutter } }), highlightActiveLineGutter()] : [],
    s.highlight_active_line ? highlightActiveLine() : [],
    s.word_wrap ? EditorView.lineWrapping : [],
    EditorState.tabSize.of(s.tab_size),
    indentUnit.of(s.indent_with_tabs ? "\t" : " ".repeat(s.tab_size)),
    taskConfigFacet.of(taskCfg),
    plainNotesFacet.of(lang === "text"),
    codeDocFacet.of(isCodeLang(lang)),
    lang === "text" || lang === "markdown" ? noteImages(s.show_images) : [],
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
      search({ top: true }),
      matchesInNote(),
      scrollPastEnd(),
      keymap.of([{ key: "Enter", run: continueList }, ...moveWithViewKeys, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
      languageCompartment.of(languageExtension(lang)),
      settingsCompartment.of(settingsExtensions(s, taskCfg, lang)),
      notesHighlighter,
      notesClickHandler,
      treeHighlight,
      syntaxHighlighting(highlight),
      theme,
      EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
      EditorView.updateListener.of(onUpdate),
    ],
  });
}

export function reconfigureLanguage(lang: LangId) {
  return languageCompartment.reconfigure(languageExtension(lang));
}
