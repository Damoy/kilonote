import { replaceAll, search, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { SECRET_BEGIN, SECRET_END } from "../text/secrets";
import { noteSecrets, secretsField } from "./secrets";

const NOTE = `A first line\n${SECRET_BEGIN}\nAAAABBBB\nCCCCAAAA\n${SECRET_END}\nA last line`;
const start = () => EditorState.create({ doc: NOTE, extensions: [noteSecrets, search()] });
const block = (s: EditorState) => s.field(secretsField).blocks[0];

describe("secret blocks in the editor", () => {
  it("are found, and follow the edits around them", () => {
    let s = start();
    expect(s.sliceDoc(block(s).from, block(s).to)).toBe(`${SECRET_BEGIN}\nAAAABBBB\nCCCCAAAA\n${SECRET_END}`);
    s = s.update({ changes: { from: 0, insert: "new\n" } }).state;
    expect(s.sliceDoc(block(s).from, block(s).from + SECRET_BEGIN.length)).toBe(SECRET_BEGIN);
    // A block pasted in later is found too.
    s = s.update({ changes: { from: s.doc.length, insert: `\n${SECRET_BEGIN}\nZZ\n${SECRET_END}` } }).state;
    expect(s.field(secretsField).blocks).toHaveLength(2);
  });

  it("are never changed in part, only replaced or deleted as a whole", () => {
    const s = start();
    const b = block(s);
    // Typing inside, or an edit across one edge: refused.
    expect(s.update({ changes: { from: b.from + 40, insert: "x" } }).state.doc.toString()).toBe(NOTE);
    expect(s.update({ changes: { from: 5, to: b.from + 3 } }).state.doc.toString()).toBe(NOTE);
    // Next to it, or the whole block: fine.
    expect(s.update({ changes: { from: b.to, insert: "!" } }).state.doc.toString()).toBe(NOTE.replace(SECRET_END, SECRET_END + "!"));
    expect(s.update({ changes: { from: b.from, to: b.to, insert: "gone" } }).state.doc.toString()).toBe("A first line\ngone\nA last line");
  });

  it("are skipped by Replace all", () => {
    let s = start();
    s = s.update({ effects: setSearchQuery.of(new SearchQuery({ search: "A", replace: "B", caseSensitive: true })) }).state;
    const view = { state: s, dispatch: (tr: unknown) => (s = (s.update as (t: unknown) => { state: EditorState })(tr).state) };
    // (replaceAll only needs the state and dispatch of a view)
    replaceAll(view as never);
    expect(s.doc.toString()).toBe(`B first line\n${SECRET_BEGIN}\nAAAABBBB\nCCCCAAAA\n${SECRET_END}\nB last line`);
  });
});
