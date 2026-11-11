// @vitest-environment happy-dom
import { openSearchPanel, search, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSearchQuery } from "@codemirror/search";
import { scrollbarMarks } from "./ruler";
import { countLabel, goToOccurrence, MAX_MATCHES, matchesInNote, occurrences, openFind, searchCount, searchMatches, selectedText } from "./matches";

const NOTE = "-- Bluebird\nssh host\n-- Bluebird\nnotes about Bluebird\n-- Bluebird\n";
const select = (doc: string, from: number, to: number) => EditorState.create({ doc, selection: EditorSelection.single(from, to) });

let views: EditorView[] = [];
afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
});
function open(doc: string, from = 0, to = from) {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: [search({ top: true }), matchesInNote(), scrollbarMarks(true)] }),
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
    expect(occurrences(select(NOTE, 3, 11))!.from).toHaveLength(4); // "Bluebird", case and all
  });

  it("are looked for only for a real selection", () => {
    expect(occurrences(select(NOTE, 4, 4))).toBeNull();
    expect(selectedText(select("a   b", 1, 4))).toBeNull(); // only spaces
    // A whole line selected from its number: its line break is left out.
    expect(selectedText(select(NOTE, 0, 12))).toBe("-- Bluebird");
    expect(occurrences(select(NOTE, 0, 12))!.from).toHaveLength(3);
    // Several selections of the same text (Ctrl+D…), but not of different texts.
    const same = EditorState.create({ doc: NOTE, selection: EditorSelection.create([EditorSelection.range(0, 11), EditorSelection.range(21, 32)]), extensions: EditorState.allowMultipleSelections.of(true) });
    expect(selectedText(same)).toBe("-- Bluebird");
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
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("-- Bluebird");
    view.dispatch({ selection: { anchor: 12, head: 15 } });
    expect(goToOccurrence(view, true)).toBe(false); // nowhere else
  });

  it("are highlighted and marked along the scrollbar", async () => {
    const view = open(NOTE, 0, 11);
    expect([...view.dom.querySelectorAll(".cm-selectionMatch")].map((e) => e.textContent)).toEqual(["-- Bluebird", "-- Bluebird"]);
    await vi.waitFor(() => expect(view.dom.querySelectorAll(".cm-ruler i.occ").length).toBeGreaterThan(0));
    view.dispatch({ selection: { anchor: 12, head: 15 } });
    expect(view.dom.querySelectorAll(".cm-selectionMatch")).toHaveLength(0);
    await vi.waitFor(() => expect(view.dom.querySelectorAll(".cm-ruler i")).toHaveLength(0));
  });
});

describe("the search panel's count", () => {
  const find = (view: EditorView, spec: ConstructorParameters<typeof SearchQuery>[0]) =>
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery(spec)) });

  it("counts the matches in the whole note", async () => {
    const view = open(NOTE);
    expect(searchMatches(view.state)).toBeNull(); // panel closed
    openSearchPanel(view);
    find(view, { search: "bluebird" });
    expect(searchCount(view.state)).toBe("4 matches");
    find(view, { search: "bluebird", caseSensitive: true });
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

  it("looks for a whole line selected from its number without its line break", () => {
    const view = open(NOTE, 21, 33);
    openFind(view);
    expect(getSearchQuery(view.state).search).toBe("-- Bluebird");
    expect(searchCount(view.state)).toBe("3 matches");
    view.dispatch({ selection: { anchor: 12, head: 15 } });
    openFind(view);
    expect(getSearchQuery(view.state).search).toBe("ssh");
  });

  it("says which match is selected, next to the field", async () => {
    const view = open(NOTE);
    openSearchPanel(view);
    find(view, { search: "-- Bluebird" });
    view.dispatch({ selection: { anchor: 21, head: 32 } });
    expect(searchCount(view.state)).toBe("2 of 3");
    await vi.waitFor(() => expect(view.dom.querySelector(".cm-search [main-field] + .cm-search-count")?.textContent).toBe("2 of 3"));
    const label = view.dom.querySelector(".cm-search [main-field] + .cm-search-count");
    await vi.waitFor(() => expect(view.dom.querySelectorAll(".cm-ruler i.found.current")).toHaveLength(1));
    // Edited meanwhile: counted again.
    view.dispatch({ changes: { from: view.state.doc.length, insert: "-- Bluebird\n" } });
    await vi.waitFor(() => expect(label?.textContent).toBe("2 of 4"));
    find(view, { search: "nowhere" });
    await vi.waitFor(() => expect(label?.textContent).toBe("no results"));
    expect(label?.classList.contains("none")).toBe(true);
  });
});
