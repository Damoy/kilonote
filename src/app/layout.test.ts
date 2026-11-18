import { describe, expect, it } from "vitest";
import { mapLayout, neighborPane, panesInOrder, removeFromLayout, sanitizeLayout, splitLayout, zoneAt, type Layout } from "./layout";

describe("layout of the panes", () => {
  it("a split puts the new pane on the side asked, sharing the room", () => {
    const right = splitLayout({ pane: 1 }, 1, "right", 2);
    expect(right).toEqual({ dir: "row", children: [{ pane: 1 }, { pane: 2 }], sizes: [1, 1] });
    const left = splitLayout({ pane: 1 }, 1, "left", 2);
    expect(panesInOrder(left)).toEqual([2, 1]);
    const below = splitLayout(right, 2, "bottom", 3);
    expect(below).toEqual({ dir: "row", children: [{ pane: 1 }, { dir: "column", children: [{ pane: 2 }, { pane: 3 }], sizes: [1, 1] }], sizes: [1, 1] });
  });

  it("a split in the same direction joins the row: the pane gives half of its room", () => {
    const row = splitLayout({ pane: 1 }, 1, "right", 2);
    const three = splitLayout(row, 1, "right", 3);
    expect(three).toEqual({ dir: "row", children: [{ pane: 1 }, { pane: 3 }, { pane: 2 }], sizes: [0.5, 0.5, 1] });
  });

  it("removing a pane gives its room back; a split left with one child is replaced by it", () => {
    const row = splitLayout(splitLayout({ pane: 1 }, 1, "right", 2), 2, "bottom", 3);
    expect(removeFromLayout(row, 3)).toEqual({ dir: "row", children: [{ pane: 1 }, { pane: 2 }], sizes: [1, 1] });
    expect(removeFromLayout(removeFromLayout(row, 3)!, 1)).toEqual({ pane: 2 });
    expect(removeFromLayout({ pane: 1 }, 1)).toBeNull();
  });

  it("a split of the same direction inside its parent melts into it", () => {
    // row[1, column[row[2, 3], 4]]: once 4 is gone, 2 and 3 sit in the outer row.
    const nested: Layout = {
      dir: "row",
      children: [{ pane: 1 }, { dir: "column", children: [{ dir: "row", children: [{ pane: 2 }, { pane: 3 }], sizes: [1, 3] }, { pane: 4 }], sizes: [1, 1] }],
      sizes: [1, 1],
    };
    expect(removeFromLayout(nested, 4)).toEqual({ dir: "row", children: [{ pane: 1 }, { pane: 2 }, { pane: 3 }], sizes: [1, 0.25, 0.75] });
  });

  it("the pane beside another, on each side", () => {
    // 1 | (2 above 3)
    const l = splitLayout(splitLayout({ pane: 1 }, 1, "right", 2), 2, "bottom", 3);
    expect(neighborPane(l, 1, "right")).toBe(2);
    expect(neighborPane(l, 3, "left")).toBe(1);
    expect(neighborPane(l, 2, "bottom")).toBe(3);
    expect(neighborPane(l, 3, "top")).toBe(2);
    expect(neighborPane(l, 2, "right")).toBeNull();
    expect(neighborPane(l, 1, "top")).toBeNull();
  });

  it("near an edge, a split on that side; in the middle, the pane itself", () => {
    const r = { left: 100, top: 50, width: 400, height: 300 };
    expect(zoneAt(r, 480, 200)).toBe("right");
    expect(zoneAt(r, 110, 200)).toBe("left");
    expect(zoneAt(r, 300, 60)).toBe("top");
    expect(zoneAt(r, 300, 340)).toBe("bottom");
    expect(zoneAt(r, 300, 200)).toBe("center");
    // A corner: the closest edge wins.
    expect(zoneAt(r, 495, 60)).toBe("right");
  });

  it("a layout read from a session is checked: every pane once, nothing else", () => {
    const good = { dir: "row", children: [{ pane: 0 }, { pane: 1 }], sizes: [2, 1] };
    expect(sanitizeLayout(good, 2)).toEqual(good);
    expect(sanitizeLayout({ dir: "row", children: [{ pane: 0 }, { pane: 0 }] }, 2)).toBeNull();
    expect(sanitizeLayout({ dir: "row", children: [{ pane: 0 }, { pane: 5 }] }, 2)).toBeNull();
    expect(sanitizeLayout({ dir: "diagonal", children: [{ pane: 0 }, { pane: 1 }] }, 2)).toBeNull();
    expect(sanitizeLayout("row", 2)).toBeNull();
    // Missing or wrong sizes: equal parts.
    expect(sanitizeLayout({ dir: "column", children: [{ pane: 1 }, { pane: 0 }], sizes: [-1, "x"] }, 2)).toEqual({ dir: "column", children: [{ pane: 1 }, { pane: 0 }], sizes: [1, 1] });
    expect(mapLayout(good as Layout, (i) => i + 10)).toEqual({ dir: "row", children: [{ pane: 10 }, { pane: 11 }], sizes: [2, 1] });
  });
});
