// The panes of a window, side by side or one above the other: each has its own
// tabs and its own editor (the layout itself is in app/layout.ts). Dragging a
// tab, or a file of the explorer, over a pane shows where it would go: near an
// edge, a new pane on that side; in the middle, that pane.

import type { EditorView } from "@codemirror/view";
import type { App, Doc } from "../app/app";
import { MAX_PANES, zoneAt, type Layout, type Split, type Zone } from "../app/layout";
import { shortcutFor } from "../core/commands";
import { basename } from "../core/path";
import { h, icon } from "./dom";
import type { TabBar } from "./tabbar";

export class Pane {
  readonly el: HTMLElement;
  readonly tabbarEl = h("div", { class: "kn-tabbar", role: "tablist" });
  readonly body: HTMLElement;
  /** Shown in a pane without tabs (a split waiting for a note). */
  readonly hint: HTMLElement;
  tabbar!: TabBar;
  /** The tab shown in the pane. */
  active: Doc | null = null;

  constructor(readonly id: number, readonly view: EditorView, onClose: () => void) {
    this.hint = h(
      "div",
      { class: "kn-pane-hint", tabindex: "-1" },
      icon("splitRight", "kn-pane-hint-icon"),
      h("p", {}, "Drop a tab or a file here, or open a note:"),
      h("p", { class: "kn-pane-hint-keys" }, ...[["Go to file", "palette.files"], ["Open", "file.open"], ["New note", "file.new"]].map(([label, id]) => h("span", {}, label, " ", h("kbd", {}, shortcutFor(id))))),
      h("button", { class: "kn-btn", onclick: onClose }, "Close this pane"),
    );
    this.body = h("div", { class: "kn-pane-body" }, view.dom, this.hint);
    this.el = h("div", { class: "kn-pane empty", "data-pane": String(id) }, this.tabbarEl, this.body);
  }
}

// --- Layout ---------------------------------------------------------------------

/** Lays the panes out in `root` as the layout says (the panes' elements are moved, never rebuilt). */
export function renderLayout(app: App, root: HTMLElement) {
  const byId = new Map(app.panes.map((p) => [p.id, p]));
  const build = (node: Layout): HTMLElement => {
    if ("pane" in node) return byId.get(node.pane)!.el;
    const el = h("div", { class: `kn-split ${node.dir}` });
    node.children.forEach((child, i) => {
      if (i) el.append(resizer(app, node, i));
      const c = build(child);
      c.style.flex = `${node.sizes[i]} 1 0`;
      el.append(c);
    });
    return el;
  };
  const hadFocus = app.pane.el.contains(document.activeElement);
  const tree = build(app.layout);
  tree.style.flex = "1 1 0";
  root.replaceChildren(tree);
  root.classList.toggle("split", app.panes.length > 1);
  const first = app.panes.find((p) => p.el === root.querySelector(".kn-pane"));
  for (const p of app.panes) {
    p.el.classList.toggle("focused", p === app.pane);
    // The top left pane holds the button that shows the sidebar again.
    p.tabbarEl.classList.toggle("lead", p === first);
    p.view.requestMeasure();
  }
  if (hadFocus) app.focusEditor();
}

/** The separator between two children of a split: drag it to share the room, double-click for equal parts. */
function resizer(app: App, node: Split, i: number): HTMLElement {
  const across = node.dir === "row";
  const r = h("div", {
    class: "kn-split-resizer",
    role: "separator",
    "aria-orientation": across ? "vertical" : "horizontal",
    title: "Drag to resize · double-click: same size",
  });
  const apply = () => {
    (r.previousElementSibling as HTMLElement).style.flex = `${node.sizes[i - 1]} 1 0`;
    (r.nextElementSibling as HTMLElement).style.flex = `${node.sizes[i]} 1 0`;
  };
  r.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    r.setPointerCapture(e.pointerId);
    const a = (r.previousElementSibling as HTMLElement).getBoundingClientRect();
    const b = (r.nextElementSibling as HTMLElement).getBoundingClientRect();
    const start = across ? a.left : a.top;
    const total = across ? a.width + b.width : a.height + b.height;
    const sum = node.sizes[i - 1] + node.sizes[i];
    const min = Math.min(140, total / 3);
    document.body.classList.add("resizing", across ? "cols" : "rows");
    const move = (ev: PointerEvent) => {
      const at = Math.max(min, Math.min(total - min, (across ? ev.clientX : ev.clientY) - start));
      node.sizes[i - 1] = (sum * at) / total;
      node.sizes[i] = sum - node.sizes[i - 1];
      apply();
    };
    const up = () => {
      r.removeEventListener("pointermove", move);
      r.removeEventListener("pointerup", up);
      r.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing", "cols", "rows");
      app.saveSessionSoon();
    };
    r.addEventListener("pointermove", move);
    r.addEventListener("pointerup", up);
    r.addEventListener("pointercancel", up);
  });
  r.addEventListener("dblclick", () => {
    const half = (node.sizes[i - 1] + node.sizes[i]) / 2;
    node.sizes[i - 1] = half;
    node.sizes[i] = half;
    apply();
    app.saveSessionSoon();
  });
  return r;
}

// --- Drag and drop ----------------------------------------------------------------

/** Where a dragged tab or file would land: a pane's tabs (before a tab), or a zone of a pane. */
export type DropTarget = { kind: "tabs"; pane: Pane; before: Doc | null } | { kind: "zone"; pane: Pane; zone: Zone };

const inside = (r: DOMRect, x: number, y: number) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;

/** What is under the pointer, for a dragged tab (`doc`) or a dragged file (null). */
export function dropTargetAt(app: App, x: number, y: number, doc: Doc | null): DropTarget | null {
  for (const pane of app.panes) {
    if (inside(pane.tabbarEl.getBoundingClientRect(), x, y)) return { kind: "tabs", pane, before: pane.tabbar.docAt(x) };
    const rect = pane.body.getBoundingClientRect();
    if (!inside(rect, x, y)) continue;
    const count = app.docsOf(pane).length;
    // A pane without tabs takes what is dropped; no more than MAX_PANES panes.
    let zone = count && app.panes.length < MAX_PANES ? zoneAt(rect, x, y) : "center";
    if (doc && doc.pane === pane.id) {
      // Its own pane: only a split makes sense, and only if a tab stays behind.
      if (zone === "center" || count < 2) return null;
    }
    return { kind: "zone", pane, zone };
  }
  return null;
}

const ZONE_LABELS: Record<Zone, string> = {
  left: "Split left",
  right: "Split right",
  top: "Split up",
  bottom: "Split down",
  center: "Open here",
};

/** The highlighted zone and the name that follows the pointer while dragging. */
export class DropIndicator {
  private zone = h("div", { class: "kn-drop-zone" }, h("span", { class: "kn-drop-label" }));
  private ghost = h("div", { class: "kn-drag-ghost" });
  private marked: TabBar | null = null;

  constructor(name: string) {
    this.ghost.append(icon("file"), h("span", {}, name));
    document.body.append(this.zone, this.ghost);
    this.zone.hidden = true;
    this.ghost.hidden = true;
  }

  /** Shows `target` (null: nothing), the ghost at the pointer unless `ghost` is false. */
  update(target: DropTarget | null, x: number, y: number, ghost = true, moving = false) {
    this.ghost.hidden = !ghost;
    if (ghost) this.ghost.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
    const bar = target?.kind === "tabs" ? target.pane.tabbar : null;
    if (this.marked && this.marked !== bar) this.marked.hideMarker();
    this.marked = bar;
    if (target?.kind === "tabs") {
      target.pane.tabbar.showMarker(target.before);
      this.zone.hidden = true;
      return;
    }
    if (!target) {
      this.zone.hidden = true;
      return;
    }
    const r = target.pane.body.getBoundingClientRect();
    let { left, top, width, height } = r;
    if (target.zone === "left" || target.zone === "right") {
      width /= 2;
      if (target.zone === "right") left += width;
    } else if (target.zone === "top" || target.zone === "bottom") {
      height /= 2;
      if (target.zone === "bottom") top += height;
    }
    Object.assign(this.zone.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    this.zone.dataset.zone = target.zone;
    const label = target.zone === "center" && moving ? "Move here" : ZONE_LABELS[target.zone];
    const text = this.zone.firstElementChild!;
    if (text.textContent !== label) text.replaceChildren(icon(target.zone === "center" ? "file" : target.zone === "left" || target.zone === "right" ? "splitRight" : "splitDown"), h("span", {}, label));
    this.zone.hidden = false;
  }

  remove() {
    this.marked?.hideMarker();
    this.zone.remove();
    this.ghost.remove();
  }
}

/** Drops a tab or a file on a target: moved or opened there, in a new pane for a zone near an edge. */
export async function dropOn(app: App, target: DropTarget, what: { doc: Doc } | { path: string }) {
  if (target.kind === "tabs") {
    if ("doc" in what) app.placeDoc(what.doc, target.pane, target.before);
    else await app.openInPane(what.path, target.pane);
    return;
  }
  const dest = target.zone === "center" ? target.pane : app.splitPane(target.pane, target.zone);
  if (!dest) return;
  if ("doc" in what) app.moveDocToPane(what.doc, dest);
  else await app.openInPane(what.path, dest);
  // Nothing could be opened there (an image, a refused file): no empty pane left behind.
  if (dest !== target.pane && !app.docsOf(dest).length) app.closePane(dest);
}

/** A file of the explorer dragged with the mouse: dropped on a pane, it opens there (or in a new pane). */
export function startFileDrag(app: App, e: PointerEvent, path: string) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let indicator: DropIndicator | null = null;
  let target: DropTarget | null = null;
  const move = (ev: PointerEvent) => {
    if (!indicator) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      indicator = new DropIndicator(basename(path));
      document.body.classList.add("kn-dragging");
      getSelection()?.removeAllRanges();
    }
    target = dropTargetAt(app, ev.clientX, ev.clientY, null);
    indicator.update(target, ev.clientX, ev.clientY);
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (!indicator) return;
    indicator.remove();
    document.body.classList.remove("kn-dragging");
    // (The click that follows the drop must not open the file a second time.)
    const swallow = (c: MouseEvent) => {
      c.stopPropagation();
      c.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (ev.type === "pointerup" && target) void dropOn(app, target, { path });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
