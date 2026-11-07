// Tasks: a line that ends with " - <status>".
//   - call colleague X - todo
//   - call colleague X - ongoing
//   - call colleague X - done [2026-11-02]      ← in work_done.txt
//   - send the report @2026-11-14 - todo        ← due date
// This module is deliberately pure (no DOM) so that it is easy to test.

export interface TaskConfig {
  statuses: Record<string, string>; // lowercase name → color
  cycle: string[];
  done: Set<string>;
  /** Statuses that mean "in progress" (listed first, counted as ongoing). */
  ongoing: Set<string>;
  /** Statuses that mean "blocked" (a separate column of the report). */
  blocked: Set<string>;
  archiveStatus: string;
  archiveDate: boolean;
  regex: RegExp;
}

export interface TaskMatch {
  indent: string;
  bullet: string; // "- " with its space, or ""
  text: string;
  status: string; // as written in the file
  key: string; // lowercase status
  stamp: string; // "[2026-11-02]" or ""
  date: string | null; // YYYY-MM-DD when present in the stamp
  due: string | null; // YYYY-MM-DD of an "@2026-11-14" in the text
  /** Positions within the line. */
  textFrom: number;
  textTo: number;
  statusFrom: number;
  statusTo: number;
  stampFrom: number;
  stampTo: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function makeTaskConfig(opts: {
  statuses: Record<string, string>;
  cycle: string[];
  done: string[];
  ongoing?: string[];
  blocked?: string[];
  archiveStatus: string;
  archiveDate: boolean;
}): TaskConfig {
  const statuses: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.statuses ?? {})) if (k.trim()) statuses[k.trim().toLowerCase()] = v;
  const names = Object.keys(statuses).sort((a, b) => b.length - a.length).map(escapeRe);
  const alternation = names.length ? names.join("|") : "(?!)";
  // indentation, optional bullet, text, " - " separator (or a long dash), status, optional stamp
  const regex = new RegExp(
    `^(\\s*)((?:[-*+•]|\\d{1,3}[.)])\\s+)?(.*?\\S)(\\s+[-–—]\\s+)(${alternation})(\\s+\\[[^\\]\\n]*\\])?\\s*$`,
    "i",
  );
  const cycle = (opts.cycle ?? []).map((s) => s.toLowerCase()).filter((s) => s in statuses);
  return {
    statuses,
    cycle: cycle.length ? cycle : Object.keys(statuses).slice(0, 3),
    done: new Set((opts.done ?? []).map((s) => s.toLowerCase())),
    ongoing: new Set((opts.ongoing ?? ["ongoing"]).map((s) => s.toLowerCase())),
    blocked: new Set((opts.blocked ?? ["blocked"]).map((s) => s.toLowerCase())),
    archiveStatus: opts.archiveStatus || "done",
    archiveDate: opts.archiveDate,
    regex,
  };
}

export function parseTask(line: string, cfg: TaskConfig): TaskMatch | null {
  const m = cfg.regex.exec(line);
  if (!m) return null;
  const [, indent, bullet = "", text, sep, status, stamp = ""] = m;
  const textFrom = indent.length + bullet.length;
  const textTo = textFrom + text.length;
  const statusFrom = textTo + sep.length;
  const statusTo = statusFrom + status.length;
  const stampFrom = statusTo;
  const stampTo = stampFrom + stamp.length;
  const date = /\[(\d{4}-\d{2}-\d{2})/.exec(stamp)?.[1] ?? null;
  return {
    indent, bullet, text, status, key: status.toLowerCase(), stamp: stamp.trim(), date, due: findDue(text),
    textFrom, textTo, statusFrom, statusTo, stampFrom, stampTo,
  };
}

export const isDoneStatus = (key: string, cfg: TaskConfig) => cfg.done.has(key.toLowerCase());
export const isOngoingStatus = (key: string, cfg: TaskConfig) => cfg.ongoing.has(key.toLowerCase());
export const isBlockedStatus = (key: string, cfg: TaskConfig) => cfg.blocked.has(key.toLowerCase());

// ---------------------------------------------------------------------------
// Due dates: "@2026-11-14" anywhere in the task text.

export const DUE_RE = /(^|\s)@(\d{4}-\d{2}-\d{2})(?=$|[\s,.;:!?)])/;

export function findDue(text: string): string | null {
  return DUE_RE.exec(text)?.[2] ?? null;
}

export type DueState = "overdue" | "today" | "soon" | "later";

/** How urgent a due date is (soon: within 3 days). */
export function dueState(due: string, today = todayISO()): DueState {
  if (due < today) return "overdue";
  if (due === today) return "today";
  const soon = new Date(today + "T12:00:00");
  soon.setDate(soon.getDate() + 3);
  return due <= todayISO(soon) ? "soon" : "later";
}

/** Sets (or with null removes) the due date of a task line. */
export function setDueInLine(line: string, cfg: TaskConfig, due: string | null): LineEdit | null {
  const task = parseTask(line, cfg);
  if (!task) return null;
  const m = DUE_RE.exec(task.text);
  if (m) {
    const from = task.textFrom + m.index + m[1].length;
    const to = from + 1 + m[2].length;
    if (due) return { changes: [{ from: from + 1, to, insert: due }] };
    // Remove the token and the space before it (or after it, at the start of the text).
    const before = from > task.textFrom && /\s/.test(line[from - 1]);
    return { changes: [{ from: before ? from - 1 : from, to: before ? to : Math.min(to + 1, task.textTo), insert: "" }] };
  }
  if (!due) return null;
  return { changes: [{ from: task.textTo, to: task.textTo, insert: ` @${due}` }] };
}

/** Reads a date typed by the user: 2026-11-14, 14/11/2026, 14/11, +3 (days), 2w (weeks). */
export function parseDateInput(input: string, today = new Date()): string | null {
  const q = input.trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q);
  const make = (y: number, mo: number, d: number) => {
    const date = new Date(y, mo - 1, d);
    return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? todayISO(date) : null;
  };
  if (m) return make(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(q))) {
    const y = m[3] ? +m[3] : today.getFullYear();
    const d = make(y, +m[2], +m[1]);
    // "14/01" in December means next January.
    if (d && !m[3] && d < todayISO(today)) return make(y + 1, +m[2], +m[1]);
    return d;
  }
  if ((m = /^\+?(\d{1,3})\s*(d|days?|w|weeks?)?$/.exec(q))) {
    const date = new Date(today);
    date.setDate(date.getDate() + +m[1] * (m[2]?.startsWith("w") ? 7 : 1));
    return todayISO(date);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tags: "#client" anywhere in a line.

export const TAG_RE = /(^|[\s(])(#[\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;

/** Tags of a text, lowercase, without duplicates. */
export function findTags(text: string): string[] {
  if (!text.includes("#")) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) out.add(m[2].toLowerCase());
  return [...out];
}

export const hasTag = (text: string, tag: string) => findTags(text).includes(tag.toLowerCase());

export function nextStatus(current: string | null, cfg: TaskConfig): string {
  if (current == null) return cfg.cycle[0];
  const i = cfg.cycle.indexOf(current.toLowerCase());
  return i < 0 ? cfg.cycle[0] : cfg.cycle[(i + 1) % cfg.cycle.length];
}

export interface LineChange {
  from: number;
  to: number;
  insert: string;
}

export interface LineEdit {
  /** Changes relative to the start of the line (sorted, non-overlapping). */
  changes: LineChange[];
  /** Suggested cursor position within the line (after the change). */
  cursor?: number;
}

const BULLET_RE = /^(\s*)((?:[-*+•]|\d{1,3}[.)])\s+)?/;

/**
 * Computes the change made when cycling the status (Ctrl+Enter).
 * Changes are minimal so that the cursor stays in place.
 * - empty line → "- | - todo" (cursor in the middle, ready to type)
 * - line without status → append " - todo" (and a bullet if needed)
 * - task → next status of the cycle (or `target` when given)
 */
export function cycleLine(line: string, cfg: TaskConfig, target?: string): LineEdit | null {
  const task = parseTask(line, cfg);
  if (task) {
    const next = target ?? nextStatus(task.key, cfg);
    if (next.toLowerCase() === task.key && target) return null;
    return { changes: [{ from: task.statusFrom, to: task.statusTo, insert: next }] };
  }
  const status = target ?? cfg.cycle[0];
  if (!line.trim()) {
    return { changes: [{ from: 0, to: line.length, insert: `${line}-  - ${status}` }], cursor: line.length + 2 };
  }
  if (/^\s*#/.test(line)) return null; // heading: leave it alone
  const m = BULLET_RE.exec(line)!;
  const indent = m[1];
  const bodyEnd = line.replace(/\s+$/, "").length;
  const changes: LineChange[] = [];
  if (!m[2]) changes.push({ from: indent.length, to: indent.length, insert: "- " });
  if (bodyEnd <= m[0].length) {
    // bullet only ("- "): make room for the text
    const at = m[0].length;
    changes.push({ from: at, to: line.length, insert: ` - ${status}` });
    return { changes, cursor: at };
  }
  changes.push({ from: bodyEnd, to: line.length, insert: ` - ${status}` });
  return { changes };
}

export function applyLineEdit(line: string, edit: LineEdit): string {
  let out = "";
  let pos = 0;
  for (const c of edit.changes) {
    out += line.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + line.slice(pos);
}

export function todayISO(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The line as it will be written to the archive file. */
export function archivedLine(line: string, cfg: TaskConfig, date = todayISO()): string {
  const task = parseTask(line, cfg);
  if (!task) {
    const body = line.trim();
    const withBullet = /^([-*+•]|\d{1,3}[.)])\s/.test(body) ? body : `- ${body}`;
    return `${withBullet} - ${cfg.archiveStatus}${cfg.archiveDate ? ` [${date}]` : ""}`;
  }
  const status = isDoneStatus(task.key, cfg) ? task.status : cfg.archiveStatus;
  const bullet = task.bullet || "- ";
  const stamp = task.stamp || (cfg.archiveDate ? `[${date}]` : "");
  return `${bullet}${task.text} - ${status}${stamp ? " " + stamp : ""}`;
}

export interface FoundTask {
  line: number; // 1-based
  task: TaskMatch;
  raw: string;
}

export function findTasks(text: string, cfg: TaskConfig): FoundTask[] {
  const out: FoundTask[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Quick filter before the regex: a dash followed by a space is required.
    if (raw.length < 5 || !/[-–—]\s/.test(raw)) continue;
    const task = parseTask(raw, cfg);
    if (task) out.push({ line: i + 1, task, raw });
  }
  return out;
}

/** Finds a date (YYYY-MM-DD or DD/MM/YYYY) anywhere in a line. */
export function findDateInLine(line: string): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(line);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const fr = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(line);
  if (fr) return `${fr[3]}-${fr[2].padStart(2, "0")}-${fr[1].padStart(2, "0")}`;
  return null;
}
