import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { imagesField, noteImages } from "./images";

/** The lines (1-based) that show images, and the images of each. */
function shown(state: EditorState): [number, string[]][] {
  const out: [number, string[]][] = [];
  state.field(imagesField).between(0, state.doc.length, (from, _to, deco) => {
    if (!deco.spec.widget) return expect(deco.spec.class).toBe("cm-note-image-line");
    out.push([state.doc.lineAt(from).number, (deco.spec.widget as unknown as { refs: string[] }).refs]);
  });
  return out;
}

describe("images under their line", () => {
  const start = (doc: string) => EditorState.create({ doc, extensions: noteImages(true) });

  it("shows each line's images under it", () => {
    const s = start("# Notes\n![image](images/a.png)\ntext ![x](b.jpg) and ![y](<c d.png>)\nplain");
    expect(shown(s)).toEqual([[2, ["images/a.png"]], [3, ["b.jpg", "c d.png"]]]);
  });

  it("follows the edits, line by line", () => {
    let s = start("a\n![image](a.png)\nb\nc");
    // Typing above: the image moves with its line.
    s = s.update({ changes: { from: 0, insert: "new line\n" } }).state;
    expect(shown(s)).toEqual([[3, ["a.png"]]]);
    // A reference written on another line.
    s = s.update({ changes: { from: s.doc.line(5).to, insert: " ![z](z.png)" } }).state;
    expect(shown(s)).toEqual([[3, ["a.png"]], [5, ["z.png"]]]);
    // The reference changed, then removed.
    const l3 = s.doc.line(3);
    s = s.update({ changes: { from: l3.from, to: l3.to, insert: "![image](b.png)" } }).state;
    expect(shown(s)).toEqual([[3, ["b.png"]], [5, ["z.png"]]]);
    s = s.update({ changes: { from: s.doc.line(3).from, to: s.doc.line(4).from } }).state;
    expect(shown(s)).toEqual([[4, ["z.png"]]]);
    // Two lines joined: one block for both.
    s = start("![a](a.png)\n![b](b.png)");
    s = s.update({ changes: { from: s.doc.line(1).to, to: s.doc.line(2).from, insert: " " } }).state;
    expect(shown(s)).toEqual([[1, ["a.png", "b.png"]]]);
  });

  it("can be turned off (pasting still works)", () => {
    const s = EditorState.create({ doc: "![image](a.png)", extensions: noteImages(false) });
    expect(s.field(imagesField, false)).toBeUndefined();
  });
});
