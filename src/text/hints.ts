// Kilo's hints: what the note being written suggests, read from the note itself
// (the line of the cursor, the selection, the tasks). Pure rules, run on the
// computer only: nothing is sent anywhere. The assistant (ui/assistant.ts)
// shows the first hint that was not dismissed, once the typing pauses.

import { DUE_RE, findDateInLine, findTasks, isDoneStatus, parseTask, type TaskConfig } from "./tasks";

/**
 * What a hint offers to do: run a command (on the hint's line: with the line
 * selected, or the cursor on it), or set the line's due date.
 */
export type HintAction =
  | { label: string; command: string; selectLine?: boolean; onLine?: boolean }
  | { label: string; due: string };

export interface Hint {
  /** Stable id: a hint dismissed for good is never shown again. */
  id: string;
  text: string;
  action?: HintAction;
}

export interface HintContext {
  lang: string;
  /** The note's file (null: not saved yet). */
  path: string | null;
  /** The note is a _done archive. */
  archive: boolean;
  /** The note's text (not read above a certain size). */
  text: string | null;
  /** The line of the cursor, and its number (1-based). */
  line: string;
  lineNumber: number;
  /** The selected text, and how many times it appears in the note (null: nothing selected). */
  selection: string | null;
  occurrences: number | null;
  /** The names of the other notes of the folder (without extension). */
  notes: string[];
  tabs: number;
  previewOpen: boolean;
  cfg: TaskConfig;
  today: string;
  /** Shortcut of a command, as the user sees it ("Ctrl+Enter"). */
  key: (command: string) => string;
}

/** Words that announce a secret on a line: a password, a key, a token… (several languages). */
const SECRET_LINE = /\b(pass(word|wd)?|pwd|mdp|mot de passe|contrase[ñn]a|passwort|token|secret|api[_ -]?key|private[_ -]?key|client[_ -]?secret)\b\s*[:=]\s*\S{3,}/i;
const BEARER = /\b([Bb]earer\s+[A-Za-z0-9._~+/-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/;
const SSH_WITH_PASSWORD = /\bssh\s+\S+@\S+.*\b(-p\s*\S+\s+)?(pass|pwd|mdp)\b/i;

/** A bullet line with text and no status yet. */
const BULLET = /^\s*([-*+•]|\d{1,3}[.)])\s+\S.{2,}$/;
const HEADING = /^#{1,6}\s+\S/;
const DATE_IN_TEXT = /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b/;

/** Notes larger than this are not scanned as a whole (only the cursor's line). */
const MAX_SCAN = 400_000;

/** The hints for this moment, the most useful first. */
export function contextHints(ctx: HintContext): Hint[] {
  const out: Hint[] = [];
  const isNote = ctx.lang === "text" || ctx.lang === "markdown";
  const line = ctx.line;
  const task = line.length > 4 ? parseTask(line, ctx.cfg) : null;

  // A private line in clear, in a note: offer to encrypt it (in code, it would break the code).
  if (isNote && !line.includes("KILONOTE SECRET") && (SECRET_LINE.test(line) || BEARER.test(line) || SSH_WITH_PASSWORD.test(line))) {
    out.push({
      id: "secret-line",
      text: "This line looks private (a password, a key…). Encrypt it: only your password will show it again, and it stays encrypted on the disk.",
      action: { label: "Encrypt this line", command: "edit.encrypt", selectLine: true },
    });
  }

  if (isNote && !ctx.archive) {
    // A list item that could be a task.
    if (!task && BULLET.test(line) && !/\[\[|https?:\/\//.test(line)) {
      out.push({
        id: "make-task",
        text: `This line could be a task: ${ctx.key("task.cycle")} adds " - todo", then ongoing, then done.`,
        action: { label: "Make it a task", command: "task.cycle", onLine: true },
      });
    }
    // A date written in a task: it can be its due date.
    if (task && !task.due && !DUE_RE.test(task.text) && DATE_IN_TEXT.test(task.text)) {
      const date = findDateInLine(task.text);
      if (date && isRealDate(date)) {
        out.push({
          id: "date-as-due",
          text: `There is a date in this task: as a due date (@${date}), it turns orange when it is near and red when it is late.`,
          action: { label: `Due on ${date}`, due: date },
        });
      }
    }
    // The name of another note: a link opens it.
    const linked = linkableName(line, ctx.notes);
    if (linked) {
      out.push({
        id: "link-note",
        text: `"${linked}" is a note of this folder: write [[${linked}]] and Ctrl+click opens it.`,
      });
    }
  }

  // Something selected that appears elsewhere.
  if (ctx.selection && ctx.occurrences != null && ctx.occurrences > 1) {
    out.push({
      id: "occurrences",
      text: `This text appears ${ctx.occurrences} times in the note: ${ctx.key("edit.nextOccurrence")} goes from one to the next.`,
      action: { label: "Next one", command: "edit.nextOccurrence" },
    });
  }

  const text = ctx.text != null && ctx.text.length <= MAX_SCAN ? ctx.text : null;
  if (text != null && isNote && !ctx.archive) {
    const tasks = findTasks(text, ctx.cfg);
    const done = tasks.filter((t) => isDoneStatus(t.task.key, ctx.cfg)).length;
    const late = tasks.filter((t) => t.task.due && t.task.due < ctx.today && !isDoneStatus(t.task.key, ctx.cfg)).length;
    if (late > 0) {
      out.push({
        id: "overdue",
        text: `${late} task${late > 1 ? "s are" : " is"} past ${late > 1 ? "their" : "its"} due date (in red). ${ctx.key("task.due")} on a task changes it.`,
      });
    }
    if (done >= 5 && ctx.path) {
      out.push({
        id: "archive-done",
        text: `${done} tasks are done here. Archive them: they go to the _done file with today's date, and this note stays light.`,
        action: { label: "Archive the done tasks", command: "task.archiveDone" },
      });
    }
    const lines = text.split("\n");
    if (lines.length > 80 && !lines.some((l) => HEADING.test(l))) {
      out.push({
        id: "add-headings",
        text: `A long note without headings: lines starting with "# " give it an outline. ${ctx.key("palette.symbol")} jumps to them, and they are marked along the scrollbar.`,
      });
    }
  }

  if (ctx.lang === "markdown" && !ctx.previewOpen && text != null && text.length > 300) {
    out.push({ id: "md-preview", text: `${ctx.key("view.preview")} shows this Markdown note rendered, beside the text.`, action: { label: "Show the preview", command: "view.preview" } });
  }
  if ((ctx.lang === "json" || ctx.lang === "jsonc") && line.length > 200) {
    out.push({ id: "format-json", text: `A long JSON line: ${ctx.key("edit.format")} formats the document (comments kept).`, action: { label: "Format", command: "edit.format" } });
  }
  if (!ctx.path && text != null && text.split("\n").length > 15) {
    out.push({ id: "save-draft", text: `This note is not saved to a file yet: ${ctx.key("file.save")} gives it a place among your notes.`, action: { label: "Save it", command: "file.save" } });
  }
  if (ctx.tabs > 12) {
    out.push({ id: "many-tabs", text: `${ctx.tabs} tabs open: ${ctx.key("palette.files")} finds a note by its name, and a right-click on a tab groups tabs together.` });
  }
  return out;
}

/** `2026-11-14` is a day of the calendar (not `2026-14-11`, a date written month first). */
function isRealDate(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** A note name that is not an everyday word ("notes_dev", "Project-2026", "Bluebird"…). */
function distinctive(name: string): boolean {
  return name.length >= 6 || /[\d_\-.]/.test(name) || /[a-z][A-Z]/.test(name);
}

/** The name of another note written on the line as a word (and not already a link). */
function linkableName(line: string, notes: string[]): string | null {
  if (!notes.length || line.length > 400) return null;
  const plain = line.replace(/\[\[[^\]]*\]\]/g, " ");
  const lower = plain.toLowerCase();
  for (const name of notes) {
    if (name.length < 4 || !distinctive(name)) continue;
    const i = lower.indexOf(name.toLowerCase());
    if (i < 0) continue;
    const before = plain[i - 1] ?? " ";
    const after = plain[i + name.length] ?? " ";
    if (/[\p{L}\p{N}_]/u.test(before) || /[\p{L}\p{N}_]/u.test(after)) continue;
    return name;
  }
  return null;
}

/** Tips about the app, for when Kilo is asked for one and nothing is going on. {command} is its shortcut. */
export const GENERAL_TIPS = [
  "{task.cycle} turns a line into a task, then cycles its status: todo → ongoing → done.",
  "{task.archive} moves a task to the _done file, stamped with today's date.",
  "{view.board} shows every task of the folder on a board: drag a card to change its status.",
  "Click a line number to select the whole line: then Shift+Alt+↓ duplicates it, Ctrl+Shift+K deletes it.",
  "Select some text: the status bar tells how many times it appears, {edit.nextOccurrence} goes to the next one.",
  "Write [[the name of a note]] to link it: Ctrl+click opens it, {palette.backlinks} lists the notes linking here.",
  "{file.dailyNote} opens today's note, made from your Daily note template.",
  "{file.newFromTemplate} starts a note from a template: meeting notes, project, or your own.",
  "Paste a screenshot with Ctrl+V: it is saved next to the note and shown under its line.",
  "A private line? Command palette → Encrypt selection: only your password shows it again.",
  "Ctrl+↑ / Ctrl+↓ move the cursor and scroll the text with it, the line stays in place.",
  "{palette.symbol} jumps to a heading or a task of the note.",
  "{palette.files} opens any note of the folder by its name; {palette.commands} runs any command.",
  "Write @2026-12-01 in a task to give it a due date ({task.due} picks one for you).",
  "Right-click a tab for colors and tab groups.",
  "The activity report sums up your completed tasks by project and by month.",
  "Type / at the start of a line: /today, /todo, /h1, /link, /secret, your templates…",
  "{edit.copyRich} copies the note as rich text: paste it into an e-mail or a chat, tasks and colors included.",
  "Right-click a note → Pin to the top: it stays above the explorer and first in {palette.files}.",
  "Command palette → Print or save as PDF: the note alone on the page, ready for a PDF.",
];
