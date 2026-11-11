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
      else if (text.length > 4) {
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

/** The marks, in pixels from the top of the ruler (one per pixel row and kind). */
function measure(view: EditorView, outline: Landmark[]): { top: number; height: number; marks: Mark[] } {
  const scroller = view.scrollDOM;
  const height = scroller.clientHeight;
  const scale = height / Math.max(scroller.scrollHeight, 1);
  const pad = view.documentPadding.top;
  const y = (pos: number) => Math.min(height - 2, Math.round((pad + view.lineBlockAt(Math.min(pos, view.state.doc.length)).top) * scale));
  const marks: Mark[] = [];
  const seen = new Set<string>();
  const add = (pos: number, kind: string, color?: string) => {
    const m = { y: y(pos), kind, color };
    const key = `${m.y}|${kind}|${color ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    marks.push(m);
  };
  for (const l of outline) add(l.pos, l.kind, l.color);
  const found = searchMatches(view.state);
  const occ = found ? null : occurrences(view.state); // while searching, the search's marks
  const addAll = (m: Matches, kind: string) => m.from.forEach((pos) => add(pos, kind));
  if (found) {
    addAll(found, "found");
    const i = currentMatch(found, view.state);
    if (i >= 0) add(found.from[i], "found current");
  } else if (occ && occ.from.length > 1) addAll(occ, "occ");
  return { top: scroller.offsetTop, height, marks };
}

const ruler = ViewPlugin.fromClass(
  class {
    readonly dom = document.createElement("div");
    private outline: Landmark[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(readonly view: EditorView) {
      this.dom.className = "cm-ruler";
      this.dom.setAttribute("aria-hidden", "true");
      view.dom.append(this.dom);
      this.outline = this.readOutline();
      this.schedule();
    }

    update(u: ViewUpdate) {
      const { startState: before, state } = u;
      if (before.facet(taskConfigFacet) !== state.facet(taskConfigFacet) || before.facet(codeDocFacet) !== state.facet(codeDocFacet)) {
        this.outline = this.readOutline();
        this.schedule();
      }
      if (u.docChanged) {
        // The outline is read again once typing pauses (the marks of the matches right away).
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.outline = this.readOutline();
          this.schedule();
        }, 400);
      }
      if (u.docChanged || u.selectionSet || u.geometryChanged || u.heightChanged || searchChanged(u)) this.schedule();
    }

    readOutline(): Landmark[] {
      const { state } = this.view;
      return state.facet(codeDocFacet) ? [] : landmarks(state.doc, state.facet(taskConfigFacet));
    }

    schedule() {
      this.view.requestMeasure({ key: this, read: (view) => measure(view, this.outline), write: (m) => this.draw(m) });
    }

    draw({ top, height, marks }: ReturnType<typeof measure>) {
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
      clearTimeout(this.timer);
      this.dom.remove();
    }
  },
);

/** The marks along the scrollbar (the `scrollbar_marks` setting). */
export function scrollbarMarks(show: boolean): Extension {
  return show ? ruler : [];
}
