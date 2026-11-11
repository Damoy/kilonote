// @vitest-environment happy-dom
import { openSearchPanel, search, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { countLabel, goToOccurrence, MAX_MATCHES, matchesInNote, occurrences, searchCount, searchMatches, selectedText } from "./matches";

const NOTE = "-- Stockviz\nssh host\n-- Stockviz\nnotes about Stockviz\n-- Stockviz\n";
const select = (doc: string, from: number, to: number) => EditorState.create({ doc, selection: EditorSelection.single(from, to) });
const frame = () => new Promise((r) => setTimeout(r, 40));

let views: EditorView[] = [];
afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
});
function open(doc: string, from = 0, to = from) {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: [search({ top: true }), matchesInNote()] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

describe("the other occurrences of the selected text", () => {
  it("are counted in the whole note, the selection included", () => {
    const m = occurrences(select(NOTE, 0, 11))!;
    expect(m.from).toEqual([0, 21, 54]);
    expect(countLabel(m)).toBe("3");
    expect(occurrences(select(NOTE, 12, 15))!.from).toEqual([12]); // "ssh": only here
    expect(occurrences(select(NOTE, 3, 11))!.from).toHaveLength(4); // "Stockviz", case and all
  });

  it("are looked for only for a real selection", () => {
    expect(occurrences(select(NOTE, 4, 4))).toBeNull();
    expect(selectedText(select("a   b", 1, 4))).toBeNull(); // only spaces
    // A whole line selected from its number: its line break is left out.
    expect(selectedText(select(NOTE, 0, 12))).toBe("-- Stockviz");
    expect(occurrences(select(NOTE, 0, 12))!.from).toHaveLength(3);
    // Several selections of the same text (Ctrl+D…), but not of different texts.
    const same = EditorState.create({ doc: NOTE, selection: EditorSelection.create([EditorSelection.range(0, 11), EditorSelection.range(21, 32)]), extensions: EditorState.allowMultipleSelections.of(true) });
    expect(selectedText(same)).toBe("-- Stockviz");
    const different = EditorState.create({ doc: NOTE, selection: EditorSelection.create([EditorSelection.range(0, 11), EditorSelection.range(12, 15)]), extensions: EditorState.allowMultipleSelections.of(true) });
    expect(selectedText(different)).toBeNull();
  });

  it("stop being counted past a limit", () => {
    const m = occurrences(select("ab".repeat(MAX_MATCHES + 10), 0, 2))!;
    expect(m.from).toHaveLength(MAX_MATCHES);
    expect(countLabel(m)).toBe(`${MAX_MATCHES}+`);
  });

  it("can be visited one after the other, around the note", () => {
    const view = open(NOTE, 21, 32);
    const at = () => view.state.selection.main.from;
    expect(goToOccurrence(view, true)).toBe(true);
    expect(at()).toBe(54);
    goToOccurrence(view, true);
    expect(at()).toBe(0);
    goToOccurrence(view, false);
    expect(at()).toBe(54);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("-- Stockviz");
    view.dispatch({ selection: { anchor: 12, head: 15 } });
    expect(goToOccurrence(view, true)).toBe(false); // nowhere else
  });

  it("are highlighted and marked along the scrollbar", async () => {
    const view = open(NOTE, 0, 11);
    await frame();
    expect([...view.dom.querySelectorAll(".cm-selectionMatch")].map((e) => e.textContent)).toEqual(["-- Stockviz", "-- Stockviz"]);
    expect(view.dom.querySelectorAll(".cm-match-ruler i.occ").length).toBeGreaterThan(0);
    view.dispatch({ selection: { anchor: 12, head: 15 } });
    await frame();
    expect(view.dom.querySelectorAll(".cm-selectionMatch, .cm-match-ruler i")).toHaveLength(0);
  });
});

describe("the search panel's count", () => {
  const find = (view: EditorView, spec: ConstructorParameters<typeof SearchQuery>[0]) =>
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery(spec)) });

  it("counts the matches in the whole note", async () => {
    const view = open(NOTE);
    expect(searchMatches(view.state)).toBeNull(); // panel closed
    openSearchPanel(view);
    find(view, { search: "stockviz" });
    expect(searchCount(view.state)).toBe("4 matches");
    find(view, { search: "stockviz", caseSensitive: true });
    expect(searchCount(view.state)).toBe("no results");
    find(view, { search: "^-- \\w+$", regexp: true });
    expect(searchCount(view.state)).toBe("3 matches");
    find(view, { search: "(", regexp: true });
    expect(searchCount(view.state)).toBe("invalid");
    find(view, { search: "" });
    expect(searchCount(view.state)).toBe("");
    find(view, { search: "ssh" });
    expect(searchCount(view.state)).toBe("1 match");
  });

  it("says which match is selected, next to the field", async () => {
    const view = open(NOTE);
    openSearchPanel(view);
    find(view, { search: "-- Stockviz" });
    view.dispatch({ selection: { anchor: 21, head: 32 } });
    expect(searchCount(view.state)).toBe("2 of 3");
    await frame();
    const label = view.dom.querySelector(".cm-search [main-field] + .cm-search-count");
    expect(label?.textContent).toBe("2 of 3");
    expect(view.dom.querySelectorAll(".cm-match-ruler i.found.current")).toHaveLength(1);
    // Edited meanwhile: counted again.
    view.dispatch({ changes: { from: view.state.doc.length, insert: "-- Stockviz\n" } });
    await frame();
    expect(label?.textContent).toBe("2 of 4");
    find(view, { search: "nowhere" });
    await frame();
    expect(label?.textContent).toBe("no results");
    expect(label?.classList.contains("none")).toBe(true);
  });
});
