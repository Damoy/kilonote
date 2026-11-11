// Marks over the scrollbar, where things are in the whole note: the headings and
// the open tasks of a note (left lane), the other occurrences of the selected
// text and the search matches (right lane). Like the scrollbar thumb, a mark at
// the top of the ruler is at the top of the note.

import type { Extension, Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { resolveColor } from "../core/themes";
import { isDoneStatus, parseTask, type TaskConfig } from "../text/tasks";
import { codeDocFacet, taskConfigFacet } from "./decorations";
import { currentMatch, type Matches, occurrences, searchChanged, searchMatches } from "./matches";

/** A heading or an open task, by its position in the note. */
export interface Landmark {
  pos: number;
  kind: "heading" | "task";
  /** The status color of a task. */
  color?: string;
}

/** Notes with more lines are not outlined along the scrollbar. */
const MAX_LINES = 200_000;
const HEADING = /^#{1,6}\s+\S/;
const FENCE = /^\s*(```|~~~)/;
/** A task has " - status" at its end: lines without a dash and a space are skipped quickly. */
const TASK_HINT = /[-–—]\s/;

/** The headings (`# Title`) and the tasks not done yet, outside code blocks. */
export function landmarks(doc: Text, cfg: TaskConfig): Landmark[] {
  const out: Landmark[] = [];
  if (doc.lines > MAX_LINES) return out;
  let pos = 0;
  let code = false;
  for (const iter = doc.iterLines(); !iter.next().done; ) {
    const text = iter.value;
    if (FENCE.test(text)) code = !code;
    else if (!code && text) {
      if (text[0] === "#" && HEADING.test(text)) out.push({ pos, kind: "heading" });
      else if (text.length > 4 && TASK_HINT.test(text)) {
        const task = parseTask(text, cfg);
        if (task && !isDoneStatus(task.key, cfg)) out.push({ pos, kind: "task", color: resolveColor(cfg.statuses[task.key]) });
      }
    }
    pos += text.length + 1;
  }
  return out;
}

interface Mark {
  y: number;
  kind: string;
  color?: string;
}

interface Geometry {
  top: number;
  height: number;
  scale: number;
  pad: number;
}

/** Where a position of the note is on the ruler (px from its top): where the scrollbar thumb would be to show it. */
function rulerY(view: EditorView, g: Geometry, pos: number): number {
  return Math.min(g.height - 2, Math.round((g.pad + view.lineBlockAt(Math.min(pos, view.state.doc.length)).top) * g.scale));
}

/** Marks for positions (one per pixel row, kind and color). */
function marksAt(view: EditorView, g: Geometry, items: { pos: number; kind: string; color?: string }[]): Mark[] {
  const marks: Mark[] = [];
  const seen = new Set<string>();
  for (const { pos, kind, color } of items) {
    const y = rulerY(view, g, pos);
    const key = `${y}|${kind}|${color ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    marks.push({ y, kind, color });
  }
  return marks;
}

/** The marks of the matches: the search's while searching, otherwise the other occurrences of the selection. */
function matchItems(view: EditorView): { pos: number; kind: string }[] {
  const found = searchMatches(view.state);
  if (found) {
    const i = currentMatch(found, view.state);
    const items = found.from.map((pos) => ({ pos, kind: "found" }));
    return i >= 0 ? [...items, { pos: found.from[i], kind: "found current" }] : items;
  }
  const occ: Matches | null = occurrences(view.state);
  return occ && occ.from.length > 1 ? occ.from.map((pos) => ({ pos, kind: "occ" })) : [];
}

/** How long typing must pause before the marks move with the text (they barely do while typing). */
const SETTLE_MS = 250;

const ruler = ViewPlugin.fromClass(
  class {
    readonly dom = document.createElement("div");
    private outline: Landmark[] = [];
    /** The outline's marks, kept while the outline and the geometry stay the same. */
    private outlineMarks: { geometry: string; marks: Mark[] } | null = null;
    private drawn = "";
    private outlineTimer: ReturnType<typeof setTimeout> | undefined;
    private settleTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(readonly view: EditorView) {
      this.dom.className = "cm-ruler";
      this.dom.setAttribute("aria-hidden", "true");
      view.dom.append(this.dom);
      // Read once the note is on screen: opening a note never waits for its outline.
      this.outlineTimer = setTimeout(() => this.readOutline());
    }

    update(u: ViewUpdate) {
      const { startState: before, state } = u;
      if (before.facet(taskConfigFacet) !== state.facet(taskConfigFacet) || before.facet(codeDocFacet) !== state.facet(codeDocFacet)) {
        this.readOutline();
      }
      if (u.docChanged) {
        clearTimeout(this.outlineTimer);
        this.outlineTimer = setTimeout(() => this.readOutline(), 400);
      }
      if (u.docChanged || u.heightChanged || u.geometryChanged) {
        // Typing, a resize, heights measured while scrolling: once things settle.
        this.outlineMarks = null;
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => this.schedule(), SETTLE_MS);
      } else if (u.selectionSet || searchChanged(u)) this.schedule();
    }

    readOutline() {
      const { state } = this.view;
      this.outline = state.facet(codeDocFacet) ? [] : landmarks(state.doc, state.facet(taskConfigFacet));
      this.outlineMarks = null;
      this.schedule();
    }

    schedule() {
      this.view.requestMeasure({ key: this, read: (view) => this.measure(view), write: (m) => this.draw(m) });
    }

    measure(view: EditorView) {
      const scroller = view.scrollDOM;
      const g: Geometry = {
        top: scroller.offsetTop,
        height: scroller.clientHeight,
        scale: scroller.clientHeight / Math.max(scroller.scrollHeight, 1),
        pad: view.documentPadding.top,
      };
      const geometry = `${g.height}|${g.scale}|${g.pad}`;
      if (this.outlineMarks?.geometry !== geometry) this.outlineMarks = { geometry, marks: marksAt(view, g, this.outline) };
      return { top: g.top, height: g.height, marks: [...this.outlineMarks.marks, ...marksAt(view, g, matchItems(view))] };
    }

    draw({ top, height, marks }: { top: number; height: number; marks: Mark[] }) {
      const key = `${top}|${height}|${marks.map((m) => `${m.y}${m.kind}${m.color ?? ""}`).join(",")}`;
      if (key === this.drawn) return;
      this.drawn = key;
      this.dom.style.top = `${top}px`;
      this.dom.style.height = `${height}px`;
      this.dom.replaceChildren(
        ...marks.map((m) => {
          const i = document.createElement("i");
          i.className = m.kind;
          i.style.top = `${m.y}px`;
          if (m.color) i.style.background = m.color;
          return i;
        }),
      );
    }

    destroy() {
      clearTimeout(this.outlineTimer);
      clearTimeout(this.settleTimer);
      this.dom.remove();
    }
  },
);

/** The marks along the scrollbar (the `scrollbar_marks` setting). */
export function scrollbarMarks(show: boolean): Extension {
  return show ? ruler : [];
}
