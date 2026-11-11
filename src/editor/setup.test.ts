import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { wholeLines } from "./setup";

describe("lines selected from their numbers", () => {
  const state = EditorState.create({ doc: "one\ntwo\nthree\nfour" });
  const text = (r: { from: number; to: number }) => state.sliceDoc(r.from, r.to);

  it("are their whole text, without the last line break", () => {
    expect(text(wholeLines(state, 4, 4))).toBe("two");
    expect(text(wholeLines(state, 4, 9))).toBe("two\nthree");
    expect(text(wholeLines(state, 14, 14))).toBe("four");
  });

  it("can be dragged upward", () => {
    const r = wholeLines(state, 8, 0);
    expect(text(r)).toBe("one\ntwo\nthree");
    expect([r.anchor, r.head]).toEqual([13, 0]);
  });
});
