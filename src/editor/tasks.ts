// Tasks: a line that ends with " - <status>".
//   - call colleague X - todo
//   - call colleague X - ongoing
//   - call colleague X - done [2026-11-02]      ← in work_done.txt
// This module is deliberately pure (no DOM) so that it is easy to test.

export interface TaskConfig {
  statuses: Record<string, string>; // lowercase name → color
  cycle: string[];
  done: Set<string>;
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
    indent, bullet, text, status, key: status.toLowerCase(), stamp: stamp.trim(), date,
    textFrom, textTo, statusFrom, statusTo, stampFrom, stampTo,
  };
}

export const isDoneStatus = (key: string, cfg: TaskConfig) => cfg.done.has(key.toLowerCase());

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
