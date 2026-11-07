// @vitest-environment happy-dom
// The tree view against a fake app: edits land at the right place, and never
// when the text changed since the tree was read.

import { Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import type { App, Doc } from "../app";
import { TreeView } from "./tree-view";

function setup(lines: string[]) {
  document.body.innerHTML = '<div id="overlay-root"></div>';
  const doc = { id: 1 } as Doc;
  const view = { state: { doc: Text.of(lines) }, dispatch: vi.fn() };
  const edits: { from: number; to: number; insert: string }[] = [];
  const app = {
    active: doc,
    view,
    applyToDoc: vi.fn((_d: Doc, spec: { changes: { from: number; to: number; insert: string } }) => {
      edits.push(spec.changes);
      const t = view.state.doc.toString();
      const c = spec.changes;
      view.state = { doc: Text.of((t.slice(0, c.from) + c.insert + t.slice(c.to)).split("\n")) };
    }),
    preview: { update: vi.fn() },
    focusEditor: vi.fn(),
    copyText: vi.fn(),
  };
  const tv = new TreeView(app as unknown as App);
  document.body.append(tv.el);
  const editValue = (key: string, value: string) => {
    const row = [...tv.el.querySelectorAll(".tv-row")].find((r) => r.textContent!.startsWith(key))!;
    row.querySelector(".tv-val")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = tv.el.querySelector<HTMLInputElement>(".tv-edit");
    if (!input) return null;
    input.value = value;
    return () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };
  return { tv, doc, view, app, edits, editValue };
}

describe("tree view", () => {
  it("writes an edit at the place of the value", async () => {
    const { tv, doc, view, edits, editValue } = setup(["{", '  "name": "kilo", // comment', '  "port": 8080', "}"]);
    await tv.render(doc, view.state.doc, "json");
    const at = view.state.doc.toString().indexOf("8080");
    editValue("port", "9090")!();
    expect(edits).toEqual([{ from: at, to: at + 4, insert: "9090" }]);
    expect(view.state.doc.toString()).toBe('{\n  "name": "kilo", // comment\n  "port": 9090\n}');
  });

  it("refuses to edit when the text changed since the tree was read", async () => {
    const { tv, doc, view, app, editValue } = setup(["{", '  "name": "kilo"', "}"]);
    await tv.render(doc, view.state.doc, "json");
    view.state = { doc: Text.of(["  {", '  "name": "kilo"', "}"]) };
    expect(editValue("name", "x")).toBeNull();
    expect(app.applyToDoc).not.toHaveBeenCalled();
  });

  it("drops an edit if the text changes while the value is being typed", async () => {
    const { tv, doc, view, app, editValue } = setup(["{", '  "name": "kilo"', "}"]);
    await tv.render(doc, view.state.doc, "json");
    const commit = editValue("name", "x")!;
    view.state = { doc: Text.of(["{", '  "name": "kilo", "more": 1', "}"]) };
    commit();
    expect(app.applyToDoc).not.toHaveBeenCalled();
    expect(document.querySelector(".kn-toast.error")?.textContent).toContain("not applied");
  });

  it("keeps the last valid tree, read-only, while the text has an error", async () => {
    const { tv, doc, view, app, editValue } = setup(["{", '  "name": "kilo"', "}"]);
    await tv.render(doc, view.state.doc, "json");
    view.state = { doc: Text.of(["{", '  "name": "kilo",', "}"]) };
    view.state.doc = Text.of(["{", '  "name": "kilo" "x"', "}"]);
    await tv.render(doc, view.state.doc, "json");
    expect(tv.el.querySelector(".tv-body")!.classList.contains("stale")).toBe(true);
    expect(tv.el.querySelector(".tv-status")!.textContent).toContain("Expected");
    expect(editValue("name", "y")).toBeNull();
    expect(app.applyToDoc).not.toHaveBeenCalled();
  });
});
