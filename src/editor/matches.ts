// Where else a text appears in the note: the occurrences of the selected text
// and the matches of the search panel are counted in the whole note (not only
// on screen) and highlighted; ruler.ts marks them along the scrollbar. The
// search panel shows its count next to the field ("3 of 12"); the status bar
// shows the selection's (app side).

import { getSearchQuery, openSearchPanel, SearchQuery, searchPanelOpen, setSearchQuery } from "@codemirror/search";
import { EditorSelection, type EditorState, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** Counting stops there ("5000+"). */
export const MAX_MATCHES = 5000;
/** Longest selection whose other occurrences are looked for. */
const MAX_SELECTED = 1000;
/** Larger notes (characters) are not counted as you type or select. */
const MAX_DOC = 5_000_000;

/** The matches of a text in the whole note, in order. */
export interface Matches {
  readonly from: readonly number[];
  readonly to: readonly number[];
  /** There are more than MAX_MATCHES (only these are listed). */
  readonly more: boolean;
}

/** "12", or "5000+" when counting stopped. */
export function countLabel(m: Matches): string {
  return `${m.from.length}${m.more ? "+" : ""}`;
}

/** Index of the first value at or after `pos` (the lists are sorted). */
function firstAtOrAfter(list: readonly number[], pos: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The match the main selection is on (its index), or -1. */
export function currentMatch(m: Matches, state: EditorState): number {
  const { from, to } = state.selection.main;
  const i = firstAtOrAfter(m.from, from);
  return m.from[i] === from && m.to[i] === to ? i : -1;
}

// --- The selected text --------------------------------------------------------

/**
 * The selected text whose occurrences are looked for, or null: the same text in
 * every selection, not only spaces. A line break at its end is left out (a whole
 * line selected from its number).
 */
export function selectedText(state: EditorState): string | null {
  const { ranges, main } = state.selection;
  if (main.empty || main.to - main.from > MAX_SELECTED) return null;
  const text = state.sliceDoc(main.from, main.to);
  if (ranges.length > 1 && ranges.some((r) => state.sliceDoc(r.from, r.to) !== text)) return null;
  const query = text.endsWith("\n") ? text.slice(0, -1) : text;
  return query.trim() ? query : null;
}

/** The note as a string (searching it is fast): only the last one, released when selecting stops. */
let lastString: { doc: Text; text: string } | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
function docString(doc: Text): string {
  if (lastString?.doc !== doc) lastString = { doc, text: doc.toString() };
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => (lastString = null), 5000);
  return lastString.text;
}

/** Above this size (characters), the whole note is counted once typing or selecting pauses. */
export const LARGE_DOC = 300_000;

const lastOccurrences = new WeakMap<Text, { text: string; matches: Matches }>();

/** Where the selected text appears in the whole note (the selection included), or null if nothing is selected. */
export function occurrences(state: EditorState): Matches | null {
  const text = selectedText(state);
  if (text == null || state.doc.length > MAX_DOC) return null;
  const known = lastOccurrences.get(state.doc);
  if (known?.text === text) return known.matches;
  const s = docString(state.doc);
  const from: number[] = [];
  const to: number[] = [];
  let more = false;
  for (let i = s.indexOf(text); i >= 0; i = s.indexOf(text, i + text.length)) {
    if (from.length === MAX_MATCHES) {
      more = true;
      break;
    }
    from.push(i);
    to.push(i + text.length);
  }
  const matches = { from, to, more };
  lastOccurrences.set(state.doc, { text, matches });
  return matches;
}

/** Selects the next (or previous) occurrence of the selected text, going around the note. */
export function goToOccurrence(view: EditorView, forward: boolean): boolean {
  const m = occurrences(view.state);
  if (!m || m.from.length < 2) return false;
  const n = m.from.length;
  const at = view.state.selection.main.from;
  const i = ((forward ? firstAtOrAfter(m.from, at + 1) : firstAtOrAfter(m.from, at) - 1) + n) % n;
  view.dispatch({
    selection: EditorSelection.single(m.from[i], m.to[i]),
    effects: EditorView.scrollIntoView(m.from[i], { y: "center" }),
    userEvent: "select.search",
  });
  return true;
}

// --- The search panel ---------------------------------------------------------

const lastSearch = new WeakMap<Text, { query: SearchQuery; matches: Matches }>();

/** The matches of the search panel's query in the whole note, or null (panel closed, nothing to find). */
export function searchMatches(state: EditorState): Matches | null {
  if (!searchPanelOpen(state)) return null;
  const query = getSearchQuery(state);
  if (!query.valid || state.doc.length > MAX_DOC) return null;
  const known = lastSearch.get(state.doc);
  if (known?.query.eq(query)) return known.matches;
  const from: number[] = [];
  const to: number[] = [];
  let more = false;
  const cursor = query.getCursor(state);
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    if (from.length === MAX_MATCHES) {
      more = true;
      break;
    }
    from.push(r.value.from);
    to.push(r.value.to);
  }
  const matches = { from, to, more };
  lastSearch.set(state.doc, { query, matches });
  return matches;
}

/** Opens the search panel (Ctrl+F); a whole line selected from its number is looked for without its line break. */
export function openFind(view: EditorView): boolean {
  const { main } = view.state.selection;
  const wholeLine = !main.empty && view.state.sliceDoc(main.to - 1, main.to) === "\n";
  const before = searchPanelOpen(view.state) ? getSearchQuery(view.state) : null;
  if (!openSearchPanel(view)) return false;
  const q = getSearchQuery(view.state);
  const lineBreak = q.literal ? "\n" : "\\n";
  // Only when the search was just taken from the selection (not typed in the field).
  if (wholeLine && q !== before && q.search.length > lineBreak.length && q.search.endsWith(lineBreak)) {
    const { caseSensitive, literal, regexp, wholeWord, replace } = q;
    const search = q.search.slice(0, -lineBreak.length);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search, caseSensitive, literal, regexp, wholeWord, replace })) });
  }
  return true;
}

/** What the search panel shows next to its field: "3 of 12", "12 matches", "no results"… */
export function searchCount(state: EditorState): string {
  const query = getSearchQuery(state);
  if (!query.search) return "";
  if (!query.valid) return "invalid";
  const m = searchMatches(state);
  if (!m) return "";
  if (!m.from.length) return "no results";
  const i = currentMatch(m, state);
  if (i >= 0) return `${i + 1} of ${countLabel(m)}`;
  return m.from.length === 1 ? "1 match" : `${countLabel(m)} matches`;
}

/** The search panel was opened or closed, or its query changed. */
export function searchChanged(u: ViewUpdate): boolean {
  return searchPanelOpen(u.state) !== searchPanelOpen(u.startState) || !getSearchQuery(u.state).eq(getSearchQuery(u.startState));
}

/** The count, written next to the field of the search panel (once the panel is drawn). */
const searchCounter = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {}

    private timer: ReturnType<typeof setTimeout> | undefined;

    update(u: ViewUpdate) {
      if (!searchPanelOpen(u.state) || !(u.docChanged || u.selectionSet || searchChanged(u))) return;
      clearTimeout(this.timer);
      // In a large note, typing in the text counts again once typing pauses.
      if (u.docChanged && u.state.doc.length > LARGE_DOC) this.timer = setTimeout(() => this.schedule(), 200);
      else this.schedule();
    }

    schedule() {
      this.view.requestMeasure({ key: this, read: () => null, write: () => this.draw() });
    }

    destroy() {
      clearTimeout(this.timer);
    }

    draw() {
      const field = this.view.dom.querySelector(".cm-search [main-field]");
      if (!field) return;
      let label = field.nextElementSibling;
      if (!label?.classList.contains("cm-search-count")) {
        label = document.createElement("span");
        label.className = "cm-search-count";
        label.setAttribute("aria-live", "polite");
        field.after(label);
      }
      const text = searchCount(this.view.state);
      label.textContent = text;
      label.classList.toggle("none", text === "no results" || text === "invalid");
    }
  },
);

// --- On screen ----------------------------------------------------------------

const occurrenceMark = Decoration.mark({ class: "cm-selectionMatch" });

/** The other occurrences of the selected text, highlighted where they are visible (only that part is read). */
function highlightOccurrences(view: EditorView): DecorationSet {
  const text = selectedText(view.state);
  if (text == null) return Decoration.none;
  const { ranges } = view.state.selection;
  const marks: Range<Decoration>[] = [];
  let last = -1;
  for (const visible of view.visibleRanges) {
    const from = Math.max(0, visible.from - text.length);
    const part = view.state.sliceDoc(from, Math.min(view.state.doc.length, visible.to + text.length));
    for (let i = part.indexOf(text); i >= 0; i = part.indexOf(text, i + text.length)) {
      const start = from + i;
      const end = start + text.length;
      if (start <= last) continue; // (already found in the previous visible range)
      last = start;
      if (!ranges.some((r) => r.from <= start && r.to >= end)) marks.push(occurrenceMark.range(start, end));
    }
  }
  return Decoration.set(marks, true);
}

const occurrenceHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = highlightOccurrences(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = highlightOccurrences(u.view);
    }
  },
  { decorations: (p) => p.decorations },
);

/**
 * Where else a text appears: the occurrences of the selection, highlighted, and
 * the count of the search panel's matches (ruler.ts marks both along the
 * scrollbar). Goes with the `search()` extension.
 */
export function matchesInNote(): Extension {
  return [occurrenceHighlighter, searchCounter];
}
