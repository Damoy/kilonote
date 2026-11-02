// Coloration des notes : statuts de tâches en pastilles, titres, puces,
// liens, dates, #tags et @mentions. Ne traite que les lignes visibles.

import { Facet, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { resolveColor } from "../core/themes";
import { isDoneStatus, makeTaskConfig, parseTask, type TaskConfig } from "./tasks";

export const taskConfigFacet = Facet.define<TaskConfig, TaskConfig>({
  combine: (values) =>
    values[values.length - 1] ??
    makeTaskConfig({ statuses: {}, cycle: [], done: [], archiveStatus: "done", archiveDate: false }),
});

/** true pour les fichiers texte simples (les .md ont déjà leur propre coloration). */
export const plainNotesFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[values.length - 1] ?? true,
});

/** Branchements fournis par l'application (menu de statut, ouverture de liens). */
export const editorHooks = {
  onStatusClick: (_view: EditorView, _line: number, _x: number, _y: number) => {},
  openUrl: (_url: string) => {},
};

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const TAG_RE = /(^|[\s(])(#[\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;
const MENTION_RE = /(^|[\s(])(@[\p{L}\p{N}_][\p{L}\p{N}_.\-]*[\p{L}\p{N}_]|@[\p{L}\p{N}_])/gu;
const HEADING_RE = /^(#{1,6})\s+\S/;
const BULLET_RE = /^(\s*)([-*+•]|\d{1,3}[.)])\s/;
const HR_RE = /^\s*(?:-{3,}|={3,}|\*{3,}|_{3,})\s*$/;
const CODE_RE = /`[^`\n]+`/g;
const STRONG_RE = /\*\*[^*\n]+\*\*/g;

const mark = (cls: string, attrs?: Record<string, string>) => Decoration.mark({ class: cls, attributes: attrs });
const M = {
  url: mark("kn-url", { title: "Ctrl+clic pour ouvrir" }),
  date: mark("kn-date"),
  tag: mark("kn-tag"),
  mention: mark("kn-mention"),
  bullet: mark("kn-bullet"),
  hmark: mark("kn-h-mark"),
  stamp: mark("kn-stamp"),
  doneText: mark("kn-done-text"),
  code: mark("kn-code"),
  strong: mark("kn-strong"),
};
const lineDeco = new Map<string, Decoration>();
const L = (cls: string) => {
  let d = lineDeco.get(cls);
  if (!d) lineDeco.set(cls, (d = Decoration.line({ class: cls })));
  return d;
};
const taskLineDeco = new Map<string, Decoration>();
function taskLine(key: string, color: string, done: boolean): Decoration {
  const id = `${key}|${color}|${done}`;
  let d = taskLineDeco.get(id);
  if (!d) {
    d = Decoration.line({
      class: `kn-task kn-task-${key.replace(/[^\p{L}\p{N}_-]/gu, "_")}${done ? " kn-task-done" : ""}`,
      attributes: { style: `--c:${resolveColor(color)}` },
    });
    taskLineDeco.set(id, d);
  }
  return d;
}
const statusDeco = new Map<string, Decoration>();
function statusMark(key: string, color: string): Decoration {
  const id = key + "|" + color;
  let d = statusDeco.get(id);
  if (!d) {
    d = Decoration.mark({
      class: "kn-status",
      attributes: { style: `--c:${resolveColor(color)}`, title: "Clic : changer le statut" },
    });
    statusDeco.set(id, d);
  }
  return d;
}

function eachMatch(re: RegExp, text: string, fn: (m: RegExpExecArray) => void) {
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    fn(m);
    if (m[0].length === 0) re.lastIndex++;
  }
}

function decorateLine(from: number, text: string, cfg: TaskConfig, plain: boolean, out: Range<Decoration>[]) {
  if (!text) return;
  const task = text.length > 4 ? parseTask(text, cfg) : null;
  if (task) {
    const done = isDoneStatus(task.key, cfg);
    out.push(taskLine(task.key, cfg.statuses[task.key], done).range(from));
    if (done && task.textTo > task.textFrom) out.push(M.doneText.range(from + task.textFrom, from + task.textTo));
    out.push(statusMark(task.key, cfg.statuses[task.key]).range(from + task.statusFrom, from + task.statusTo));
    if (task.stampTo > task.stampFrom) out.push(M.stamp.range(from + task.stampFrom, from + task.stampTo));
  }
  if (plain) {
    const h = HEADING_RE.exec(text);
    if (h) {
      out.push(L(`kn-h kn-h${h[1].length}`).range(from));
      out.push(M.hmark.range(from, from + h[1].length));
    } else if (HR_RE.test(text)) {
      out.push(L("kn-hr").range(from));
    } else {
      const b = BULLET_RE.exec(text);
      if (b) out.push(M.bullet.range(from + b[1].length, from + b[1].length + b[2].length));
      if (/^\s*>/.test(text)) out.push(L("kn-quote").range(from));
    }
    if (text.includes("`")) eachMatch(CODE_RE, text, (m) => out.push(M.code.range(from + m.index, from + m.index + m[0].length)));
    if (text.includes("**")) eachMatch(STRONG_RE, text, (m) => out.push(M.strong.range(from + m.index, from + m.index + m[0].length)));
  }
  if (text.includes("://")) eachMatch(URL_RE, text, (m) => out.push(M.url.range(from + m.index, from + m.index + m[0].length)));
  if (/\d/.test(text)) eachMatch(DATE_RE, text, (m) => out.push(M.date.range(from + m.index, from + m.index + m[0].length)));
  if (text.includes("#")) {
    eachMatch(TAG_RE, text, (m) => {
      const start = from + m.index + m[1].length;
      out.push(M.tag.range(start, start + m[2].length));
    });
  }
  if (text.includes("@")) {
    eachMatch(MENTION_RE, text, (m) => {
      const start = from + m.index + m[1].length;
      out.push(M.mention.range(start, start + m[2].length));
    });
  }
}

function build(view: EditorView): DecorationSet {
  const cfg = view.state.facet(taskConfigFacet);
  const plain = view.state.facet(plainNotesFacet);
  const out: Range<Decoration>[] = [];
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      decorateLine(line.from, line.text, cfg, plain, out);
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

export const notesHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.startState.facet(taskConfigFacet) !== u.state.facet(taskConfigFacet) ||
        u.startState.facet(plainNotesFacet) !== u.state.facet(plainNotesFacet)
      ) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Clic sur une pastille de statut → menu ; Ctrl/Cmd+clic sur un lien → navigateur. */
export const notesClickHandler = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0) return false;
    const target = e.target as HTMLElement;
    const status = target.closest?.(".kn-status");
    if (status && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const pos = view.posAtDOM(status);
      const line = view.state.doc.lineAt(pos).number;
      const r = status.getBoundingClientRect();
      e.preventDefault();
      editorHooks.onStatusClick(view, line, r.left, r.bottom + 4);
      return true;
    }
    const url = target.closest?.(".kn-url");
    if (url && (e.ctrlKey || e.metaKey)) {
      // Le lien peut être découpé en plusieurs fragments : on le relit depuis la ligne.
      const pos = view.posAtDOM(url);
      const line = view.state.doc.lineAt(pos);
      let found: string | null = null;
      eachMatch(URL_RE, line.text, (m) => {
        if (line.from + m.index <= pos && pos <= line.from + m.index + m[0].length) found = m[0];
      });
      if (found) {
        e.preventDefault();
        editorHooks.openUrl(found);
        return true;
      }
    }
    return false;
  },
});
